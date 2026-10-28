import { useEffect, useRef, useState } from 'react'
import { useSyncStore } from '../../sync/sync-store'
import { useAwarenessStore } from '../../sync/awareness'
import { useNoticeStore } from '../../sync/remote-changes'
import { colorForUser, cpToUtf16, type PresenceLike } from '../../sync/awareness-core'
import { useDocumentStore } from '../../stores/document-store'

interface Box { x: number; y: number; w: number; h: number }
interface Mark { key: string; color: string; name: string; caret?: Box; rects: Box[]; outline?: Box }

const NOTICE_MS = 5000

/** Document point for a codepoint offset inside the coded-text spans, or null when that text is not rendered. */
function domPoint(cp: number): { node: Text; offset: number; span: HTMLElement } | null {
  let end: { node: Text; offset: number; span: HTMLElement } | null = null
  for (const span of document.querySelectorAll<HTMLElement>('[data-cpoffset]')) {
    const off = parseInt(span.dataset.cpoffset!, 10)
    const text = span.textContent ?? ''
    const len = [...text].length
    if (cp < off || cp > off + len) continue
    let idx = cpToUtf16(text, cp - off)
    const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
      const l = n.data.length
      if (idx < l) return { node: n, offset: idx, span }
      if (idx === l) end = { node: n, offset: l, span }
      idx -= l
    }
    if (cp < off + len) continue
  }
  return end
}

function clipBox(el: HTMLElement): DOMRect {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY
    if (o === 'auto' || o === 'scroll') return p.getBoundingClientRect()
  }
  return document.documentElement.getBoundingClientRect()
}

const toBox = (r: DOMRect | DOMRectReadOnly): Box => ({ x: r.left, y: r.top, w: r.width, h: r.height })
const inside = (r: Box, c: DOMRect): boolean => r.y + r.h > c.top && r.y < c.bottom && r.x + r.w > c.left && r.x < c.right

function measure(remote: PresenceLike[], viewed: string | null): Mark[] {
  const marks: Mark[] = []
  for (const e of remote) {
    const color = e.color ?? colorForUser(e.userId)
    const base = { key: e.userId, color, name: e.displayName }
    if (e.entityKind === 'source' && e.entityGuid === viewed && e.selection) {
      const a = domPoint(e.selection.from)
      const b = domPoint(e.selection.to)
      if (!b) continue
      const clip = clipBox(b.span)
      const range = document.createRange()
      let rects: Box[] = []
      if (a && e.selection.from !== e.selection.to) {
        range.setStart(a.node, a.offset)
        range.setEnd(b.node, b.offset)
        rects = [...range.getClientRects()].map(toBox).filter((r) => inside(r, clip))
      }
      range.setStart(b.node, b.offset)
      range.setEnd(b.node, b.offset)
      const cr = range.getClientRects()[0] ?? range.getBoundingClientRect()
      const caret = cr && (cr.height > 0 || cr.width > 0) ? toBox(cr) : undefined
      marks.push({ ...base, rects, caret: caret && inside(caret, clip) ? caret : undefined })
    } else if (e.entityKind === 'item' && e.entityGuid) {
      const el = document.querySelector<HTMLElement>(`[data-sync-entity="${CSS.escape(e.entityGuid)}"]`)
      if (el) marks.push({ ...base, rects: [], outline: toBox(el.getBoundingClientRect()) })
    }
  }
  return marks
}

function whereLabel(e: PresenceLike, sourceName: (g: string) => string | undefined): string {
  const g = e.entityGuid ?? ''
  if (e.entityKind === 'source') return sourceName(g) ?? 'a document'
  if (e.entityKind === 'item') return g
  if (g === 'preferences') return 'Preferences'
  if (g.startsWith('map:')) return 'a relationship map'
  if (g.startsWith('query-builder:')) return 'the query builder'
  if (g.startsWith('analysis:')) return `${g.split(':')[1] ?? 'an'} analysis`
  return 'another view'
}

