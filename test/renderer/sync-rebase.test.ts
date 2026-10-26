import { describe, it, expect } from 'vitest'
import { rebaseAnchors } from '../../src/renderer/sync/rebase'
import type { SyncEntity } from '../../src/renderer/sync/entity-map'

const sel = (guid: string, s: number, e: number): SyncEntity => ({ kind: 'selection', guid, parentGuid: 'S', data: { guid, startPosition: s, endPosition: e } })
const m = (...es: SyncEntity[]) => new Map(es.map((e) => [`${e.kind}:${e.guid}`, e]))

describe('rebaseAnchors', () => {
  it('shifts anchors after an insertion and leaves earlier ones', () => {
    const mirror = m(sel('a', 0, 5), sel('b', 12, 17))
    rebaseAnchors(mirror, 'S', 'hello big world!!', 'hello very big world!!', new Set())
    expect(mirror.get('selection:a')!.data.startPosition).toBe(0)
    expect(mirror.get('selection:b')!.data).toMatchObject({ startPosition: 17, endPosition: 22 })
  })
  it('removes anchors whose text was deleted and skips batch-updated ones', () => {
    const mirror = m(sel('a', 6, 9), sel('b', 6, 9))
    rebaseAnchors(mirror, 'S', 'hello big world', 'hello world', new Set(['selection:b']))
    expect(mirror.has('selection:a')).toBe(false)
    expect(mirror.get('selection:b')!.data.startPosition).toBe(6)
  })
  it('ignores other documents and region anchors', () => {
    const other = { ...sel('c', 8, 10), parentGuid: 'T' }
    const pdf: SyncEntity = { kind: 'selection', guid: 'p', parentGuid: 'S', data: { startPosition: 8, endPosition: 10, pdfRegion: {} } }
    const mirror = m(other, pdf)
    rebaseAnchors(mirror, 'S', 'abc', 'abcdef', new Set())
    expect(mirror.get('selection:c')!.data.startPosition).toBe(8)
    expect(mirror.get('selection:p')!.data.startPosition).toBe(8)
  })
})
