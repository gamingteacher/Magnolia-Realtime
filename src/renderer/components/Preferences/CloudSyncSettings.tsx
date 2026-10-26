import { useEffect, useState } from 'react'
import schemaSql from '../../sync/schema.sql?raw'
import { useSyncStore } from '../../sync/sync-store'
import { fetchActivity, type ActivityEntry, createCloudProject, createInvite, joinAndConnect, signIn, startSync, stopSync } from '../../sync/session'
import { useProjectStore } from '../../stores/project-store'

const row = { display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' } as const
const input = { flex: 1, fontSize: 12, padding: '4px 6px' } as const
const note = { fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 10 } as const

export function CloudSyncSettings(): JSX.Element {
  const sync = useSyncStore()
  const [url, setUrl] = useState('')
  const [key, setKey] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [msg, setMsg] = useState('')
  const [code, setCode] = useState('')
  const [invite, setInvite] = useState('')
  const [activity, setActivity] = useState<ActivityEntry[]>([])

  useEffect(() => {
    void window.api.syncGetConfig().then((c) => { setUrl(c.url); setHasKey(c.hasKey) })
  }, [])

  const run = async (fn: () => Promise<string | void>): Promise<void> => {
    setMsg('Working…')
    try { setMsg((await fn()) || 'Done') } catch (e: any) { setMsg(e?.message ?? String(e)) }
  }

  return (
    <div style={{ marginBottom: 24 }}>
      <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 10, color: 'var(--text-secondary)' }}>Cloud Sync</h3>
      <p style={note}>
        Optional. Connect to your own Supabase project to collaborate in real time. Data goes only to your
        database. Use the <b>anon/public</b> key — never the service-role key. Run the setup SQL once in the
        Supabase SQL editor.
      </p>
      <div style={row}>
        <input style={input} placeholder="https://xxxx.supabase.co" value={url} onChange={(e) => setUrl(e.target.value)} />
      </div>
      <div style={row}>
        <input style={input} type="password" placeholder={hasKey ? '•••••• (saved)' : 'anon/public key'}
          value={key} onChange={(e) => setKey(e.target.value)} />
      </div>
      <div style={row}>
        <button onClick={() => run(async () => {
          const r = await window.api.syncSetConfig(url.trim(), key.trim())
          if (r.ok) { setHasKey(true); setKey('') }
          return r.ok ? 'Saved' : r.error
        })}>Save</button>
        <button onClick={() => run(async () => {
          const r = await window.api.syncTestConnection()
          return r.ok ? 'Connection OK' : r.error
        })}>Test connection</button>
        <button onClick={() => run(async () => {
          await stopSync(); await window.api.syncClearConfig(); setHasKey(false); setKey('')
          return 'Cleared'
        })}>Clear</button>
        <button onClick={() => run(async () => { await navigator.clipboard.writeText(schemaSql); return 'Setup SQL copied' })}>
          Copy setup SQL
        </button>
      </div>

      <h3 style={{ fontSize: 13, fontWeight: 600, margin: '16px 0 8px', color: 'var(--text-secondary)' }}>
        This project — {sync.status}{sync.pending ? ` (${sync.pending} pending)` : ''}
      </h3>
      {sync.status === 'off' ? (
        <>
          <div style={row}>
            <button disabled={!hasKey} onClick={() => run(async () => {
              await signIn()
              const id = await createCloudProject(useProjectStore.getState().name)
              await startSync(id)
              setInvite(await createInvite(id, 'editor'))
              return `Cloud project created: ${id}`
            })}>Upload and share this project</button>
          </div>
          <div style={row}>
            <input style={input} placeholder="Invite code" value={code} onChange={(e) => setCode(e.target.value)} />
            <button disabled={!hasKey || !code} onClick={() => run(async () => {
              await signIn()
              const r = await joinAndConnect(code.trim())
              return r === 'review' ? 'Joined. Review the cloud changes in the Merge tab; syncing starts when you finish.' : 'Joined'
            })}>Join</button>
          </div>
          <p style={note}>Joining an empty project downloads the cloud project. Joining a project with content opens the Merge review so you choose what to keep; syncing starts when the review closes.</p>
        </>
      ) : (
        <div style={row}>
          <button onClick={() => run(async () => setInvite(await createInvite(sync.projectId!, 'editor')))}>New editor invite</button>
          <button onClick={() => sync.set({ paused: !sync.paused })}>{sync.paused ? 'Resume' : 'Pause'}</button>
          <button onClick={() => run(stopSync)}>Disconnect</button>
        </div>
      )}
      {sync.presence.length > 0 && (
        <p style={note}>Online now: {[...new Set(sync.presence.map((p) => p.displayName))].join(', ')}</p>
      )}
      {sync.role === 'viewer' && <p style={note}>You joined as a viewer: your local changes are not uploaded.</p>}
      {sync.status !== 'off' && (
        <div style={row}>
          <button onClick={() => run(async () => { setActivity(await fetchActivity()) })}>Show recent activity</button>
        </div>
      )}
      {activity.length > 0 && (
        <ul style={{ ...note, maxHeight: 160, overflow: 'auto', paddingLeft: 16 }}>
          {activity.map((a, i) => (
            <li key={i}>{new Date(a.created_at).toLocaleString()} — {a.op} {a.kind} {a.guid.slice(0, 8)}</li>
          ))}
        </ul>
      )}
      {invite && <p style={note}>Invite code (valid 7 days, single use): <code>{invite}</code></p>}
      {sync.conflicts.length > 0 && (
        <p style={note}>{sync.conflicts.length} conflict(s) were resolved in favour of the remote version: {sync.conflicts.slice(-5).map((c) => `${c.kind}:${c.guid} (${c.reason})`).join(', ')}</p>
      )}
      {(msg || sync.error) && <p style={note}>{msg || sync.error}</p>}
    </div>
  )
}
