import { useEffect, useState } from 'react'
import { listMembers, removeMember, setMemberRole, type MemberEntry } from '../../sync/session'

const row = { display: 'flex', gap: 8, marginBottom: 6, alignItems: 'center' } as const
const note = { fontSize: 11.5, color: 'var(--text-secondary)' } as const

interface Props { projectId: string }

export function MembersPanel({ projectId }: Props): JSX.Element {
  const [members, setMembers] = useState<MemberEntry[]>([])
  const [message, setMessage] = useState('')
  const refresh = (): void => {
    void listMembers(projectId).then(setMembers).catch((e: unknown) =>
      setMessage(e instanceof Error ? e.message : String(e)))
  }
  useEffect(refresh, [projectId])

  const updateRole = async (member: MemberEntry, role: 'editor' | 'viewer'): Promise<void> => {
    setMessage('')
    try { await setMemberRole(projectId, member.user_id, role); refresh() }
    catch (e) { setMessage(e instanceof Error ? e.message : String(e)) }
  }
  const remove = async (member: MemberEntry): Promise<void> => {
    setMessage('')
    try { await removeMember(projectId, member.user_id); refresh() }
    catch (e) { setMessage(e instanceof Error ? e.message : String(e)) }
  }

  return (
    <section>
      <h4 style={{ fontSize: 12, margin: '14px 0 8px' }}>Members</h4>
      {members.map((m) => (
        <div key={m.user_id} style={row}>
          <span style={{ flex: 1, fontSize: 12 }}>{m.display_name} <small>@{m.username}</small></span>
          {m.role === 'owner' ? <span style={note}>Owner</span> : <>
            <select aria-label={`Role for ${m.username}`} value={m.role}
              onChange={(e) => void updateRole(m, e.target.value as 'editor' | 'viewer')}>
              <option value="editor">Editor</option><option value="viewer">Viewer</option>
            </select>
            <button onClick={() => void remove(m)}>Remove</button>
          </>}
        </div>
      ))}
      {message && <p role="status" style={note}>{message}</p>}
    </section>
  )
}