function Overlay(): JSX.Element {
  const remote = useAwarenessStore((s) => s.remote)
  const viewed = useDocumentStore((s) => s.viewedDocumentGuid)
  const sources = useDocumentStore((s) => s.sources)
  const notices = useNoticeStore((s) => s.notices)
  const [marks, setMarks] = useState<Mark[]>([])
  const raf = useRef(0)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const schedule = (): void => {
      if (raf.current) return
      raf.current = requestAnimationFrame(() => {
        raf.current = 0
        const next = measure(remote, viewed)
        setMarks((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
      })
    }
    schedule()
    const mo = new MutationObserver((records) => {
      if (records.some((r) => !(r.target instanceof Node && root.current?.contains(r.target)))) schedule()
    })
    mo.observe(document.body, { childList: true, subtree: true, characterData: true })
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    return () => {
      mo.disconnect()
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
      cancelAnimationFrame(raf.current)
      raf.current = 0
    }
  }, [remote, viewed])

  useEffect(() => {
    const timers = notices.filter((n) => !n.conflict).map((n) =>
      setTimeout(() => useNoticeStore.getState().dismiss(n.key), Math.max(0, NOTICE_MS - (Date.now() - n.ts))))
    return () => timers.forEach(clearTimeout)
  }, [notices])

  const sourceName = (g: string): string | undefined => sources.find((s) => s.guid === g)?.name
  const fixed = { position: 'fixed', pointerEvents: 'none' } as const
  const label = (m: Mark): JSX.Element => (
    <span style={{ position: 'absolute', left: 0, bottom: '100%', background: m.color, color: '#fff', fontSize: 10.5, lineHeight: '14px', padding: '0 4px', borderRadius: '3px 3px 3px 0', whiteSpace: 'nowrap' }}>
      {m.name}
    </span>
  )

  return (
    <div ref={root} style={{ display: 'contents' }}>
      <div style={{ ...fixed, inset: 0, zIndex: 8990 }}>
        {marks.map((m) => (
          <div key={m.key}>
            {m.rects.map((r, i) => (
              <div key={i} style={{ ...fixed, left: r.x, top: r.y, width: r.w, height: r.h, background: m.color, opacity: 0.22 }} />
            ))}
            {m.caret && (
              <div title={m.name} style={{ ...fixed, left: m.caret.x, top: m.caret.y, width: 2, height: Math.max(m.caret.h, 14), background: m.color }}>
                {label(m)}
              </div>
            )}
            {m.outline && (
              <div style={{ ...fixed, left: m.outline.x, top: m.outline.y, width: m.outline.w, height: m.outline.h, outline: `2px solid ${m.color}`, borderRadius: 3 }}>
                {label(m)}
              </div>
            )}
          </div>
        ))}
      </div>
      <div style={{ position: 'fixed', right: 10, bottom: 44, zIndex: 9000, display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end', pointerEvents: 'none' }}>
        {remote.map((e) => (
          <div key={e.userId} title={`${e.displayName} is on ${whereLabel(e, sourceName)}`}
            style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: 'var(--bg-secondary, #fff)', border: `1.5px solid ${e.color ?? colorForUser(e.userId)}`, color: 'var(--text-secondary)' }}>
            <span style={{ color: e.color ?? colorForUser(e.userId) }}>●</span> {e.displayName} · {whereLabel(e, sourceName)}
          </div>
        ))}
      </div>
      <div style={{ position: 'fixed', left: 10, bottom: 10, zIndex: 9000, display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 380 }}>
        {notices.map((n) => (
          <div key={n.key} role="status" style={{ fontSize: 12, padding: '6px 10px', borderRadius: 6, background: 'var(--bg-secondary, #fff)', color: 'var(--text-primary, #222)', border: `1px solid ${n.conflict ? 'var(--danger, #c00)' : 'var(--border, #ccc)'}` }}>
            {n.text}{' '}
            <button style={{ fontSize: 11 }} onClick={() => useNoticeStore.getState().dismiss(n.key)}>OK</button>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Single mount point. Renders nothing, and runs no overlay code, while sync is off. */
export function AwarenessOverlay(): JSX.Element | null {
  const on = useSyncStore((s) => s.status !== 'off')
  return on ? <Overlay /> : null
}
