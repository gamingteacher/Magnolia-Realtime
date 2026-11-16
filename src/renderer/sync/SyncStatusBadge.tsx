import { useState } from 'react'
import { useSyncStore } from './sync-store'
import { resolveConflict, stopSync, syncNow } from './session'
import { useTranslation } from 'react-i18next'

export function SyncStatusBadge(): JSX.Element | null {
  const { t } = useTranslation()
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
        ☁ {t(`sync.status.${s.status}`)}{s.pending ? ` · ${t('sync.pendingLabel', { count: s.pending })}` : ''}
        {s.presence.length > 1 ? ` · ${t('sync.onlineLabel', { count: s.presence.length })}` : ''}
        {s.conflicts.length ? ` · ${t('sync.conflictLabel', { count: s.conflicts.length })}` : ''}{s.role === 'viewer' ? ` · ${t('sync.readOnly')}` : ''}
        {s.account ? ` · @${s.account.username}` : ''}
      </div>
      {open && (
        <div style={{ marginTop: 6 }}>
          {s.error && <div style={{ color: 'var(--danger, #c00)' }}>{s.error}</div>}
          <div style={{ display: 'flex', gap: 6, margin: '4px 0' }}>
            <button onClick={syncNow}>{t('sync.syncNow')}</button>
            <button onClick={() => s.set({ paused: !s.paused })}>{s.paused ? t('sync.resume') : t('sync.pause')}</button>
            <button onClick={() => void stopSync()}>{t('sync.disconnect')}</button>
          </div>
          {s.conflicts.map((c, i) => (
            <div key={i} style={{ borderTop: '1px solid var(--border, #ccc)', padding: '4px 0' }}>
              <div>{c.kind} {c.guid.slice(0, 8)} — {c.reason}</div>
              {c.reason === 'text' && (
                <details>
                  <summary>{t('sync.compare')}</summary>
                  <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 100, overflow: 'auto' }}>{t('sync.mine')}{'\n'}{c.mine?.text}{'\n\n'}{t('sync.theirs')}{'\n'}{c.theirs?.text}</pre>
                </details>
              )}
              <button onClick={() => resolveConflict(c, 'mine')} disabled={c.reason === 'deleted'}>{t('sync.keepMine')}</button>{' '}
              <button onClick={() => resolveConflict(c, 'theirs')}>{t('sync.takeTheirs')}</button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
