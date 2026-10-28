import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  colorForUser, throttle, visibleRemote, shiftSelectionForText, awarenessChanged, resolveFocus,
  cpToUtf16, utf16ToCp, STALE_AFTER_MS, type AwarenessState
} from '../../src/renderer/sync/awareness-core'

afterEach(() => vi.useRealTimers())

describe('colorForUser', () => {
  it('is stable and well-formed', () => {
    expect(colorForUser('user-1')).toBe(colorForUser('user-1'))
    expect(colorForUser('user-1')).toMatch(/^#[0-9a-f]{6}$/)
  })
  it('spreads different ids over several colours', () => {
    const set = new Set(Array.from({ length: 40 }, (_, i) => colorForUser(`u-${i}`)))
    expect(set.size).toBeGreaterThan(5)
  })
})

describe('throttle', () => {
  it('runs first call now and collapses the rest into one trailing call with the latest args', () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    const t = throttle(fn, 150)
    t.call(1); t.call(2); t.call(3)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenLastCalledWith(1)
    vi.advanceTimersByTime(150)
    expect(fn).toHaveBeenCalledTimes(2)
    expect(fn).toHaveBeenLastCalledWith(3)
    vi.advanceTimersByTime(1000)
    expect(fn).toHaveBeenCalledTimes(2)
  })
  it('cancel drops the pending call', () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    const t = throttle(fn, 100)
    t.call('a'); t.call('b'); t.cancel()
    vi.advanceTimersByTime(500)
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe('visibleRemote', () => {
  const now = 1_000_000
  it('drops self, idle and stale users and keeps the newest entry per user', () => {
    const list = [
      { userId: 'me', displayName: 'Me', ts: now },
      { userId: 'a', displayName: 'Ana', ts: now - 1000, entityGuid: 'old' },
      { userId: 'a', displayName: 'Ana', ts: now - 10, entityGuid: 'new' },
      { userId: 'b', displayName: 'Bo', ts: now, idle: true },
      { userId: 'c', displayName: 'Cy', ts: now - STALE_AFTER_MS - 1 }
    ]
    const out = visibleRemote(list, 'me', now)
    expect(out.map((e) => e.userId)).toEqual(['a'])
    expect(out[0].entityGuid).toBe('new')
  })
})

describe('caret mapping', () => {
  it('shifts a remote caret after an insertion before it', () => {
    expect(shiftSelectionForText({ from: 10, to: 14 }, 'hello world foo', 'XXhello world foo')).toEqual({ from: 12, to: 16 })
  })
  it('leaves a caret before the edit alone and clamps one inside a deleted span', () => {
    expect(shiftSelectionForText({ from: 2, to: 2 }, 'abcdef', 'abcdeXf')).toEqual({ from: 2, to: 2 })
    expect(shiftSelectionForText({ from: 3, to: 3 }, 'abcdef', 'af')).toEqual({ from: 1, to: 1 })
  })
  it('converts between UTF-16 indexes and codepoints', () => {
    const t = 'a😀b'
    expect(utf16ToCp(t, 3)).toBe(2)
    expect(cpToUtf16(t, 2)).toBe(3)
  })
})

describe('awarenessChanged / resolveFocus', () => {
  const base: AwarenessState = { activeTab: 't', entityKind: 'source', entityGuid: 't', color: '#000', idle: false, ts: 1 }
  it('ignores ts, notices selection and idle changes', () => {
    expect(awarenessChanged(base, { ...base, ts: 99 })).toBe(false)
    expect(awarenessChanged(base, { ...base, selection: { from: 1, to: 2 } })).toBe(true)
    expect(awarenessChanged(base, { ...base, idle: true })).toBe(true)
    expect(awarenessChanged(null, base)).toBe(true)
  })
  it('classifies source, tool and explicit item focus', () => {
    const isTool = (t: string): boolean => t.startsWith('analysis:')
    expect(resolveFocus('doc1', isTool)).toEqual({ entityKind: 'source', entityGuid: 'doc1' })
    expect(resolveFocus('analysis:x:1', isTool)).toEqual({ entityKind: 'tool', entityGuid: 'analysis:x:1' })
    expect(resolveFocus('doc1', isTool, 'code:c1')).toEqual({ entityKind: 'item', entityGuid: 'code:c1' })
    expect(resolveFocus(null, isTool)).toEqual({ entityKind: null, entityGuid: null })
  })
})
