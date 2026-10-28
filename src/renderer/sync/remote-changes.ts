import { create } from 'zustand'

/** "Entity changed remotely" events and the non-blocking notices built from them. Pure apart from the notice store. */

export interface RemoteChange { kind: string; guid: string; parentGuid: string | null; data?: any; deleted: boolean }

export interface Notice {
  /** Notices with the same key replace each other. */
  key: string
  text: string
  conflict: boolean
  ts: number
}

interface NoticeState {
  notices: Notice[]
  push: (n: Omit<Notice, 'ts'>) => void
  dismiss: (key: string) => void
  clear: () => void
}

export const useNoticeStore = create<NoticeState>((set) => ({
  notices: [],
  push: (n) => set((s) => ({ notices: [...s.notices.filter((x) => x.key !== n.key), { ...n, ts: Date.now() }].slice(-5) })),
  dismiss: (key) => set((s) => ({ notices: s.notices.filter((x) => x.key !== key) })),
  clear: () => set({ notices: [] })
}))

const KIND_LABEL: Record<string, string> = {
  code: 'codes', tag: 'sets', tag_category: 'set categories', memo: 'memos', quote: 'quotes',
  logbook: 'the logbook', saved_query: 'saved queries', saved_analysis: 'saved analyses',
  folder: 'folders', project: 'project settings'
}

/** The source document a change belongs to, or null when it is not tied to one. */
export function sourceOfChange(c: RemoteChange): string | null {
  switch (c.kind) {
    case 'source': case 'source_text': case 'source_data': return c.guid
    case 'selection': return c.parentGuid
    case 'quote': case 'memo': return typeof c.data?.sourceGuid === 'string' ? c.data.sourceGuid : null
    default: return null
  }
}

export interface NoticeContext {
  selfId: string
  /** Author user id for an entity key, if known. */
  authorOf: (kind: string, guid: string) => string | null | undefined
  nameOf: (userId: string | null | undefined) => string
  /** Source guid of the document currently open in the viewer, if any. */
  openSourceGuid: string | null
}

/** One coalesced notice per (author, target) for a batch of applied remote changes. */
export function noticesForRemoteChanges(changes: RemoteChange[], ctx: NoticeContext): Omit<Notice, 'ts'>[] {
  const out = new Map<string, Omit<Notice, 'ts'>>()
  for (const c of changes) {
    const author = ctx.authorOf(c.kind, c.guid) ?? null
    if (author && author === ctx.selfId) continue
    const who = ctx.nameOf(author)
    const src = sourceOfChange(c)
    if (src && src === ctx.openSourceGuid) {
      const key = `open:${src}:${author ?? '?'}`
      out.set(key, { key, text: c.deleted && c.kind === 'source' ? `${who} deleted this document` : `Updated by ${who}`, conflict: false })
    } else if (!src && KIND_LABEL[c.kind]) {
      const key = `kind:${c.kind}:${author ?? '?'}`
      out.set(key, { key, text: `${who} updated ${KIND_LABEL[c.kind]}`, conflict: false })
    }
  }
  return [...out.values()]
}

export interface ConflictLike { kind: string; guid: string; reason: 'field' | 'text' | 'deleted' }

/** Notice shown when a remote change could not be merged with a local edit in progress. */
export function noticeForConflict(c: ConflictLike, who: string): Omit<Notice, 'ts'> {
  const what = c.kind === 'source_text' ? 'the text of this document' : `a ${c.kind.replace('_', ' ')}`
  const text = c.reason === 'deleted'
    ? `${who} deleted ${what} while you were editing it — see the sync badge`
    : `${who} changed ${what} at the same place as you — resolve it in the sync badge`
  return { key: `conflict:${c.kind}:${c.guid}`, text, conflict: true }
}
