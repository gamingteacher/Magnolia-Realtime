import type { SupabaseClient } from '@supabase/supabase-js'
import { getAuthClient, currentUser } from './auth'
import { SyncEngine, planRetry, type SyncConflict, type SyncBackend } from './engine'
import { SupabaseBackend } from './supabase-backend'
import { applyRemoteToStores, observeLocalChanges, snapshotEntities, sourcesNeedingUpload, binaryRefs, setBinaryListener, type BinaryRef } from './store-bridge'
import { useDocumentStore } from '../stores/document-store'
import { mediaPathField } from '../utils/binary-handles'
import { useSyncStore } from './sync-store'
import { generateGuid } from '../utils/guid'
import { useProjectStore } from '../stores/project-store'
import { useMergeReviewStore } from '../stores/merge-review-store'
import { MERGE_TAB_ID } from '../utils/tab-ids'
import { useCodeStore } from '../stores/code-store'
import { entitiesToProject, type SyncEntity } from './entity-map'
import { startAwareness, applyKeepingCaret } from './awareness'
import type { AwarenessState } from './awareness-core'
import { noticesForRemoteChanges, noticeForConflict, useNoticeStore } from './remote-changes'

export interface PresenceEntry extends Partial<AwarenessState> { userId: string; displayName: string; ts: number }
export interface ActivityEntry { kind: string; guid: string; op: string; author: string | null; author_name: string | null; created_at: string }
export interface InviteEntry {
  code: string
  role: 'editor' | 'viewer'
  created_at: string
  expires_at: string
  uses: number
  revoked: boolean
  max_uses: number | null
}
export interface MemberEntry { user_id: string; username: string; display_name: string; role: 'owner' | 'editor' | 'viewer' }
export interface CloudProjectEntry { id: string; name: string; role: 'owner' | 'editor' | 'viewer' }

const linkKey = (filePath: string): string => `link:${filePath}`
const engineKey = (projectId: string): string => `engine:${projectId}`
let saveTimer: ReturnType<typeof setTimeout> | undefined

function persist(projectId: string): void {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    if (engine) void window.api.syncSaveState(engineKey(projectId), engine.snapshot())
  }, 500)
}

let engine: SyncEngine | null = null
let stopFns: (() => void)[] = []
let running = false
let dirty = false

async function getClient(): Promise<SupabaseClient> {
  return getAuthClient()
}

export async function createCloudProject(name: string): Promise<string> {
  const c = await getClient()
  const { data, error } = await c.rpc('create_project', { p_name: name })
  if (error) throw new Error(error.message)
  return data as string
}

export async function createInvite(
  projectId: string, role: 'editor' | 'viewer', expiresAt: string, maxUses: number | null = null
): Promise<string> {
  const { data, error } = await (await getClient()).rpc('create_invite', {
    p_project: projectId, p_role: role, p_expires_at: expiresAt, p_max_uses: maxUses
  })
  if (error) throw new Error(error.message)
  return data as string
}

export async function listInvites(projectId: string): Promise<InviteEntry[]> {
  const { data, error } = await (await getClient()).rpc('list_invites', { p_project: projectId })
  if (error) throw new Error(error.message)
  return (data ?? []) as InviteEntry[]
}

export async function revokeInvite(code: string): Promise<void> {
  const { error } = await (await getClient()).rpc('revoke_invite', { p_code: code })
  if (error) throw new Error(error.message)
}

export async function listMembers(projectId: string): Promise<MemberEntry[]> {
  const { data, error } = await (await getClient()).rpc('list_members', { p_project: projectId })
  if (error) throw new Error(error.message)
  return (data ?? []) as MemberEntry[]
}

export async function setMemberRole(projectId: string, userId: string, role: 'editor' | 'viewer'): Promise<void> {
  const { error } = await (await getClient()).rpc('set_member_role', {
    p_project: projectId, p_user: userId, p_role: role
  })
  if (error) throw new Error(error.message)
}

export async function removeMember(projectId: string, userId: string): Promise<void> {
  const { error } = await (await getClient()).rpc('remove_member', { p_project: projectId, p_user: userId })
  if (error) throw new Error(error.message)
}

