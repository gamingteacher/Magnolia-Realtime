import type { SupabaseClient } from '@supabase/supabase-js'
import { create } from 'zustand'
import { useDocumentStore } from '../stores/document-store'
import { isToolTab } from '../utils/tab-ids'
import { generateGuid } from '../utils/guid'
import { useSyncStore } from './sync-store'
import type { PresenceEntry } from './session'
import {
  CARET_THROTTLE_MS, HEARTBEAT_MS, IDLE_AFTER_MS, awarenessChanged, colorForUser, cpToUtf16, resolveFocus,
  shiftSelectionForText, throttle, utf16ToCp, visibleRemote, type AwarenessState, type PresenceLike
} from './awareness-core'
import type { RemoteChange } from './remote-changes'

interface AwarenessStore {
  selfId: string
  /** Visible remote users, one entry each. */
  remote: PresenceEntry[]
  raw: PresenceEntry[]
  setPresence: (list: PresenceEntry[], selfId: string) => void
  refresh: () => void
  /** Move remote carets in `sourceGuid` through a text edit that was not made by their owner. */
  shiftForText: (sourceGuid: string, oldText: string, newText: string, authorId: string | null) => void
  reset: () => void
}

const compute = (raw: PresenceEntry[], selfId: string): PresenceEntry[] =>
  visibleRemote(raw as PresenceLike[], selfId, Date.now()) as PresenceEntry[]

export const useAwarenessStore = create<AwarenessStore>((set, get) => ({
  selfId: '',
  remote: [],
  raw: [],
  setPresence: (list, selfId) => set({ raw: list, selfId, remote: compute(list, selfId) }),
  refresh: () => set((s) => ({ remote: compute(s.raw, s.selfId) })),
  shiftForText: (sourceGuid, oldText, newText, authorId) => {
    const remote = get().remote.map((e) =>
      e.entityKind === 'source' && e.entityGuid === sourceGuid && e.selection && e.userId !== authorId
        ? { ...e, selection: shiftSelectionForText(e.selection, oldText, newText) }
        : e)
    set({ remote })
  },
  reset: () => set({ selfId: '', remote: [], raw: [] })
}))

/** Codepoint position of a DOM boundary inside the coded-text view, or null when it is outside it. */
function boundaryCp(node: Node, offset: number): number | null {
  if (node.nodeType === Node.TEXT_NODE) {
    const span = node.parentElement?.closest<HTMLElement>('[data-cpoffset]')
    if (!span) return null
    let before = ''
    const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n === node) { before += (n.textContent ?? '').slice(0, offset); break }
      before += n.textContent ?? ''
    }
    return parseInt(span.dataset.cpoffset!, 10) + utf16ToCp(before, before.length)
  }
  const child = node.childNodes[offset] ?? node.childNodes[node.childNodes.length - 1]
  const el = child instanceof HTMLElement ? child : child?.parentElement
  const span = el?.dataset.cpoffset !== undefined ? el : el?.querySelector<HTMLElement>('[data-cpoffset]')
  return span ? parseInt(span.dataset.cpoffset!, 10) : null
}

function readSelection(): { from: number; to: number } | undefined {
  const el = document.activeElement
  if (el instanceof HTMLTextAreaElement) {
    return { from: utf16ToCp(el.value, el.selectionStart), to: utf16ToCp(el.value, el.selectionEnd) }
  }
  const sel = window.getSelection()
  if (!sel || !sel.anchorNode || !sel.focusNode) return undefined
  const a = boundaryCp(sel.anchorNode, sel.anchorOffset)
  const f = boundaryCp(sel.focusNode, sel.focusOffset)
  if (a === null || f === null) return undefined
  return { from: Math.min(a, f), to: Math.max(a, f) }
}

/**
 * Join the presence channel and publish where this user is working (throttled), clearing it on idle,
 * hidden window or disconnect. Remote state lands in useAwarenessStore (and useSyncStore.presence).
 */
