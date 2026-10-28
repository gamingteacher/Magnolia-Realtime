import { adjustOffset, computeTextEdit, type TextEdit } from '../utils/text-edit-offsets'

/** Pure logic for collaborative awareness; no DOM, Electron or Supabase access. */

export type EntityKind = 'source' | 'tool' | 'item'

export interface AwarenessState {
  /** Tab id: a source guid or a tool-tab id (analysis:…, map:…, preferences, …). */
  activeTab: string | null
  entityKind: EntityKind | null
  entityGuid: string | null
  /** Codepoint range in the source text (REFI-QDA positions); from === to is a bare caret. */
  selection?: { from: number; to: number }
  color: string
  idle: boolean
  ts: number
}

export interface PresenceLike extends Partial<AwarenessState> { userId: string; displayName: string; ts: number }

export const CARET_THROTTLE_MS = 150
export const HEARTBEAT_MS = 20_000
export const IDLE_AFTER_MS = 60_000
/** A user whose last update is older than this is treated as gone even if the channel still lists them. */
export const STALE_AFTER_MS = 75_000

const PALETTE = [
  '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#0aa5a5',
  '#c2185b', '#7a8b00', '#795548', '#1e88e5', '#d81b60', '#6d4c41'
]

/** Stable colour for a user id (same id → same colour on every client). */
export function colorForUser(userId: string): string {
  let h = 2166136261
  for (let i = 0; i < userId.length; i++) {
    h ^= userId.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return PALETTE[(h >>> 0) % PALETTE.length]
}

export interface Throttled<A extends unknown[]> {
  call: (...args: A) => void
  flush: () => void
  cancel: () => void
}

/** Leading + trailing throttle: the first call runs now, later calls within `ms` collapse into one trailing call. */
export function throttle<A extends unknown[]>(fn: (...args: A) => void, ms: number): Throttled<A> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: A | null = null
  const run = (): void => {
    timer = undefined
    if (!pending) return
    const a = pending
    pending = null
    fn(...a)
    timer = setTimeout(run, ms)
  }
  return {
    call: (...args) => {
      if (timer === undefined) {
        fn(...args)
        timer = setTimeout(run, ms)
      } else pending = args
    },
    flush: () => {
      clearTimeout(timer)
      timer = undefined
      run()
    },
    cancel: () => { clearTimeout(timer); timer = undefined; pending = null }
  }
}

/** Remote users that should currently be shown: one entry per user, not me, not idle, not stale. */
export function visibleRemote(list: PresenceLike[], selfId: string, now: number): PresenceLike[] {
  const latest = new Map<string, PresenceLike>()
  for (const e of list) {
    if (!e?.userId || e.userId === selfId) continue
    const cur = latest.get(e.userId)
    if (!cur || (e.ts ?? 0) >= (cur.ts ?? 0)) latest.set(e.userId, e)
  }
  return [...latest.values()].filter((e) => !e.idle && now - (e.ts ?? 0) <= STALE_AFTER_MS)
}

/** Whether two states differ enough to be worth publishing (ts and colour are ignored). */
export function awarenessChanged(a: AwarenessState | null, b: AwarenessState): boolean {
  if (!a) return true
  return a.activeTab !== b.activeTab || a.entityKind !== b.entityKind || a.entityGuid !== b.entityGuid ||
    a.idle !== b.idle || a.selection?.from !== b.selection?.from || a.selection?.to !== b.selection?.to
}

/** Move a remote caret/selection through a text edit made by someone else. */
export function shiftSelection(sel: { from: number; to: number }, edit: TextEdit): { from: number; to: number } {
  return { from: adjustOffset(sel.from, edit, 'start'), to: adjustOffset(sel.to, edit, 'end') }
}

export function shiftSelectionForText(sel: { from: number; to: number }, oldText: string, newText: string): { from: number; to: number } {
  const edit = computeTextEdit(oldText, newText)
  return edit ? shiftSelection(sel, edit) : sel
}

/** UTF-16 index in `text` → codepoint index. */
export const utf16ToCp = (text: string, idx: number): number => [...text.slice(0, idx)].length
/** Codepoint index → UTF-16 index in `text` (clamped to the text length). */
export const cpToUtf16 = (text: string, cp: number): number => [...text].slice(0, Math.max(0, cp)).join('').length

/** Resolve which entity the local user is "on", given the active tab and an optional explicit DOM marker. */
export function resolveFocus(
  activeTab: string | null,
  isTool: (tab: string) => boolean,
  marker?: string | null
): { entityKind: EntityKind | null; entityGuid: string | null } {
  if (marker) {
    const i = marker.indexOf(':')
    if (i > 0 && i < marker.length - 1) return { entityKind: 'item', entityGuid: marker }
  }
  if (!activeTab) return { entityKind: null, entityGuid: null }
  return { entityKind: isTool(activeTab) ? 'tool' : 'source', entityGuid: activeTab }
}