export async function listMyProjects(): Promise<CloudProjectEntry[]> {
  const { data, error } = await (await getClient()).rpc('list_my_projects')
  if (error) throw new Error(error.message)
  return (data ?? []) as CloudProjectEntry[]
}

async function fetchRemoteEntities(projectId: string): Promise<SyncEntity[]> {
  const backend = new SupabaseBackend(await getClient(), projectId)
  const latest = new Map<string, SyncEntity>()
  let seq = 0
  for (;;) {
    const rows = await backend.pullSince(seq, 500)
    if (!rows.length) break
    for (const r of rows) {
      seq = Math.max(seq, r.seq)
      const k = `${r.kind}:${r.guid}`
      if (r.deleted) latest.delete(k)
      else latest.set(k, { kind: r.kind, guid: r.guid, parentGuid: r.parent_guid, data: r.data })
    }
  }
  return [...latest.values()]
}

const localProjectIsEmpty = (): boolean =>
  useDocumentStore.getState().sources.length === 0 && useCodeStore.getState().codes.length === 0

/**
 * Join a cloud project. An empty local project simply adopts the cloud data; otherwise the existing
 * merge-review screen lets the user choose what to keep, and syncing starts when that review closes.
 */
export async function joinAndConnect(code: string): Promise<'synced' | 'review'> {
  const projectId = await joinWithCode(code)
  return connectExistingAndConnect(projectId)
}

export async function connectExistingAndConnect(projectId: string): Promise<'synced' | 'review'> {
  if (localProjectIsEmpty()) {
    await startSync(projectId)
    return 'synced'
  }
  const p = entitiesToProject(await fetchRemoteEntities(projectId))
  const contents: Record<string, string> = {}
  for (const s of p.sources ?? []) if (s.plainTextContent !== undefined) contents[s.guid] = s.plainTextContent
  const mergeStore = useMergeReviewStore
  mergeStore.getState().openCompareProject(p as any, contents, 'Cloud project')
  useDocumentStore.getState().openToolTab(MERGE_TAB_ID)
  const unsub = mergeStore.subscribe((st) => {
    if (st.diff !== null) return
    unsub()
    void startSync(projectId)
  })
  return 'review'
}

export async function joinWithCode(code: string): Promise<string> {
  const { data, error } = await (await getClient()).rpc('join_project', { p_code: code })
  if (error) throw new Error(error.message)
  return data as string
}

async function accessToken(): Promise<string> {
  const { data } = await (await getClient()).auth.getSession()
  if (!data.session) throw new Error('Not signed in')
  return data.session.access_token
}

async function uploadPendingBinaries(): Promise<void> {
  const projectId = useSyncStore.getState().projectId
  if (!projectId || useSyncStore.getState().role === 'viewer') return
  for (const b of sourcesNeedingUpload()) {
    const r = await window.api.syncUploadBinary(await accessToken(), projectId, b.handle, b.ext)
    if (!r.ok) { useSyncStore.getState().set({ error: `Media upload: ${r.error}` }); continue }
    binaryRefs.set(b.guid, { sha256: r.sha256!, ext: b.ext, size: r.size! })
  }
}

const downloading = new Set<string>()
async function downloadBinary(sourceGuid: string, ref: BinaryRef): Promise<void> {
  const projectId = useSyncStore.getState().projectId
  if (!projectId || downloading.has(sourceGuid)) return
  downloading.add(sourceGuid)
  try {
    const r = await window.api.syncDownloadBinary(await accessToken(), projectId, ref.sha256, ref.ext)
    if (!r.ok || !r.handle) { useSyncStore.getState().set({ error: `Media download: ${r.error}` }); return }
    const ds = useDocumentStore.getState()
    const src = ds.sources.find((s) => s.guid === sourceGuid)
    const f = mediaPathField(src?.sourceType)
    if (!src || !f) return
    const updated = ds.sources.map((s) => (s.guid === sourceGuid ? { ...s, formatData: { ...s.formatData, [f]: r.handle } } : s))
    // Local-only change (not a user edit), so observers must not echo it.
    useDocumentStore.getState().setSources(updated, ds.sourceContents)
  } finally {
    downloading.delete(sourceGuid)
  }
}
setBinaryListener((g, ref) => { void downloadBinary(g, ref) })

