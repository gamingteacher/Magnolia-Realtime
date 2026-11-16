import { useEffect, useState } from 'react'
import { createInvite, listInvites, revokeInvite, type InviteEntry } from '../../sync/session'
import { useTranslation } from 'react-i18next'

const row = { display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' as const }
const note = { fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.5 } as const

interface Props { projectId: string }

const localInputValue = (date: Date): string => {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

export function InvitePanel({ projectId }: Props): JSX.Element {
  const { t } = useTranslation()
  const [invites, setInvites] = useState<InviteEntry[]>([])
  const [role, setRole] = useState<'editor' | 'viewer'>('editor')
  const [expires, setExpires] = useState(() => localInputValue(new Date(Date.now() + 7 * 86400_000)))
  const [maxUses, setMaxUses] = useState('')
  const [message, setMessage] = useState('')

  const refresh = (): void => {
    void listInvites(projectId).then(setInvites).catch((e: unknown) =>
      setMessage(e instanceof Error ? e.message : String(e)))
  }
  useEffect(refresh, [projectId])

  const create = async (): Promise<void> => {
    setMessage('')
    try {
      const code = await createInvite(projectId, role, new Date(expires).toISOString(),
        maxUses.trim() ? Number(maxUses) : null)
      await navigator.clipboard.writeText(code)
      setMessage(t('sync.inviteCreated', { code }))
      refresh()
    } catch (e) { setMessage(e instanceof Error ? e.message : String(e)) }
  }

  const revoke = async (code: string): Promise<void> => {
    setMessage('')
    try { await revokeInvite(code); setMessage(t('sync.inviteRevoked')); refresh() }
    catch (e) { setMessage(e instanceof Error ? e.message : String(e)) }
  }

  return (
    <section>
      <h4 style={{ fontSize: 12, margin: '14px 0 8px' }}>{t('sync.invites')}</h4>
      <div style={row}>
        <select aria-label={t('sync.inviteRole')} value={role} onChange={(e) => setRole(e.target.value as 'editor' | 'viewer')}>
          <option value="editor">{t('sync.role.editor')}</option><option value="viewer">{t('sync.role.viewer')}</option>
        </select>
        <label style={note}>{t('sync.expires')} <input type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} /></label>
        <label style={note}>{t('sync.maxUses')} <input type="number" min="1" value={maxUses}
          onChange={(e) => setMaxUses(e.target.value)} placeholder={t('sync.unlimited')} style={{ width: 80 }} /></label>
        <button disabled={!expires || (!!maxUses && (!Number.isInteger(Number(maxUses)) || Number(maxUses) < 1))}
          onClick={() => void create()}>{t('sync.createInvite')}</button>
      </div>
      {invites.map((invite) => (
        <div key={invite.code} style={{ ...row, padding: '4px 0', borderTop: '1px solid var(--border-color)' }}>
          <code style={{ fontSize: 11 }}>{invite.code}</code>
          <span style={note}>{t('sync.inviteDetails', {
            role: t(`sync.role.${invite.role}`),
            created: new Date(invite.created_at).toLocaleString(),
            expires: new Date(invite.expires_at).toLocaleString(),
            uses: invite.max_uses ? `${invite.uses}/${invite.max_uses}` : String(invite.uses),
            revoked: invite.revoked ? `; ${t('sync.revoked')}` : ''
          })}</span>
          {!invite.revoked && new Date(invite.expires_at) > new Date() &&
            <button onClick={() => void revoke(invite.code)}>{t('sync.revoke')}</button>}
        </div>
      ))}
      {message && <p role="status" style={note}>{message}</p>}
    </section>
  )
}
