import { useCodeStore } from '../stores/code-store'
import { useTagStore } from '../stores/tag-store'
import { useMemoStore } from '../stores/memo-store'
import { useQuoteStore } from '../stores/quote-store'
import { useLogbookStore } from '../stores/logbook-store'
import { useQueryStore } from '../stores/query-store'
import { useDocumentStore } from '../stores/document-store'
import { useProjectStore } from '../stores/project-store'
import { useUndoStore } from '../stores/undo-store'
import type { Project } from '../models/types'
import { mediaPathField, isOverlayHandle, ARCHIVE_PREFIX } from '../utils/binary-handles'
import { rebaseAnchors } from './rebase'
import { entitiesToProject, entityKey, projectToEntities, type SyncEntity } from './entity-map'

/** True while remote data is being written into the stores; observers must ignore those changes. */
let applying = false
export const isApplyingRemote = (): boolean => applying

export interface BinaryRef { sha256: string; ext: string; size: number }
/** sourceGuid → uploaded binary, as known from the server. */
export const binaryRefs = new Map<string, BinaryRef>()
/** Called with the binary entities that arrived remotely; set by session.ts. */
let onBinaryChange: ((sourceGuid: string, ref: BinaryRef) => void) | null = null
export const setBinaryListener = (fn: typeof onBinaryChange): void => { onBinaryChange = fn }

const isHandle = (v: unknown): v is string =>
  typeof v === 'string' && (v.startsWith(ARCHIVE_PREFIX) || isOverlayHandle(v))

/** Media sources whose bytes have a local handle but are not in binaryRefs yet. */
export function sourcesNeedingUpload(): { guid: string; handle: string; ext: string }[] {
  const out: { guid: string; handle: string; ext: string }[] = []
  for (const s of useDocumentStore.getState().sources) {
    const f = mediaPathField(s.sourceType)
    const h = f ? s.formatData?.[f] : null
    if (f && isHandle(h) && !binaryRefs.has(s.guid)) out.push({ guid: s.guid, handle: h, ext: h.slice(h.lastIndexOf('.') + 1) })
  }
  return out
}

/** formatData minus the machine-local media handle (it is meaningless on other machines). */
function stripHandle(s: any): any {
  const f = mediaPathField(s.sourceType)
  if (!f || !s.formatData || !(f in s.formatData)) return s
  const { [f]: _drop, ...rest } = s.formatData
  return { ...s, formatData: rest }
}

export function snapshotProject(): Partial<Project> {
  const ds = useDocumentStore.getState()
  const ps = useProjectStore.getState()
  return {
    name: ps.name,
    description: ps.description,
    users: ps.users,
    codes: useCodeStore.getState().codes,
    sources: ds.sources.map((s) => stripHandle({
      ...s,
      plainTextContent: ds.sourceContents[s.guid] ?? s.plainTextContent
    })),
    sourceFolder: ds.sourceFolder,
    folders: ds.folders,
    tagCategories: useTagStore.getState().categories,
    sets: useTagStore.getState().tags,
    memos: useMemoStore.getState().memos,
    quotes: useQuoteStore.getState().quotes,
    logbookEntries: useLogbookStore.getState().entries,
    savedQueries: useQueryStore.getState().savedQueries,
    savedAnalyses: ps.savedAnalyses
  }
}

export const snapshotEntities = (): SyncEntity[] => [
  ...projectToEntities(snapshotProject()),
  ...[...binaryRefs].map(([guid, ref]): SyncEntity => ({ kind: 'binary', guid, parentGuid: guid, data: ref }))
]

