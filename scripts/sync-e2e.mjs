// End-to-end check of the Cloud Sync schema against a real Supabase project.
// Usage: SUPABASE_URL=... SUPABASE_ANON_KEY=... node scripts/sync-e2e.mjs
// Needs: schema.sql already run, email/password sign-in enabled, email confirmation disabled.
import { createClient } from '@supabase/supabase-js'
import { randomUUID, createHash } from 'node:crypto'

const { SUPABASE_URL: url, SUPABASE_ANON_KEY: key } = process.env
if (!url || !key) throw new Error('Set SUPABASE_URL and SUPABASE_ANON_KEY (publishable/anon key, not service_role)')
if (key.startsWith('sb_secret_')) throw new Error('Refusing to use a Supabase secret key.')
if (key.split('.').length === 3) {
  try {
    const payload = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString())
    if (payload.role === 'service_role') throw new Error('Refusing to use a service-role key.')
  } catch (error) {
    if (error instanceof Error && error.message.includes('Refusing')) throw error
  }
}

let failed = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — ${extra}`}`)
  if (!ok) failed++
}
const mk = async (username) => {
  const c = createClient(url, key, { auth: { persistSession: false } })
  const password = `Mgn-${randomUUID()}-Aa1!`
  const email = `${username}@magnolia.sync`
  const { data, error } = await c.auth.signUp({ email, password })
  if (error) throw new Error('email/password sign-up: ' + error.message)
  if (!data.session) throw new Error('Sign-up returned no session; disable Supabase email confirmation.')
  const { error: profileError } = await c.rpc('register_profile', {
    p_username: username, p_display_name: `Display ${username}`
  })
  if (profileError) throw new Error('register_profile: ' + profileError.message)
  return c
}
const invite = async (c, project, role, expires, maxUses = null) =>
  c.rpc('create_invite', {
    p_project: project, p_role: role, p_expires_at: expires, p_max_uses: maxUses
  })
const up = (c, p, kind, guid, data, base, deleted = false) =>
  c.rpc('upsert_entity', {
    p_project: p, p_kind: kind, p_guid: guid, p_parent: null, p_data: data,
    p_base_version: base, p_op_id: randomUUID(), p_deleted: deleted
  })

const suffix = randomUUID().replaceAll('-', '').slice(0, 10)
const a = await mk(`owner_${suffix}`)
const b = await mk(`editor1_${suffix}`)
const c = await mk(`editor2_${suffix}`)
const viewer = await mk(`viewer_${suffix}`)
const outsider = await mk(`outsider_${suffix}`)

const { data: pid, error: createError } = await a.rpc('create_project', { p_name: `e2e ${suffix}` })
check('create_project', !createError && !!pid, createError?.message)
const { data: code, error: inviteError } = await invite(a, pid, 'editor', new Date(Date.now() + 7 * 86400_000).toISOString())
check('create multi-use invite', !inviteError && !!code, inviteError?.message)
const { data: joinedB, error: joinBError } = await b.rpc('join_project', { p_code: code })
const { data: joinedC, error: joinCError } = await c.rpc('join_project', { p_code: code })
check('invite is reusable by multiple accounts', joinedB === pid && joinedC === pid, joinBError?.message || joinCError?.message)
const { data: reused } = await b.rpc('join_project', { p_code: code })
check('joining twice is idempotent', reused === pid)

let { data: r, error: insertError } = await up(a, pid, 'code', 'c1', { name: 'X' }, 0)
check('insert entity', !insertError && r?.ok && r.version === 1, insertError?.message ?? JSON.stringify(r))
;({ data: r } = await up(b, pid, 'code', 'c1', { name: 'B' }, 0))
check('stale base rejected with current row', r?.ok === false && r.current?.version === 1, JSON.stringify(r))
;({ data: r } = await up(b, pid, 'code', 'c1', { name: 'B' }, 1))
check('CAS update by member', r?.ok && r.version === 2, JSON.stringify(r))
const op = randomUUID()
const first = await a.rpc('upsert_entity', {
  p_project: pid, p_kind: 'code', p_guid: 'c2', p_parent: null, p_data: {},
  p_base_version: 0, p_op_id: op, p_deleted: false
})
const again = await a.rpc('upsert_entity', {
  p_project: pid, p_kind: 'code', p_guid: 'c2', p_parent: null, p_data: {},
  p_base_version: 0, p_op_id: op, p_deleted: false
})
check('op id idempotent', first.data?.ok && again.data?.ok && again.data.version === 1, JSON.stringify(again.data))

const { data: rows, error: pullError } = await c.from('entities').select('guid,seq')
  .eq('project_id', pid).gt('seq', 0).order('seq')
check('member can pull', !pullError && rows?.length === 2, pullError?.message ?? JSON.stringify(rows))
const { data: hidden } = await outsider.from('entities').select('guid').eq('project_id', pid)
check('non-member sees nothing (RLS)', (hidden ?? []).length === 0)
const nonMemberWrite = await up(outsider, pid, 'code', 'evil', {}, 0)
check('non-member cannot write', !!nonMemberWrite.error || !nonMemberWrite.data?.ok, nonMemberWrite.error?.message)
const { data: ops } = await a.from('ops').select('id').eq('project_id', pid)
check('ops log written', (ops ?? []).length >= 3)
const { data: namedOps, error: namedOpsError } = await a.from('ops_with_author')
  .select('author_name').eq('project_id', pid).limit(1)
