import { describe, it, expect } from 'vitest'
import { SyncEngine, planRetry, type SyncBackend, type RemoteRow, type PushOp } from '../../src/renderer/sync/engine'
import { mergeText } from '../../src/renderer/sync/text-merge'
import { projectToEntities, entitiesToProject, type SyncEntity } from '../../src/renderer/sync/entity-map'

class FakeServer implements SyncBackend {
  rows = new Map<string, RemoteRow>()
  ops = new Set<string>()
  seq = 0
  fail = false
  async upsert(op: PushOp) {
    if (this.fail) throw new Error('offline')
    const k = `${op.kind}:${op.guid}`
    const cur = this.rows.get(k)
    if (this.ops.has(op.opId)) return { ok: true as const, version: cur!.version, seq: cur!.seq }
    if ((cur?.version ?? 0) !== op.baseVersion) return { ok: false as const, current: cur ?? null }
    const row: RemoteRow = {
      kind: op.kind, guid: op.guid, parent_guid: op.parentGuid, data: op.data,
      version: (cur?.version ?? 0) + 1, deleted: op.deleted, seq: ++this.seq
    }
    this.rows.set(k, row)
    this.ops.add(op.opId)
    return { ok: true as const, version: row.version, seq: row.seq }
  }
  async pullSince(seq: number, limit: number) {
    if (this.fail) throw new Error('offline')
    return [...this.rows.values()].filter((r) => r.seq > seq).sort((a, b) => a.seq - b.seq).slice(0, limit)
  }
}

let n = 0
function client(server: FakeServer) {
  const state = new Map<string, SyncEntity>()
  const eng = new SyncEngine(server, {
    newId: () => `op${++n}`,
    applyRemote: (es) => es.forEach((e) => (e.deleted ? state.delete(`${e.kind}:${e.guid}`) : state.set(`${e.kind}:${e.guid}`, e)))
  })
  const set = (e: SyncEntity) => { state.set(`${e.kind}:${e.guid}`, e); eng.localChanged([...state.values()]) }
  const del = (k: string) => { state.delete(k); eng.localChanged([...state.values()]) }
  return { eng, state, set, del }
}

const code = (name: string, extra = {}): SyncEntity => ({ kind: 'code', guid: 'c1', parentGuid: null, data: { guid: 'c1', name, isCodable: true, sort: 0, ...extra } })
const coding = (id: string): SyncEntity => ({ kind: 'coding', guid: id, parentGuid: 'sel', data: { guid: id, codeGuid: 'c1' } })

