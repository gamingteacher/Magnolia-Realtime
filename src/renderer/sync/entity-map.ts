import type {
  Project, Code, TextSource, PlainTextSelection, Coding, QDASet, TagCategory, Note, Memo, Quote,
  LogbookEntry, SavedQuery, SavedAnalysis, DocumentFolder, User
} from '../models/types'

export type SyncKind =
  | 'project' | 'user' | 'code' | 'source' | 'source_text' | 'source_data' | 'selection'
  | 'coding' | 'folder' | 'tag_category' | 'tag' | 'memo' | 'quote' | 'logbook'
  | 'saved_query' | 'saved_analysis' | 'note' | 'binary'

export interface SyncEntity {
  kind: SyncKind
  guid: string
  parentGuid: string | null
  data: any
}

export const entityKey = (e: { kind: string; guid: string }): string => `${e.kind}:${e.guid}`

const META_GUID = 'meta'

export function projectToEntities(p: Partial<Project>): SyncEntity[] {
  const out: SyncEntity[] = []
  const add = (kind: SyncKind, guid: string, parentGuid: string | null, data: any): void => {
    out.push({ kind, guid, parentGuid, data })
  }

  add('project', META_GUID, null, { name: p.name, description: p.description })
  for (const u of p.users ?? []) add('user', u.guid, null, u)

  const walk = (codes: Code[], parent: string | null): void => {
    codes.forEach((c, sort) => {
      const { children, ...rest } = c
      add('code', c.guid, parent, { ...rest, sort })
      walk(children ?? [], c.guid)
    })
  }
  walk(p.codes ?? [], null)

  for (const s of p.sources ?? []) {
    const { selections, plainTextContent, formatData, ...meta } = s
    add('source', s.guid, null, { ...meta, folderGuid: p.sourceFolder?.[s.guid] ?? null })
    if (plainTextContent !== undefined) add('source_text', s.guid, s.guid, { text: plainTextContent })
    if (formatData !== undefined) add('source_data', s.guid, s.guid, { formatData })
    for (const sel of selections ?? []) {
      const { codings, ...selMeta } = sel
      add('selection', sel.guid, s.guid, selMeta)
      for (const c of codings ?? []) add('coding', c.guid, sel.guid, c)
    }
  }

  for (const f of p.folders ?? []) add('folder', f.guid, f.parentGuid, f)
  for (const c of p.tagCategories ?? []) add('tag_category', c.guid, null, c)
  for (const t of p.sets ?? []) add('tag', t.guid, t.categoryGuid ?? null, t)
  for (const m of p.memos ?? []) add('memo', m.guid, null, m)
  for (const q of p.quotes ?? []) add('quote', q.guid, q.sourceGuid, q)
  for (const l of p.logbookEntries ?? []) add('logbook', l.guid, null, l)
  for (const q of p.savedQueries ?? []) add('saved_query', q.guid, null, q)
  for (const a of p.savedAnalyses ?? []) add('saved_analysis', a.guid, null, a)
  for (const n of p.notes ?? []) add('note', n.guid, null, n)
  return out
}

export function entitiesToProject(entities: SyncEntity[]): Partial<Project> {
  const by = (k: SyncKind): SyncEntity[] => entities.filter((e) => e.kind === k)
  const meta = by('project')[0]?.data ?? {}

  const codeEnts = by('code')
  const nodes = new Map<string, Code & { _sort: number }>()
  for (const e of codeEnts) {
    const { sort, ...rest } = e.data
    nodes.set(e.guid, { ...rest, children: [], _sort: sort ?? 0 })
  }
  const roots: (Code & { _sort: number })[] = []
  for (const e of codeEnts) {
    const node = nodes.get(e.guid)!
    const parent = e.parentGuid ? nodes.get(e.parentGuid) : undefined
    // Orphans (parent deleted/not yet arrived) surface at the root rather than vanish.
    ;(parent ? parent.children : roots).push(node as any)
  }
  const finish = (list: any[]): Code[] =>
    list
      .sort((a, b) => a._sort - b._sort)
      .map(({ _sort, children, ...c }) => ({ ...c, children: finish(children) }))

  const codingsBySel = new Map<string, Coding[]>()
  for (const e of by('coding')) {
    const list = codingsBySel.get(e.parentGuid ?? '') ?? []
    list.push(e.data)
    codingsBySel.set(e.parentGuid ?? '', list)
  }
  const selsBySource = new Map<string, PlainTextSelection[]>()
  for (const e of by('selection')) {
    const list = selsBySource.get(e.parentGuid ?? '') ?? []
    list.push({ ...e.data, codings: codingsBySel.get(e.guid) ?? [] })
    selsBySource.set(e.parentGuid ?? '', list)
  }
  const texts = new Map(by('source_text').map((e) => [e.guid, e.data.text as string]))
  const formats = new Map(by('source_data').map((e) => [e.guid, e.data.formatData]))

  const sourceFolder: Record<string, string> = {}
  const sources: TextSource[] = by('source').map((e) => {
    const { folderGuid, ...rest } = e.data
    if (folderGuid) sourceFolder[e.guid] = folderGuid
    const s: any = { ...rest, selections: selsBySource.get(e.guid) ?? [] }
    if (texts.has(e.guid)) s.plainTextContent = texts.get(e.guid)
    if (formats.has(e.guid)) s.formatData = formats.get(e.guid)
    return s as TextSource
  })

  const data = <T>(k: SyncKind): T[] => by(k).map((e) => e.data as T)
  return {
    name: meta.name,
    description: meta.description,
    users: data<User>('user'),
    codes: finish(roots),
    sources,
    sourceFolder,
    folders: data<DocumentFolder>('folder'),
    tagCategories: data<TagCategory>('tag_category'),
    sets: data<QDASet>('tag'),
    memos: data<Memo>('memo'),
    quotes: data<Quote>('quote'),
    logbookEntries: data<LogbookEntry>('logbook'),
    savedQueries: data<SavedQuery>('saved_query'),
    savedAnalyses: data<SavedAnalysis>('saved_analysis'),
    notes: data<Note>('note')
  }
}

function stable(v: any): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.keys(val).sort().reduce((o: any, k) => ((o[k] = val[k]), o), {})
      : val
  )
}

/** Compare the last-known state with the current one. Unchanged entities are omitted. */
export function diffEntities(
  prev: Map<string, SyncEntity>,
  next: SyncEntity[]
): { upserts: SyncEntity[]; deletes: SyncEntity[] } {
  const upserts: SyncEntity[] = []
  const seen = new Set<string>()
  for (const e of next) {
    const k = entityKey(e)
    seen.add(k)
    const old = prev.get(k)
    if (!old || old.parentGuid !== e.parentGuid || stable(old.data) !== stable(e.data)) upserts.push(e)
  }
  const deletes = [...prev.entries()].filter(([k]) => !seen.has(k)).map(([, e]) => e)
  return { upserts, deletes }
}