/** Merge remote changes over the current local state and write the result into the stores. */
export function applyRemoteToStores(changes: (SyncEntity & { deleted: boolean })[]): void {
  if (!changes.length) return
  const mirror = new Map(snapshotEntities().map((e) => [entityKey(e), e]))
  const structuralDelete = changes.some((c) => c.deleted && ['code', 'source', 'selection'].includes(c.kind))
  for (const c of changes) {
    if (c.deleted) mirror.delete(entityKey(c))
    else mirror.set(entityKey(c), { kind: c.kind, guid: c.guid, parentGuid: c.parentGuid, data: c.data })
  }
  const batch = new Set(changes.map(entityKey))
  const oldTexts = useDocumentStore.getState().sourceContents
  for (const c of changes) {
    if (c.kind !== 'source_text' || c.deleted || typeof c.data?.text !== 'string') continue
    const before = oldTexts[c.guid]
    if (before !== undefined) rebaseAnchors(mirror, c.guid, before, c.data.text, batch)
  }
  // Cascade: children of removed parents go too.
  const live = new Set(mirror.keys())
  for (const [k, e] of [...mirror]) {
    const parentKinds = { selection: 'source', coding: 'selection', source_text: 'source', source_data: 'source' } as const
    const pk = parentKinds[e.kind as keyof typeof parentKinds]
    if (pk && e.parentGuid && !live.has(`${pk}:${e.parentGuid}`)) mirror.delete(k)
  }
  const p = entitiesToProject([...mirror.values()])
  // Keep this machine's media handles; remote data never carries them.
  const localSources = new Map(useDocumentStore.getState().sources.map((s) => [s.guid, s]))
  for (const s of p.sources ?? []) {
    const f = mediaPathField(s.sourceType)
    const local = localSources.get(s.guid)
    if (f && local?.formatData?.[f]) s.formatData = { ...(s.formatData ?? {}), [f]: local.formatData[f] }
  }
  for (const c of changes) {
    if (c.kind !== 'binary') continue
    if (c.deleted) binaryRefs.delete(c.guid)
    else {
      binaryRefs.set(c.guid, c.data)
      if (!localSources.get(c.guid)?.formatData?.[mediaPathField(localSources.get(c.guid)?.sourceType) ?? '']) {
        onBinaryChange?.(c.guid, c.data)
      }
    }
  }
  const kinds = new Set<string>(changes.map((c) => c.kind))
  if (kinds.has('source_text')) ['selection', 'coding', 'quote', 'memo'].forEach((k) => kinds.add(k))
  const touched = (...ks: string[]): boolean => ks.some((k) => kinds.has(k as any))

  applying = true
  try {
    if (touched('code')) useCodeStore.getState().setCodes(p.codes ?? [])
    if (touched('source', 'source_text', 'source_data', 'selection', 'coding')) {
      const contents: Record<string, string> = {}
      for (const s of p.sources ?? []) if (s.plainTextContent !== undefined) contents[s.guid] = s.plainTextContent
      useDocumentStore.getState().setSources(p.sources ?? [], contents)
    }
    if (touched('source', 'folder')) useDocumentStore.getState().setFolders(p.folders ?? [], p.sourceFolder ?? {})
    if (touched('tag')) useTagStore.getState().setTags(p.sets ?? [])
    if (touched('tag_category')) useTagStore.getState().setCategories(p.tagCategories ?? [])
    if (touched('memo')) useMemoStore.getState().setMemos(p.memos ?? [])
    if (touched('quote')) useQuoteStore.getState().setQuotes(p.quotes ?? [])
    if (touched('logbook')) useLogbookStore.getState().setEntries(p.logbookEntries ?? [])
    if (touched('saved_query')) useQueryStore.getState().setSavedQueries(p.savedQueries ?? [])
    if (touched('saved_analysis')) useProjectStore.getState().setSavedAnalyses(p.savedAnalyses ?? [])
    if (touched('project') && p.name !== undefined) useProjectStore.getState().setName(p.name)
    if (structuralDelete) useUndoStore.getState().clearHistory()
  } finally {
    applying = false
  }
}

/** Run `onChange` (debounced) whenever synced store state changes locally. */
export function observeLocalChanges(onChange: () => void, delayMs = 300): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const fire = (): void => {
    if (applying) return
    clearTimeout(timer)
    timer = setTimeout(onChange, delayMs)
  }
  const unsubs = [
    useCodeStore.subscribe(fire), useDocumentStore.subscribe(fire), useTagStore.subscribe(fire),
    useMemoStore.subscribe(fire), useQuoteStore.subscribe(fire), useLogbookStore.subscribe(fire),
    useQueryStore.subscribe(fire), useProjectStore.subscribe(fire)
  ]
  return () => { clearTimeout(timer); unsubs.forEach((u) => u()) }
}
