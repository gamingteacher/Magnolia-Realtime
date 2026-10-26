import { describe, it, expect } from 'vitest'
import { projectToEntities, entitiesToProject, diffEntities, entityKey } from '../../src/renderer/sync/entity-map'

const sample: any = {
  name: 'P',
  description: 'd',
  users: [{ guid: 'u1', name: 'A' }],
  codes: [
    { guid: 'c1', name: 'One', isCodable: true, children: [{ guid: 'c2', name: 'Two', isCodable: true, children: [] }] },
    { guid: 'c3', name: 'Three', isCodable: true, children: [] }
  ],
  sources: [
    {
      guid: 's1', name: 'Doc', plainTextContent: 'hello world', formatData: { a: 1 },
      selections: [
        { guid: 'sel1', startPosition: 0, endPosition: 5, codings: [{ guid: 'k1', codeGuid: 'c1' }, { guid: 'k2', codeGuid: 'c2' }] },
        { guid: 'sel2', startPosition: 6, endPosition: 11, codings: [] }
      ]
    }
  ],
  sourceFolder: { s1: 'f1' },
  folders: [{ guid: 'f1', name: 'F', parentGuid: null }],
  tagCategories: [{ guid: 'tc', name: 'T', type: 'text' }],
  sets: [{ guid: 't1', name: 'tag', categoryGuid: 'tc', memberSourceGuids: ['s1'], memberCodeGuids: [] }],
  memos: [{ guid: 'm1', type: 'project', title: 't', content: 'c', createdDateTime: 'x' }],
  quotes: [{ guid: 'q1', sourceGuid: 's1', sourceName: 'Doc', startPosition: 0, endPosition: 5, text: 'hello', createdDateTime: 'x' }],
  logbookEntries: [],
  savedQueries: [],
  savedAnalyses: [{ guid: 'a1', toolType: 'relationship-map', name: 'M', config: { els: [] }, createdDateTime: 'x' }],
  notes: []
}

describe('entity-map', () => {
  it('round-trips a project', () => {
    expect(entitiesToProject(projectToEntities(sample))).toEqual(sample)
  })

  it('stores each coding as its own entity', () => {
    const kinds = projectToEntities(sample).filter((e) => e.kind === 'coding')
    expect(kinds.map((e) => e.parentGuid)).toEqual(['sel1', 'sel1'])
  })

  it('diffs upserts and deletes', () => {
    const prev = new Map(projectToEntities(sample).map((e) => [entityKey(e), e]))
    const next = structuredClone(sample)
    next.codes[1].name = 'Renamed'
    next.sources[0].selections[0].codings.pop()
    const d = diffEntities(prev, projectToEntities(next))
    expect(d.upserts.map(entityKey)).toEqual(['code:c3'])
    expect(d.deletes.map(entityKey)).toEqual(['coding:k2'])
  })
})
