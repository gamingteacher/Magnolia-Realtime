// End-to-end check of the Cloud Sync schema against a real Supabase project.
// Usage: SUPABASE_URL=... SUPABASE_ANON_KEY=... node scripts/sync-e2e.mjs
// Needs: schema.sql already run, Anonymous sign-ins enabled. Creates one throwaway project.
import { createClient } from '@supabase/supabase-js'
import { randomUUID, createHash } from 'node:crypto'

const { SUPABASE_URL: url, SUPABASE_ANON_KEY: key } = process.env
if (!url || !key) throw new Error('Set SUPABASE_URL and SUPABASE_ANON_KEY (anon key, not service_role)')
let failed = 0
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : extra}`); if (!ok) failed++ }
const mk = async () => {
  const c = createClient(url, key, { auth: { persistSession: false } })
  const { error } = await c.auth.signInAnonymously()
  if (error) throw new Error('anon sign-in: ' + error.message)
  return c
}
const up = (c, p, kind, guid, data, base, deleted = false) =>
  c.rpc('upsert_entity', { p_project: p, p_kind: kind, p_guid: guid, p_parent: null, p_data: data, p_base_version: base, p_op_id: randomUUID(), p_deleted: deleted })

const a = await mk(), b = await mk(), outsider = await mk()
const { data: pid, error: e1 } = await a.rpc('create_project', { p_name: 'e2e ' + new Date().toISOString() })
check('create_project', !e1 && !!pid, e1?.message)
const { data: code } = await a.rpc('create_invite', { p_project: pid, p_role: 'editor' })
check('create_invite', !!code)
const { data: joined, error: e2 } = await b.rpc('join_project', { p_code: code, p_display_name: 'B' })
check('join_project', joined === pid, e2?.message)
const { error: reuse } = await outsider.rpc('join_project', { p_code: code })
check('invite is single-use', !!reuse)

let { data: r } = await up(a, pid, 'code', 'c1', { name: 'X' }, 0)
check('insert entity', r?.ok && r.version === 1, JSON.stringify(r))
;({ data: r } = await up(b, pid, 'code', 'c1', { name: 'B' }, 0))
check('stale base rejected with current row', r?.ok === false && r.current?.version === 1, JSON.stringify(r))
;({ data: r } = await up(b, pid, 'code', 'c1', { name: 'B' }, 1))
check('CAS update by member', r?.ok && r.version === 2, JSON.stringify(r))
const op = randomUUID()
const first = await a.rpc('upsert_entity', { p_project: pid, p_kind: 'code', p_guid: 'c2', p_parent: null, p_data: {}, p_base_version: 0, p_op_id: op, p_deleted: false })
const again = await a.rpc('upsert_entity', { p_project: pid, p_kind: 'code', p_guid: 'c2', p_parent: null, p_data: {}, p_base_version: 0, p_op_id: op, p_deleted: false })
check('op id idempotent', first.data?.ok && again.data?.ok && again.data.version === 1, JSON.stringify(again.data))

const { data: rows } = await b.from('entities').select('guid,seq').eq('project_id', pid).gt('seq', 0).order('seq')
check('member can pull', rows?.length === 2, JSON.stringify(rows))
const { data: hidden } = await outsider.from('entities').select('guid').eq('project_id', pid)
check('non-member sees nothing (RLS)', (hidden ?? []).length === 0)
;({ data: r } = await up(outsider, pid, 'code', 'evil', {}, 0))
check('non-member cannot write', !r?.ok)
const { data: ops } = await a.from('ops').select('id').eq('project_id', pid)
check('ops log written', (ops ?? []).length >= 3)

const body = Buffer.from('hello')
const path = `${pid}/${createHash('sha256').update(body).digest('hex')}.txt`
const upl = await a.storage.from('sources').upload(path, body)
check('storage upload by member', !upl.error, upl.error?.message)
const dl = await b.storage.from('sources').download(path)
check('storage download by member', !dl.error, dl.error?.message)
const bad = await outsider.storage.from('sources').download(path)
check('storage blocked for non-member', !!bad.error)

let got = false
const ch = b.channel('e2e').on('postgres_changes', { event: '*', schema: 'public', table: 'entities', filter: `project_id=eq.${pid}` }, () => { got = true })
await new Promise((res) => ch.subscribe((s) => s === 'SUBSCRIBED' && res()))
await up(a, pid, 'code', 'c3', {}, 0)
await new Promise((res) => setTimeout(res, 3000))
check('realtime event received', got)
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed')
process.exit(failed ? 1 : 0)
