import { useEffect, useState } from 'react'
import { changeDisplayName, currentUser, logIn, logOut, signUp, type SyncProfile } from '../../sync/auth'
import { useSyncStore } from '../../sync/sync-store'
import { useTranslation } from 'react-i18next'

const row = { display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' } as const
const input = { flex: 1, minWidth: 0, fontSize: 12, padding: '6px 8px' } as const
const note = { fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.5, margin: '6px 0 10px' } as const

export function AccountPanel(): JSX.Element {
  const { t } = useTranslation()
  const account = useSyncStore((s) => s.account)
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void currentUser().then((profile) => {
      if (profile) setDisplayName(profile.displayName)
    }).catch((e: unknown) => setMessage(e instanceof Error ? e.message : String(e)))
  }, [])

  const run = async (fn: () => Promise<SyncProfile | void>): Promise<void> => {
    setBusy(true)
    setMessage('')
    try {
      const result = await fn()
      if (result && 'displayName' in result) setDisplayName(result.displayName)
      setPassword('')
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (account) {
    return (
      <div>
        <div style={row}>
          <strong style={{ fontSize: 12 }}>{t('sync.signedInAs', { username: account.username })}</strong>
          <button disabled={busy} onClick={() => void run(logOut)}>{t('sync.logOut')}</button>
        </div>
        <div style={row}>
          <input style={input} aria-label={t('sync.displayName')} value={displayName}
            onChange={(e) => setDisplayName(e.target.value)} />
          <button disabled={busy || !displayName.trim()} onClick={() => void run(() => changeDisplayName(displayName))}>
            {t('sync.updateName')}
          </button>
        </div>
        <p style={note}>{t('sync.passwordWarning')}</p>
        {message && <p role="status" style={note}>{message}</p>}
      </div>
    )
  }

  return (
    <div>
      <div style={{ ...row, marginBottom: 10 }}>
        <button className={mode === 'login' ? undefined : 'secondary'} onClick={() => setMode('login')}>{t('sync.logIn')}</button>
        <button className={mode === 'signup' ? undefined : 'secondary'} onClick={() => setMode('signup')}>{t('sync.createAccount')}</button>
      </div>
      {mode === 'signup' && (
        <div style={row}>
          <input style={input} placeholder={t('sync.displayName')} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </div>
      )}
      <div style={row}>
        <input style={input} autoComplete="username" placeholder={t('sync.username')} value={username}
          onChange={(e) => setUsername(e.target.value)} />
        <input style={input} autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          type="password" placeholder={t('sync.password')} value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      <div style={row}>
        <button disabled={busy || !username || !password || (mode === 'signup' && !displayName.trim())}
          onClick={() => void run(() => mode === 'login'
            ? logIn(username, password)
            : signUp(username, password, displayName))}>
          {busy ? t('sync.working') : mode === 'login' ? t('sync.logIn') : t('sync.createAccount')}
        </button>
      </div>
      <p style={note}>{t('sync.accountHelp')}</p>
      {message && <p role="status" style={note}>{message}</p>}
    </div>
  )
}
