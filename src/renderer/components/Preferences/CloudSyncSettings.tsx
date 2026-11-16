import { useEffect, useState } from 'react'
import schemaSql from '../../sync/schema.sql?raw'
import { useSyncStore } from '../../sync/sync-store'
import { clearAuthClient } from '../../sync/auth'
import {
  fetchActivity, type ActivityEntry, createCloudProject, createInvite, joinAndConnect,
  connectExistingAndConnect, startSync, stopSync
} from '../../sync/session'
import { useProjectStore } from '../../stores/project-store'
import { AccountPanel } from '../Sync/AccountPanel'
import { InvitePanel } from '../Sync/InvitePanel'
import { MembersPanel } from '../Sync/MembersPanel'
import { ProjectPicker } from '../Sync/ProjectPicker'
import { useTranslation } from 'react-i18next'

const row = { display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' } as const
const input = { flex: 1, fontSize: 12, padding: '4px 6px' } as const
const note = { fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 10 } as const

export function CloudSyncSettings(): JSX.Element {
  const { t } = useTranslation()
  const sync = useSyncStore()
  const [url, setUrl] = useState('')
  const [key, setKey] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [savedUrl, setSavedUrl] = useState('')
  const [msg, setMsg] = useState('')
  const [activity, setActivity] = useState<ActivityEntry[]>([])

  useEffect(() => {
    void window.api.syncGetConfig().then((c) => { setUrl(c.url); setSavedUrl(c.url); setHasKey(c.hasKey) })
  }, [])

  const run = async (fn: () => Promise<string | void>): Promise<void> => {
    setMsg(t('sync.working'))
    try { setMsg((await fn()) || t('common.done')) } catch (e) { setMsg(e instanceof Error ? e.message : String(e)) }
  }

  return (
    <div style={{ marginBottom: 24 }}>
      <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 10, color: 'var(--text-secondary)' }}>{t('sync.settingsTitle')}</h3>
      <p style={note}>
        {t('sync.settingsIntro')}
      </p>
      <div style={row}>
        <input style={input} placeholder={t('sync.projectUrlPlaceholder')} value={url} onChange={(e) => setUrl(e.target.value)} />
      </div>
      <div style={row}>
        <input style={input} type="password" placeholder={hasKey ? t('sync.keySavedPlaceholder') : t('sync.keyPlaceholder')}
          value={key} onChange={(e) => setKey(e.target.value)} />
      </div>
      <div style={row}>
        <button onClick={() => run(async () => {
          if (key.trim()) {
            const previous = await window.api.syncGetKeys()
            const changed = previous?.url !== url.trim() || previous?.anonKey !== key.trim()
            const r = await window.api.syncSetConfig(url.trim(), key.trim())
            if (!r.ok) throw new Error(r.error ?? t('sync.saveCredentialsFailed'))
            if (changed) {
              await stopSync()
              clearAuthClient()
              useSyncStore.getState().set({ account: null })
            }
            setHasKey(true)
            setSavedUrl(url.trim())
            setKey('')
          } else if (!hasKey || savedUrl !== url.trim()) throw new Error(t('sync.enterPublishableKey'))
          const test = await window.api.syncTestConnection()
          if (!test.ok) throw new Error(test.error ?? t('sync.connectionFailed'))
          return t('sync.connectionOk')
        })}>{t('sync.saveTestConnection')}</button>
        <button onClick={() => run(async () => {
          await stopSync()
          await window.api.syncClearConfig()
          clearAuthClient()
          useSyncStore.getState().set({ account: null })
          setHasKey(false)
          setSavedUrl('')
          setKey('')
          return t('sync.configurationCleared')
        })}>{t('common.clear')}</button>
        <button onClick={() => run(async () => {
          await navigator.clipboard.writeText(schemaSql)
          return t('sync.setupSqlCopied')
        })}>{t('sync.copySetupSql')}</button>
      </div>
      <p style={note}>
        <a href="https://caledavis.github.io/Magnolia/guide/sync" target="_blank" rel="noreferrer">{t('sync.setupGuide')}</a>
      </p>

      {hasKey && <>
        <h4 style={{ fontSize: 12, margin: '16px 0 8px' }}>{t('sync.account')}</h4>
        <AccountPanel />
      </>}

      <h3 style={{ fontSize: 13, fontWeight: 600, margin: '16px 0 8px', color: 'var(--text-secondary)' }}>
        {t('sync.projectHeading', {
          status: t(`sync.status.${sync.status}`),
          pending: sync.pending ? ` (${t('sync.pendingLabel', { count: sync.pending })})` : ''
        })}
      </h3>
      {sync.status === 'off' ? <>
        <div style={row}>
          <button disabled={!hasKey || !sync.account} onClick={() => run(async () => {
            const id = await createCloudProject(useProjectStore.getState().name)
            await startSync(id)
            const expiresAt = new Date(Date.now() + 7 * 86400_000).toISOString()
            const invite = await createInvite(id, 'editor', expiresAt)
            await navigator.clipboard.writeText(invite)
            return t('sync.projectCreated', { invite })
          })}>{t('sync.uploadAndShare')}</button>
        </div>
        {sync.account && <ProjectPicker onOpen={async (id) => {
          const result = await connectExistingAndConnect(id)
          if (result === 'review') setMsg(t('sync.connectedReview'))
        }} onJoin={async (inviteCode) => {
          const result = await joinAndConnect(inviteCode)
          if (result === 'review') setMsg(t('sync.joinedReview'))
        }} />}
        <p style={note}>{t('sync.joinProjectHelp')}</p>
      </> : <>
        <div style={row}>
          <button onClick={() => sync.set({ paused: !sync.paused })}>{sync.paused ? t('sync.resume') : t('sync.pause')}</button>
          <button onClick={() => run(stopSync)}>{t('sync.disconnect')}</button>
        </div>
        {sync.role === 'owner' && sync.projectId && <>
          <InvitePanel projectId={sync.projectId} />
          <MembersPanel projectId={sync.projectId} />
        </>}
      </>}
      {sync.presence.length > 0 && <p style={note}>{t('sync.onlineNow', { names: [...new Set(sync.presence.map((p) => p.displayName))].join(', ') })}</p>}
      {sync.role === 'viewer' && <p style={note}>{t('sync.viewerNotice')}</p>}
      {sync.status !== 'off' && <>
        <div style={row}>
          <button onClick={() => run(async () => { setActivity(await fetchActivity()); return t('sync.activityLoaded') })}>{t('sync.showRecentActivity')}</button>
        </div>
        {activity.length > 0 && (
          <ul style={{ ...note, maxHeight: 160, overflow: 'auto', paddingLeft: 16 }}>
            {activity.map((a, i) => (
              <li key={i}>{t('sync.activityEntry', {
                date: new Date(a.created_at).toLocaleString(),
                author: a.author_name ?? a.author ?? t('sync.unknown'),
                operation: a.op,
                kind: a.kind,
                id: a.guid.slice(0, 8)
              })}</li>
            ))}
          </ul>
        )}
      </>}
      {sync.conflicts.length > 0 && (
        <p style={note}>{t('sync.conflictsResolved', {
          count: sync.conflicts.length,
          conflicts: sync.conflicts.slice(-5).map((c) => `${c.kind}:${c.guid} (${c.reason})`).join(', ')
        })}</p>
      )}
      {(msg || sync.error) && <p role="status" style={note}>{msg || sync.error}</p>}
    </div>
  )
}
