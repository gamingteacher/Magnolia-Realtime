import type { SupabaseClient } from '@supabase/supabase-js'
import { SyncEngine, planRetry, type SyncConflict } from './engine'
import { createSupabaseClient, SupabaseBackend } from './supabase-backend'
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

export interface PresenceEntry { userId: string; displayName: string; ts: number }
export interface ActivityEntry { kind: string; guid: string; op: string; author: string | null; created_at: string }

const linkKey = (filePath: string): string => `link:${filePath}`
const engineKey = (projectId: string): string => `engine:${projectId}`
let saveTimer: ReturnType<typeof setTimeout> | undefined

function persist(projectId: string): void {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    if (engine) void window.api.syncSaveState(engineKey(projectId), engine.snapshot())
  }, 500)
}

let client: SupabaseClient | null = null
let engine: SyncEngine | null = null
let stopFns: (() => void)[] = []
let running = false
let dirty = false

async function getClient(): Promise<SupabaseClient> {
  if (client) return client
  const cfg = await window.api.syncGetKeys()
  if (!cfg) throw new Error('Cloud Sync is not configured (Preferences → Cloud Sync)')
  client = createSupabaseClient(cfg.url, cfg.anonKey)
  return client
}

export async function signIn(email?: string): Promise<void> {
  const c = await getClient()
  const { data } = await c.auth.getSession()
  if (data.session) return
  if (email) {
    const { error } = await c.auth.signInWithOtp({ email })
    if (error) throw new Error(error.message)
    throw new Error('Check your email for the sign-in link, then connect again.')
  }
  const { error } = await c.auth.signInAnonymously()
  if (error) throw new Error(error.message)
}

export async function createCloudProject(name: string): Promise<string> {
  const c = await getClient()
  const { data, error } = await c.rpc('create_project', { p_name: name })
  if (error) throw new Error(error.message)
  return data as string
}

export async function createInvite(projectId: string, role: 'editor' | 'viewer'): Promise<string> {
  const { data, error } = await (await getClient()).rpc('create_invite', { p_project: projectId, p_role: role })
  if (error) throw new Error(error.message)
  return data as string
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
export async function joinAndConnect(code: string, displayName?: string): Promise<'synced' | 'review'> {
  const projectId = await joinWithCode(code, displayName)
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

export async function joinWithCode(code: string, displayName?: string): Promise<string> {
  const { data, error } = await (await getClient()).rpc('join_project', { p_code: code, p_display_name: displayName ?? null })
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
        await engine.pull()
        await uploadPendingBinaries()
        engine.localChanged(snapshotEntities())
        await engine.flush()
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
  const { data: member } = await c.from('project_members').select('role').eq('project_id', projectId).maybeSingle()
  const backend = new SupabaseBackend(c, projectId)
  engine = new SyncEngine(backend, { applyRemote: applyRemoteToStores, newId: generateGuid })
  const saved = await window.api.syncLoadState(engineKey(projectId))
  if (saved) engine.restore(saved)
  const filePath = useProjectStore.getState().filePath
  if (filePath) await window.api.syncSaveState(linkKey(filePath), { projectId })
  useSyncStore.getState().set({ status: 'connecting', projectId, role: (member?.role as any) ?? 'viewer', error: null })
  const wake = (): void => { dirty = true; void loop() }
  stopFns = [
    observeLocalChanges(() => {
      if (useSyncStore.getState().role !== 'viewer') return wake()
      engine?.revertLocal(snapshotEntities())
    }),
    backend.subscribe(wake),
    startPresence(c, projectId),
    (() => { const t = setInterval(wake, 60_000); return () => clearInterval(t) })()
  ]
  const online = (): void => wake()
  window.addEventListener('online', online)
  stopFns.push(() => window.removeEventListener('online', online))
  wake()
}

function startPresence(c: SupabaseClient, projectId: string): () => void {
  let userId = ''
  const ch = c.channel(`presence:${projectId}`, { config: { presence: { key: generateGuid() } } })
  ch.on('presence', { event: 'sync' }, () => {
    const list = Object.values(ch.presenceState()).flat() as unknown as PresenceEntry[]
    useSyncStore.getState().set({ presence: list })
  }).subscribe(async (status) => {
    if (status !== 'SUBSCRIBED') return
    userId = (await c.auth.getUser()).data.user?.id ?? ''
    await ch.track({ userId, displayName: useProjectStore.getState().users[0]?.name ?? 'User', ts: Date.now() })
  })
  return () => { void c.removeChannel(ch) }
}

export async function fetchActivity(limit = 100): Promise<ActivityEntry[]> {
  const projectId = useSyncStore.getState().projectId
  if (!projectId) return []
  const { data } = await (await getClient()).from('ops')
    .select('kind,guid,op,author,created_at').eq('project_id', projectId)
    .order('seq', { ascending: false }).limit(limit)
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
      try { await signIn(); await startSync(link.projectId) } catch (e: any) {
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
}