export function startAwareness(c: SupabaseClient, projectId: string): () => void {
  let selfId = ''
  let last: AwarenessState | null = null
  let marker: string | null = null
  let idle = false
  let lastActivity = Date.now()
  let ready = false
  const ch = c.channel(`presence:${projectId}`, { config: { presence: { key: generateGuid() } } })

  const local = (): AwarenessState => {
    const focus = resolveFocus(useDocumentStore.getState().viewedDocumentGuid, isToolTab, marker)
    return {
      activeTab: useDocumentStore.getState().viewedDocumentGuid, ...focus,
      selection: focus.entityKind === 'source' ? readSelection() : undefined,
      color: colorForUser(selfId), idle, ts: Date.now()
    }
  }
  const publish = (force: boolean): void => {
    if (!ready) return
    const next = local()
    if (!force && !awarenessChanged(last, next)) return
    last = next
    void ch.track({ userId: selfId, displayName: useSyncStore.getState().account?.displayName ?? 'User', ...next })
  }
  const throttled = throttle(() => publish(false), CARET_THROTTLE_MS)

  const activity = (): void => {
    lastActivity = Date.now()
    if (idle) { idle = false; publish(true) } else throttled.call()
  }
  const onFocusIn = (e: Event): void => {
    marker = (e.target as HTMLElement | null)?.closest?.<HTMLElement>('[data-sync-entity]')?.dataset.syncEntity ?? null
    activity()
  }
  const onVisibility = (): void => {
    if (document.hidden) { idle = true; publish(true) } else activity()
  }
  const unsubDocs = useDocumentStore.subscribe((s, prev) => {
    if (s.viewedDocumentGuid !== prev.viewedDocumentGuid) { marker = null; throttled.call() }
  })
  const events: [string, EventListener][] = [
    ['selectionchange', activity], ['keydown', activity], ['pointerdown', onFocusIn], ['focusin', onFocusIn]
  ]
  events.forEach(([n, f]) => document.addEventListener(n, f))
  document.addEventListener('visibilitychange', onVisibility)
  let lastBeat = Date.now()
  const tick = setInterval(() => {
    const now = Date.now()
    if (!idle && now - lastActivity > IDLE_AFTER_MS) { idle = true; publish(true); lastBeat = now }
    else if (!idle && now - lastBeat >= HEARTBEAT_MS) { publish(true); lastBeat = now }
    useAwarenessStore.getState().refresh()
  }, 5000)

  ch.on('presence', { event: 'sync' }, () => {
    const list = Object.values(ch.presenceState()).flat() as unknown as PresenceEntry[]
    useSyncStore.getState().set({ presence: list })
    useAwarenessStore.getState().setPresence(list, selfId)
  }).subscribe(async (status) => {
    if (status !== 'SUBSCRIBED') return
    selfId = (await c.auth.getUser()).data.user?.id ?? ''
    ready = true
    publish(true)
  })

  return () => {
    throttled.cancel()
    clearInterval(tick)
    unsubDocs()
    events.forEach(([n, f]) => document.removeEventListener(n, f))
    document.removeEventListener('visibilitychange', onVisibility)
    useAwarenessStore.getState().reset()
    void ch.untrack().finally(() => { void c.removeChannel(ch) })
  }
}

/**
 * Run `apply` (which writes remote changes into the stores) while keeping the local caret stable in a
 * focused transcript textarea, and shifting remote carets through the same text edit.
 */
export function applyKeepingCaret(changes: RemoteChange[], authorOf: (kind: string, guid: string) => string | null, apply: () => void): void {
  const texts = changes.filter((x) => x.kind === 'source_text' && !x.deleted && typeof x.data?.text === 'string')
  const before = useDocumentStore.getState().sourceContents
  const olds = new Map(texts.map((x) => [x.guid, before[x.guid]]))
  const el = typeof document !== 'undefined' ? document.activeElement : null
  const caret = el instanceof HTMLTextAreaElement
    ? texts.find((x) => olds.get(x.guid) === el.value)
    : undefined
  const sel = caret && el instanceof HTMLTextAreaElement
    ? { from: utf16ToCp(el.value, el.selectionStart), to: utf16ToCp(el.value, el.selectionEnd) }
    : null
  apply()
  for (const x of texts) {
    const old = olds.get(x.guid)
    if (old !== undefined) useAwarenessStore.getState().shiftForText(x.guid, old, x.data.text, authorOf('source_text', x.guid))
  }
  if (caret && sel && el instanceof HTMLTextAreaElement) {
    const old = olds.get(caret.guid)!
    const moved = shiftSelectionForText(sel, old, caret.data.text)
    requestAnimationFrame(() => {
      if (!el.isConnected || el.value !== caret.data.text) return
      el.setSelectionRange(cpToUtf16(el.value, moved.from), cpToUtf16(el.value, moved.to))
    })
  }
}
