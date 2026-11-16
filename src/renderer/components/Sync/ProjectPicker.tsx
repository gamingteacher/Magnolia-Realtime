import { useEffect, useState } from 'react'
import { getAuthClient } from '../../sync/auth'
import { useSyncStore } from '../../sync/sync-store'
import { useTranslation } from 'react-i18next'

const row = { display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' } as const
const input = { flex: 1, minWidth: 0, fontSize: 12, padding: '6px 8px' } as const

interface Props {
  onOpen: (projectId: string) => Promise<void> | void
  onJoin: (code: string) => Promise<void> | void
}

interface CloudProjectEntry { id: string; name: string; role: 'owner' | 'editor' | 'viewer' }

export function ProjectPicker({ onOpen, onJoin }: Props): JSX.Element {
  const { t } = useTranslation()
  const accountId = useSyncStore((s) => s.account?.userId)
  const [projects, setProjects] = useState<CloudProjectEntry[]>([])
  const [code, setCode] = useState('')
  const [message, setMessage] = useState('')
  const refresh = (): void => {
    void getAuthClient().then((client) => client.rpc('list_my_projects')).then(({ data, error }) => {
      if (error) throw new Error(error.message)
      setProjects((data ?? []) as CloudProjectEntry[])
      setMessage('')
    }).catch((e: unknown) => setMessage(e instanceof Error ? e.message : String(e)))
  }
  useEffect(() => {
    if (accountId) refresh()
    else { setProjects([]); setMessage('') }
  }, [accountId])

  const act = async (fn: () => Promise<void> | void): Promise<void> => {
    setMessage('')
    try { await fn(); refresh() } catch (e) { setMessage(e instanceof Error ? e.message : String(e)) }
  }

  return (
    <div>
      <strong style={{ fontSize: 12 }}>{t('sync.myCloudProjects')}</strong>
      {projects.length === 0 && <p style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>{t('sync.noProjects')}</p>}
      {projects.map((p) => (
        <div key={p.id} style={row}>
          <span style={{ flex: 1, fontSize: 12 }}>{p.name} <small>({p.role})</small></span>
          <button onClick={() => void act(() => onOpen(p.id))}>{t('sync.open')}</button>
        </div>
      ))}
      <div style={{ ...row, marginTop: 12 }}>
        <input style={input} placeholder={t('sync.inviteCode')} value={code} onChange={(e) => setCode(e.target.value)} />
        <button disabled={!code.trim()} onClick={() => void act(async () => { await onJoin(code.trim()); setCode('') })}>
          {t('sync.joinWithCode')}
        </button>
      </div>
      {message && <p role="status" style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>{message}</p>}
    </div>
  )
}
