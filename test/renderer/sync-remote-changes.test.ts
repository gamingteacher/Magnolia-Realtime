import { describe, it, expect } from 'vitest'
import { noticesForRemoteChanges, noticeForConflict, sourceOfChange, useNoticeStore } from '../../src/renderer/sync/remote-changes'
import { SyncEngine, type SyncBackend, type RemoteRow, type PushOp, type SyncConflict } from '../../src/renderer/sync/engine'
import type { SyncEntity } from '../../src/renderer/sync/entity-map'

const ctx = (open: string | null, authors: Record<string, string> = {}) => ({
  selfId: 'me',
  authorOf: (k: string, g: string) => authors[`${k}:${g}`] ?? null,
  nameOf: (id: string | null | undefined) => (id === 'ana' ? 'Ana' : 'Another user'),
  openSourceGuid: open
})
const ch = (kind: string, guid: string, extra = {}) => ({ kind, guid, parentGuid: null, deleted: false, ...extra })

describe('remote change notices', () => {
  it('maps changes to their source document', () => {
    expect(sourceOfChange(ch('source_text', 's1'))).toBe('s1')
    expect(sourceOfChange(ch('selection', 'x', { parentGuid: 's1' }))).toBe('s1')
    expect(sourceOfChange(ch('quote', 'q', { data: { sourceGuid: 's2' } }))).toBe('s2')
    expect(sourceOfChange(ch('code', 'c'))).toBeNull()
  })
  it('notifies for the open document, coalesced, naming the author', () => {
    const n = noticesForRemoteChanges(
      [ch('source_text', 's1'), ch('selection', 'x', { parentGuid: 's1' })], ctx('s1', { 'source_text:s1': 'ana', 'selection:x': 'ana' }))
    expect(n).toHaveLength(1)
    expect(n[0].text).toBe('Updated by Ana')
    expect(n[0].conflict).toBe(false)
  })
  it('ignores own changes and documents that are not open', () => {
    expect(noticesForRemoteChanges([ch('source_text', 's1')], ctx('s1', { 'source_text:s1': 'me' }))).toEqual([])
    expect(noticesForRemoteChanges([ch('source_text', 's9')], ctx('s1', { 'source_text:s9': 'ana' }))).toEqual([])
  })
  it('summarises global entity changes', () => {
    const n = noticesForRemoteChanges([ch('code', 'c1')], ctx(null, { 'code:c1': 'ana' }))
    expect(n[0].text).toBe('Ana updated codes')
  })
  it('notice store replaces by key', () => {
    const s = useNoticeStore.getState()
    s.clear(); s.push({ key: 'k', text: 'a', conflict: false }); s.push({ key: 'k', text: 'b', conflict: false })
    expect(useNoticeStore.getState().notices.map((x) => x.text)).toEqual(['b'])
    s.clear()
  })
})

class Server implements SyncBackend {
  rows = new Map<string, RemoteRow>()
  seq = 0
  async upsert(op: PushOp) {
    const k = `${op.kind}:${op.guid}`
    const cur = this.rows.get(k)
    if ((cur?.version ?? 0) !== op.baseVersion) return { ok: false as const, current: cur ?? null }
    const row: RemoteRow = { kind: op.kind, guid: op.guid, parent_guid: op.parentGuid, data: op.data, version: (cur?.version ?? 0) + 1, deleted: op.deleted, seq: ++this.seq }
    this.rows.set(k, row)
    return { ok: true as const, version: row.version, seq: row.seq }
  }
  async pullSince(seq: number) { return [...this.rows.values()].filter((r) => r.seq > seq) }
}
function client(server: Server) {
  const state = new Map<string, SyncEntity>()
  const conflicts: SyncConflict[] = []
  let n = 0
  const eng = new SyncEngine(server, {
    newId: () => `o${++n}${Math.random()}`,
    applyRemote: (es) => es.forEach((e) => (e.deleted ? state.delete(`${e.kind}:${e.guid}`) : state.set(`${e.kind}:${e.guid}`, e))),
    onConflict: (c) => conflicts.push(c)
  })
  const setText = (t: string) => { state.set('source_text:s1', { kind: 'source_text', guid: 's1', parentGuid: 's1', data: { text: t } }); eng.localChanged([...state.values()]) }
  return { eng, state, conflicts, setText }
}

describe('open text edited by two users', () => {
  it('queues an in-progress local edit before pulling, so a disjoint remote edit is merged, not clobbered', async () => {
    const s = new Server(), a = client(s), b = client(s)
    a.setText('one two three'); await a.eng.flush(); await b.eng.pull()
    a.setText('ONE two three'); await a.eng.flush()
    b.setText('one two THREE') // local edit, not yet flushed
    await b.eng.pull()
    await b.eng.flush()
    expect(b.state.get('source_text:s1')!.data.text).toBe('ONE two THREE')
    expect(s.rows.get('source_text:s1')!.data.text).toBe('ONE two THREE')
    expect(b.conflicts).toEqual([])
  })
  it('reports a conflict (and keeps the remote text) when edits overlap', async () => {
    const s = new Server(), a = client(s), b = client(s)
    a.setText('one two three'); await a.eng.flush(); await b.eng.pull()
    a.setText('one TWO three'); await a.eng.flush()
    b.setText('one 2 three')
    await b.eng.pull(); await b.eng.flush()
    expect(b.conflicts).toHaveLength(1)
    expect(b.conflicts[0].reason).toBe('text')
    expect(b.state.get('source_text:s1')!.data.text).toBe('one TWO three')
    expect(noticeForConflict(b.conflicts[0], 'Ana')).toMatchObject({ conflict: true, key: 'conflict:source_text:s1' })
    expect(noticeForConflict(b.conflicts[0], 'Ana').text).toContain('Ana')
  })
})
