import { useState } from 'react'
import { useSyncStore } from './sync-store'
import { resolveConflict, stopSync, syncNow } from './session'

const label: Record<string, string> = {
  connecting: 'Connecting…', synced: 'Synced', syncing: 'Syncing…', offline: 'Offline', error: 'Sync error'
}

export function SyncStatusBadge(): JSX.Element | null {
  const s = useSyncStore()
  const [open, setOpen] = useState(false)
  if (s.status === 'off') return null
  const box = {
    position: 'fixed', right: 10, bottom: 10, zIndex: 9000, fontSize: 11.5, padding: '4px 10px',
    background: 'var(--bg-secondary, #fff)', color: 'var(--text-secondary)', border: '1px solid var(--border, #ccc)',
    borderRadius: 6, maxWidth: 380
  } as const
  return (
    <div style={box}>
      <div style={{ cursor: 'pointer' }} onClick={() => setOpen(!open)}>
        ☁ {label[s.status]}{s.pending ? ` · ${s.pending} pending` : ''}{s.presence.length > 1 ? ` · ${s.presence.length} online` : ''}
        {s.conflicts.length ? ` · ${s.conflicts.length} conflict(s)` : ''}{s.role === 'viewer' ? ' · read-only' : ''}
        {s.account ? ` · @${s.account.username}` : ''}
      </div>
      {open && (
        <div style={{ marginTop: 6 }}>
          {s.error && <div style={{ color: 'var(--danger, #c00)' }}>{s.error}</div>}
          <div style={{ display: 'flex', gap: 6, margin: '4px 0' }}>
            <button onClick={syncNow}>Sync now</button>
            <button onClick={() => s.set({ paused: !s.paused })}>{s.paused ? 'Resume' : 'Pause'}</button>
            <button onClick={() => void stopSync()}>Disconnect</button>
          </div>
          {s.conflicts.map((c, i) => (
            <div key={i} style={{ borderTop: '1px solid var(--border, #ccc)', padding: '4px 0' }}>
              <div>{c.kind} {c.guid.slice(0, 8)} — {c.reason}</div>
              {c.reason === 'text' && (
                <details>
                  <summary>Compare</summary>
                  <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 100, overflow: 'auto' }}>Mine:{'\n'}{c.mine?.text}{'\n\n'}Theirs:{'\n'}{c.theirs?.text}</pre>
                </details>
              )}
              <button onClick={() => resolveConflict(c, 'mine')} disabled={c.reason === 'deleted'}>Keep mine</button>{' '}
              <button onClick={() => resolveConflict(c, 'theirs')}>Take theirs</button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