async function loop(): Promise<void> {
  if (running || !engine) return
  running = true
  const st = useSyncStore.getState()
  let attempt = 0
  try {
    do {
      dirty = false
      if (useSyncStore.getState().paused) break
      try {
        st.set({ status: 'syncing' })
        // Queue in-progress local edits first so a pull merges them instead of overwriting them.
        if (useSyncStore.getState().role !== 'viewer') engine.localChanged(snapshotEntities())
        await engine.pull()
        if (useSyncStore.getState().role === 'viewer') {
          engine.revertLocal(snapshotEntities())
        } else {
          await uploadPendingBinaries()
          engine.localChanged(snapshotEntities())
          await engine.flush()
        }
        attempt = 0
        persist(useSyncStore.getState().projectId!)
        st.set({ status: 'synced', pending: engine.pending, lastSyncAt: new Date().toISOString(), error: null, conflicts: [...engine.conflicts] })
      } catch (e: any) {
        persist(useSyncStore.getState().projectId!)
        st.set({ status: navigator.onLine ? 'error' : 'offline', error: e?.message ?? String(e), pending: engine.pending })
        await new Promise((r) => setTimeout(r, planRetry(attempt++)))
        dirty = true
      }
    } while (dirty && engine)
  } finally {
    running = false
  }
}

/** Start syncing the open project with a cloud project (the caller is already signed in and a member). */
export async function startSync(projectId: string): Promise<void> {
  await stopSync()
  const c = await getClient()
  const account = await currentUser()
  if (!account) throw new Error('Sign in before connecting to a cloud project.')
  const { data: member, error: memberError } = await c.from('project_members').select('role').eq('project_id', projectId).eq('user_id', account.userId).maybeSingle()
  if (memberError) throw new Error(memberError.message)
  if (!member) throw new Error('Your account is not a member of this cloud project.')
  const ps = useProjectStore.getState()
  const users = ps.users.filter((u) => u.guid !== account.userId)
  users.push({ guid: account.userId, name: account.displayName })
  useProjectStore.setState({
    users,
    creatingUserGUID: account.userId,
    modifyingUserGUID: account.userId
  })
  const backend = new SupabaseBackend(c, projectId)
  const authors = new Map<string, string | null>()
  const tracked: SyncBackend = {
    upsert: (op) => backend.upsert(op),
    pullSince: async (seq, limit) => {
      const rows = await backend.pullSince(seq, limit)
      for (const r of rows) authors.set(`${r.kind}:${r.guid}`, r.updated_by ?? null)
      return rows
    }
  }
  const authorOf = (kind: string, guid: string): string | null => authors.get(`${kind}:${guid}`) ?? null
  const nameOf = (id: string | null | undefined): string =>
    (id && (useSyncStore.getState().presence.find((p) => p.userId === id)?.displayName ??
      useProjectStore.getState().users.find((u) => u.guid === id)?.name)) || 'Another user'
  const applyRemote = (changes: Parameters<typeof applyRemoteToStores>[0]): void => {
    applyKeepingCaret(changes, authorOf, () => applyRemoteToStores(changes))
    const open = useDocumentStore.getState().viewedDocumentGuid
    for (const n of noticesForRemoteChanges(changes, { selfId: account.userId, authorOf, nameOf, openSourceGuid: open })) {
      useNoticeStore.getState().push(n)
    }
  }
  engine = new SyncEngine(tracked, {
    applyRemote,
    newId: generateGuid,
    onConflict: (cf) => useNoticeStore.getState().push(noticeForConflict(cf, nameOf(authorOf(cf.kind, cf.guid))))
  })
  const filePath = useProjectStore.getState().filePath
  // Saved sync state belongs to one local file; reusing it for another (e.g. a fresh empty
  // project) would make every cloud item look locally deleted and wipe the cloud project.
  const link = filePath ? await window.api.syncLoadState(linkKey(filePath)) : null
  const saved = link?.projectId === projectId && snapshotEntities().length > 0 ? await window.api.syncLoadState(engineKey(projectId)) : null
  if (saved) engine.restore(saved)
  if (filePath) await window.api.syncSaveState(linkKey(filePath), { projectId })
  const role = member.role
  if (role !== 'owner' && role !== 'editor' && role !== 'viewer') {
    throw new Error('The project has an unsupported membership role.')
  }
  useSyncStore.getState().set({ status: 'connecting', projectId, role, account, error: null })
  const wake = (): void => { dirty = true; void loop() }
  let checkingMembership = false
  const refreshMembership = async (): Promise<void> => {
    if (checkingMembership) return
    checkingMembership = true
    try {
      const { data: current, error } = await c.from('project_members').select('role')
        .eq('project_id', projectId).eq('user_id', account.userId).maybeSingle()
      if (error) {
        useSyncStore.getState().set({ error: `Could not verify project membership: ${error.message}` })
        return
      }
      if (!current) {
        void stopSync().then(() => useSyncStore.getState().set({
          status: 'error', projectId, role: null, error: 'You no longer have access to this cloud project.'
        }))
        return
      }
      const nextRole = current.role
      if (nextRole !== 'owner' && nextRole !== 'editor' && nextRole !== 'viewer') {
        useSyncStore.getState().set({ status: 'error', error: 'The project has an unsupported membership role.' })
        return
      }
      if (nextRole !== useSyncStore.getState().role) {
        useSyncStore.getState().set({ role: nextRole })
        if (nextRole === 'viewer') engine?.revertLocal(snapshotEntities())
        else wake()
      }
    } finally {
      checkingMembership = false
    }
  }
  const membershipChannel = c.channel(`members:${projectId}:${account.userId}`)
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'project_members', filter: `project_id=eq.${projectId}`
    }, () => { void refreshMembership() })
    .subscribe((status) => { if (status === 'SUBSCRIBED') void refreshMembership() })
  const membershipTimer = setInterval(() => { void refreshMembership() }, 30_000)
  stopFns = [
    observeLocalChanges(() => {
      if (useSyncStore.getState().role !== 'viewer') return wake()
      engine?.revertLocal(snapshotEntities())
    }),
    backend.subscribe(wake),
    () => { clearInterval(membershipTimer); void c.removeChannel(membershipChannel) },
    startPresence(c, projectId),
    (() => { const t = setInterval(wake, 60_000); return () => clearInterval(t) })()
  ]
  const online = (): void => wake()
  window.addEventListener('online', online)
  stopFns.push(() => window.removeEventListener('online', online))
  wake()
}

