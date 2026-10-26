import { computeTextEdit, adjustRange } from '../utils/text-edit-offsets'
import { entityKey, type SyncEntity } from './entity-map'

const isTextAnchor = (d: any): boolean =>
  typeof d?.startPosition === 'number' && !d.pdfRegion && !d.timeRange && !d.surveyCell

/**
 * When a remote edit changes a document's text, shift local anchors (selections, quotes, content memos)
 * that were not themselves updated in the same batch. Anchors whose text was entirely deleted are removed.
 * Mutates `mirror`; returns the keys it changed or removed.
 */
export function rebaseAnchors(
  mirror: Map<string, SyncEntity>,
  sourceGuid: string,
  oldText: string,
  newText: string,
  skip: Set<string>
): string[] {
  const edit = computeTextEdit(oldText, newText)
  if (!edit) return []
  const touched: string[] = []
  for (const [k, e] of [...mirror]) {
    if (skip.has(k) || !isTextAnchor(e.data)) continue
    const belongs =
      (e.kind === 'selection' && e.parentGuid === sourceGuid) ||
      (e.kind === 'quote' && e.data.sourceGuid === sourceGuid) ||
      (e.kind === 'memo' && e.data.sourceGuid === sourceGuid)
    if (!belongs) continue
    const r = adjustRange(e.data.startPosition, e.data.endPosition ?? e.data.startPosition, edit)
    if (!r) {
      if (e.kind === 'memo') continue
      mirror.delete(k)
      // Codings of a deleted selection vanish via the parent cascade.
    } else if (r.start !== e.data.startPosition || r.end !== e.data.endPosition) {
      mirror.set(k, { ...e, data: { ...e.data, startPosition: r.start, endPosition: r.end } })
    } else continue
    touched.push(k)
  }
  return touched
}

export { entityKey }