describe('SyncEngine', () => {
  it('concurrent codings of the same segment both survive', async () => {
    const s = new FakeServer(), a = client(s), b = client(s)
    a.set(coding('k1')); b.set(coding('k2'))
    await a.eng.flush(); await b.eng.flush()
    await a.eng.pull(); await b.eng.pull()
    expect([...a.state.keys()].sort()).toEqual(['coding:k1', 'coding:k2'])
    expect([...b.state.keys()].sort()).toEqual(['coding:k1', 'coding:k2'])
  })

  it('merges edits to different fields and flags same-field conflicts', async () => {
    const s = new FakeServer(), a = client(s), b = client(s)
    a.set(code('X')); await a.eng.flush(); await b.eng.pull()
    a.set(code('A-name')); b.set(code('X', { color: '#f00' }))
    await a.eng.flush(); await b.eng.flush()
    expect(s.rows.get('code:c1')!.data).toMatchObject({ name: 'A-name', color: '#f00' })

    b.eng.conflicts.length = 0
    await b.eng.pull(); await a.eng.pull()
    a.set(code('A2', { color: '#f00' })); b.set(code('B2', { color: '#f00' }))
    await a.eng.flush(); await b.eng.flush()
    expect(b.eng.conflicts).toHaveLength(1)
    expect(b.state.get('code:c1')!.data.name).toBe('A2')
  })

  it('delete vs edit: remote deletion wins and is reported', async () => {
    const s = new FakeServer(), a = client(s), b = client(s)
    a.set(code('X')); await a.eng.flush(); await b.eng.pull()
    a.del('code:c1'); await a.eng.flush()
    b.set(code('edited')); await b.eng.flush()
    expect(b.eng.conflicts[0].reason).toBe('deleted')
    expect(b.state.has('code:c1')).toBe(false)
  })

  it('offline queue replays once and is idempotent', async () => {
    const s = new FakeServer(), a = client(s)
    a.set(code('X')); s.fail = true
    await expect(a.eng.flush()).rejects.toThrow()
    expect(a.eng.pending).toBe(1)
    s.fail = false
    await a.eng.flush(); await a.eng.flush()
    expect(s.rows.get('code:c1')!.version).toBe(1)
    expect(a.eng.pending).toBe(0)
  })

  it('reconnecting client catches up from lastSeq', async () => {
    const s = new FakeServer(), a = client(s), b = client(s)
    a.set(code('X')); await a.eng.flush(); await b.eng.pull()
    const seq = b.eng.lastSeq
    a.set(coding('k9')); await a.eng.flush()
    await b.eng.pull()
    expect(b.eng.lastSeq).toBeGreaterThan(seq)
    expect(b.state.has('coding:k9')).toBe(true)
  })

  it('merges disjoint text edits and rebases an unsent edit during pull', async () => {
    const s = new FakeServer(), a = client(s), b = client(s)
    const t = (text: string): SyncEntity => ({ kind: 'source_text', guid: 's', parentGuid: 's', data: { text } })
    a.set(t('hello big world')); await a.eng.flush(); await b.eng.pull()
    a.set(t('HELLO big world')); await a.eng.flush()
    b.set(t('hello big WORLD'))
    await b.eng.pull(); await b.eng.flush()
    expect(s.rows.get('source_text:s')!.data.text).toBe('HELLO big WORLD')
  })

  it('restores queued ops and position after restart', async () => {
    const s = new FakeServer(), a = client(s)
    a.set(code('X')); s.fail = true
    await expect(a.eng.flush()).rejects.toThrow()
    const saved = JSON.parse(JSON.stringify(a.eng.snapshot()))
    const b = client(s)
    b.eng.restore(saved); s.fail = false
    await b.eng.flush()
    expect(s.rows.get('code:c1')!.data.name).toBe('X')
  })

  it('keepMine re-pushes the local version after a conflict', async () => {
    const s = new FakeServer(), a = client(s), b = client(s)
    a.set(code('X', { color: '#111' })); await a.eng.flush(); await b.eng.pull()
    a.set(code('A', { color: '#111' })); b.set(code('B', { color: '#111' }))
    await a.eng.flush(); await b.eng.flush()
    b.eng.keepMine(b.eng.conflicts[0]); await b.eng.flush()
    expect(s.rows.get('code:c1')!.data.name).toBe('B')
  })

  it('viewer revert restores server state and drops local additions', async () => {
    const s = new FakeServer(), a = client(s), v = client(s)
    a.set(code('X')); await a.eng.flush(); await v.eng.pull()
    v.set(coding('local')); v.set(code('hacked'))
    v.eng.revertLocal([...v.state.values()])
    expect(v.state.get('code:c1')!.data.name).toBe('X')
    expect(v.state.has('coding:local')).toBe(false)
  })

  it('round-trips through entities', () => {
    const p: any = { name: 'n', users: [], codes: [], sources: [], sourceFolder: {}, folders: [], tagCategories: [], sets: [], memos: [], quotes: [], logbookEntries: [], savedQueries: [], savedAnalyses: [], notes: [] }
    expect(entitiesToProject(projectToEntities(p))).toMatchObject({ name: 'n' })
  })
})

describe('mergeText / retry', () => {
  it('merges disjoint, rejects overlapping', () => {
    expect(mergeText('abc def', 'ABC def', 'abc DEF')).toMatchObject({ ok: true, text: 'ABC DEF' })
    expect(mergeText('abc def', 'abX def', 'aYc def').ok).toBe(false)
  })
  it('backs off to a 60s cap', () => {
    expect([0, 1, 2, 10].map(planRetry)).toEqual([1000, 2000, 4000, 60000])
  })
})