function startPresence(c: SupabaseClient, projectId: string): () => void {
  return startAwareness(c, projectId)
}

export async function fetchActivity(limit = 100): Promise<ActivityEntry[]> {
  const projectId = useSyncStore.getState().projectId
  if (!projectId) return []
  const { data, error } = await (await getClient()).from('ops_with_author')
    .select('kind,guid,op,author,author_name,created_at').eq('project_id', projectId)
    .order('seq', { ascending: false }).limit(limit)
  if (error) throw new Error(error.message)
  return (data ?? []) as ActivityEntry[]
}

/** When a project file with a saved cloud link is opened, resume syncing automatically. */
export function initSyncAutoconnect(): void {
  let last: string | null = null
  useProjectStore.subscribe((s) => {
    if (s.filePath === last) return
    last = s.filePath
    if (!s.filePath) return
    void (async () => {
      const link = await window.api.syncLoadState(linkKey(s.filePath!))
      if (!link?.projectId || useSyncStore.getState().projectId === link.projectId) return
      try { await startSync(link.projectId) } catch (e: any) {
        useSyncStore.getState().set({ status: 'error', error: e?.message ?? String(e) })
      }
    })()
  })
}

export function resolveConflict(c: SyncConflict, keep: 'mine' | 'theirs'): void {
  if (!engine) return
  if (keep === 'mine' && c.mine && c.reason !== 'deleted') engine.keepMine(c)
  else engine.dismissConflict(c)
  useSyncStore.getState().set({ conflicts: [...engine.conflicts] })
  if (keep === 'mine') { dirty = true; void loop() }
}

export function syncNow(): void { dirty = true; void loop() }

export async function stopSync(): Promise<void> {
  const fp = useProjectStore.getState().filePath
  if (fp && useSyncStore.getState().projectId) await window.api.syncDeleteState(linkKey(fp))
  stopFns.forEach((f) => f())
  stopFns = []
  engine = null
  useSyncStore.getState().set({ status: 'off', projectId: null, role: null, pending: 0, conflicts: [], presence: [] })
  useNoticeStore.getState().clear()
}
