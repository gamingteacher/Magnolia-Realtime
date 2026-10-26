import { computeTextEdit, type TextEdit } from '../utils/text-edit-offsets'

export type TextMergeResult =
  | { ok: true; text: string; theirsEdit: TextEdit | null }
  | { ok: false }

/**
 * Three-way merge of two single-contiguous edits made against the same base.
 * Disjoint edits are combined; overlapping or same-point edits are a conflict.
 * `theirsEdit` is the remote edit in base coordinates, for rebasing selections
 * created locally (use adjustRange); local selections are already in "mine" coordinates.
 */
export function mergeText(base: string, mine: string, theirs: string): TextMergeResult {
  if (mine === theirs) return { ok: true, text: mine, theirsEdit: null }
  const em = computeTextEdit(base, mine)
  const et = computeTextEdit(base, theirs)
  if (!em) return { ok: true, text: theirs, theirsEdit: et }
  if (!et) return { ok: true, text: mine, theirsEdit: null }

  const overlap = em.start < et.oldEnd && et.start < em.oldEnd
  const samePoint = em.start === et.start || em.oldEnd === et.start || et.oldEnd === em.start
  if (overlap || samePoint) return { ok: false }

  const b = [...base]
  const m = [...mine]
  const t = [...theirs]
  const [first, second, fText, sText] =
    em.start < et.start ? [em, et, m.slice(em.start, em.newEnd), t.slice(et.start, et.newEnd)]
                        : [et, em, t.slice(et.start, et.newEnd), m.slice(em.start, em.newEnd)]
  const out = [
    ...b.slice(0, first.start), ...fText,
    ...b.slice(first.oldEnd, second.start), ...sText,
    ...b.slice(second.oldEnd)
  ]
  return { ok: true, text: out.join(''), theirsEdit: et }
}
