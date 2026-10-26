import { useEffect, useState } from 'react'
import { AccountPanel } from '../Sync/AccountPanel'
import { ProjectPicker } from '../Sync/ProjectPicker'
import { getAuthClient } from '../../sync/auth'
import { useSyncStore } from '../../sync/sync-store'
import { clearAuthClient } from '../../sync/auth'

interface Props { onClose: () => void }

export function CloudConnectDialog({ onClose }: Props): JSX.Element {
  const account = useSyncStore((s) => s.account)
  const [url, setUrl] = useState('')
  const [key, setKey] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [savedUrl, setSavedUrl] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [pendingInvite, setPendingInvite] = useState('')

  useEffect(() => {
    void window.api.syncGetConfig().then((config) => {
      setUrl(config.url)
      setSavedUrl(config.url)
      setHasKey(config.hasKey)
    })
  }, [])

  const saveConfig = async (): Promise<void> => {
    setBusy(true)
    setMessage('')
    try {
      if (key.trim()) {
        const previous = await window.api.syncGetKeys()
        const changed = previous?.url !== url.trim() || previous?.anonKey !== key.trim()
        const result = await window.api.syncSetConfig(url.trim(), key.trim())
        if (!result.ok) throw new Error(result.error ?? 'Could not save Supabase configuration.')
        if (changed) {
          clearAuthClient()
          useSyncStore.getState().set({ account: null })
        }
        setHasKey(true)
        setSavedUrl(url.trim())
        setKey('')
      } else if (!hasKey || savedUrl !== url.trim()) {
        throw new Error('Enter the publishable key when changing the Supabase project.')
      }
      const test = await window.api.syncTestConnection()
      if (!test.ok) throw new Error(test.error ?? 'Supabase connection failed.')
      setMessage('Connection OK.')
    } catch (e) { setMessage(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  const openProject = (projectId: string): void => window.api.sendWelcomeAction(`cloud-open:${projectId}`)
  const join = async (code: string): Promise<void> => {
    if (!account) {
      setPendingInvite(code)
      setMessage('Create an account or log in above. Magnolia will join this invite after sign-in.')
      return
    }
    const { data: projectId, error } = await (await getAuthClient()).rpc('join_project', { p_code: code })
    if (error) throw new Error(error.message)
    if (typeof projectId !== 'string') throw new Error('The invite did not return a cloud project.')
    openProject(projectId)
  }

  useEffect(() => {
    if (!account || !pendingInvite) return
    const code = pendingInvite
    setPendingInvite('')
    void (async () => {
      try {
        const { data: projectId, error } = await (await getAuthClient()).rpc('join_project', { p_code: code })
        if (error) throw new Error(error.message)
        if (typeof projectId !== 'string') throw new Error('The invite did not return a cloud project.')
        openProject(projectId)
      } catch (e) { setMessage(e instanceof Error ? e.message : String(e)) }
    })()
  }, [account?.userId, pendingInvite])

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="cloud-connect-title" style={{
      position: 'fixed', inset: 0, zIndex: 10_000, background: 'rgba(0,0,0,.45)',
      display: 'grid', placeItems: 'center', padding: 18
    }}>
      <div style={{
        width: 'min(560px, 100%)', maxHeight: '90vh', overflow: 'auto', padding: 20,
        background: 'var(--bg-panel)', color: 'var(--text-primary)', borderRadius: 10,
        boxShadow: '0 12px 40px rgba(0,0,0,.28)'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 id="cloud-connect-title" style={{ fontSize: 16, margin: '0 0 12px' }}>Sign in / Sync a project</h2>
          <button className="secondary" aria-label="Close" onClick={onClose}>Close</button>
        </div>
        <p style={{ fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          Connect to your own Supabase project. Magnolia works offline; cloud data stays in your database.
        </p>
        <label style={{ display: 'block', fontSize: 12, margin: '10px 0 4px' }}>Supabase project URL</label>
        <input style={{ width: '100%', boxSizing: 'border-box', fontSize: 12, padding: 7 }}
          placeholder="https://xxxx.supabase.co" value={url} onChange={(e) => setUrl(e.target.value)} />
        <label style={{ display: 'block', fontSize: 12, margin: '10px 0 4px' }}>Publishable / anon key</label>
        <input style={{ width: '100%', boxSizing: 'border-box', fontSize: 12, padding: 7 }}
          type="password" placeholder={hasKey ? 'Saved securely' : 'Paste publishable key'}
          value={key} onChange={(e) => setKey(e.target.value)} />
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button disabled={busy || !url.trim() || (!key.trim() && !hasKey)} onClick={() => void saveConfig()}>
            {busy ? 'Testing…' : 'Save and test'}
          </button>
          <a href="https://caledavis.github.io/Magnolia/guide/sync"
            onClick={(e) => { e.preventDefault(); window.api.sendWelcomeAction('sync-manual') }}
            style={{ alignSelf: 'center', fontSize: 12 }}>Where do I find this?</a>
        </div>
        {message && <p role="status" style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>{message}</p>}
        {hasKey && <>
          <hr style={{ borderColor: 'var(--border-color)', margin: '14px 0' }} />
          <AccountPanel />
          <ProjectPicker onOpen={openProject} onJoin={join} />
        </>}
      </div>
    </div>
  )
}