check('activity includes profile display name', !namedOpsError && namedOps?.[0]?.author_name === `Display owner_${suffix}`,
  namedOpsError?.message ?? JSON.stringify(namedOps))

const { data: viewerCode, error: viewerInviteError } = await invite(a, pid, 'viewer', new Date(Date.now() + 3600_000).toISOString())
const { data: viewerProject, error: viewerJoinError } = await viewer.rpc('join_project', { p_code: viewerCode })
check('viewer joins with invite', !viewerInviteError && !viewerJoinError && viewerProject === pid,
  viewerInviteError?.message ?? viewerJoinError?.message)
const viewerWrite = await up(viewer, pid, 'code', 'viewer-write', {}, 0)
check('viewer cannot write', !!viewerWrite.error || !viewerWrite.data?.ok, viewerWrite.error?.message)
const { data: listedMembers, error: membersError } = await a.rpc('list_members', { p_project: pid })
check('owner can list members', !membersError && listedMembers?.length === 4, membersError?.message ?? JSON.stringify(listedMembers))
const { data: myProjects, error: projectsError } = await a.rpc('list_my_projects')
check('account can list its cloud projects', !projectsError && myProjects?.some((p) => p.id === pid),
  projectsError?.message ?? JSON.stringify(myProjects))
const { error: setRoleError } = await a.rpc('set_member_role', {
  p_project: pid, p_user: (await viewer.auth.getUser()).data.user.id, p_role: 'editor'
})
check('owner can change a member role', !setRoleError, setRoleError?.message)

const { data: inviteRows, error: listInviteError } = await a.rpc('list_invites', { p_project: pid })
check('owner can list invites and usage counts', !listInviteError && inviteRows?.length >= 2 &&
  inviteRows.some((i) => i.code === code && Number(i.uses) === 2), listInviteError?.message ?? JSON.stringify(inviteRows))
const { error: revokeError } = await a.rpc('revoke_invite', { p_code: viewerCode })
const { error: revokedJoinError } = await outsider.rpc('join_project', { p_code: viewerCode })
check('revoked invite is rejected', !revokeError && !!revokedJoinError, revokeError?.message ?? 'join unexpectedly succeeded')
const { error: expiredCreateError, data: expiringCode } = await invite(a, pid, 'editor',
  new Date(Date.now() + 5000).toISOString())
if (!expiredCreateError) await new Promise((resolve) => setTimeout(resolve, 6000))
const { error: expiredJoinError } = await outsider.rpc('join_project', { p_code: expiringCode })
check('expired invite is rejected', !expiredCreateError && !!expiredJoinError,
  expiredCreateError?.message ?? 'join unexpectedly succeeded')
const { error: pastExpiryError } = await invite(a, pid, 'editor', new Date(Date.now() - 60_000).toISOString())
check('past expiry is rejected at creation', !!pastExpiryError, 'create_invite unexpectedly succeeded')

const duplicate = createClient(url, key, { auth: { persistSession: false } })
const duplicateSignUp = await duplicate.auth.signUp({
  email: `duplicate_${suffix}@magnolia.sync`, password: `Mgn-${randomUUID()}-Aa1!`
})
let duplicateError = duplicateSignUp.error
if (!duplicateError && duplicateSignUp.data.session) {
  duplicateError = (await duplicate.rpc('register_profile', {
    p_username: `owner_${suffix}`, p_display_name: 'Duplicate'
  })).error
}
check('username uniqueness is enforced', !!duplicateError, duplicateError?.message)

const body = Buffer.from('hello')
const path = `${pid}/${createHash('sha256').update(body).digest('hex')}.txt`
const upl = await a.storage.from('sources').upload(path, body)
check('storage upload by member', !upl.error, upl.error?.message)
const dl = await c.storage.from('sources').download(path)
check('storage download by member', !dl.error, dl.error?.message)
const bad = await outsider.storage.from('sources').download(path)
check('storage blocked for non-member', !!bad.error)

let got = false
const ch = c.channel(`e2e-${suffix}`).on('postgres_changes', {
  event: '*', schema: 'public', table: 'entities', filter: `project_id=eq.${pid}`
}, () => { got = true })
await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('Realtime subscription timed out')), 10_000)
  ch.subscribe((status) => {
    if (status === 'SUBSCRIBED') { clearTimeout(timeout); resolve() }
  })
})
await up(a, pid, 'code', 'c3', {}, 0)
await new Promise((resolve) => setTimeout(resolve, 3000))
check('realtime event received', got)

const { error: removeError } = await a.rpc('remove_member', {
  p_project: pid, p_user: (await b.auth.getUser()).data.user.id
})
const { data: removedMemberRows } = await b.from('entities').select('guid').eq('project_id', pid)
check('removed member loses project access', !removeError && (removedMemberRows ?? []).length === 0,
  removeError?.message ?? JSON.stringify(removedMemberRows))
const { error: ownerRemovalError } = await a.rpc('remove_member', {
  p_project: pid, p_user: (await a.auth.getUser()).data.user.id
})
check('last owner cannot be removed', !!ownerRemovalError, 'last owner was removed')

await a.removeChannel(ch)
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed')
process.exit(failed ? 1 : 0)
