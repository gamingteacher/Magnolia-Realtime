import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { SyncBackend, PushOp, PushResult, RemoteRow } from './engine'

export function createSupabaseClient(url: string, anonKey: string): SupabaseClient {
  return createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      storage: {
        getItem: () => window.api.syncLoadSession(),
        setItem: (_key, value) => window.api.syncSaveSession(value).then(() => undefined),
        removeItem: () => window.api.syncClearSession()
      }
    }
  })
}

/** Backend over the schema in schema.sql. */
export class SupabaseBackend implements SyncBackend {
  constructor(private client: SupabaseClient, private projectId: string) {}

  async upsert(op: PushOp): Promise<PushResult> {
    const { data, error } = await this.client.rpc('upsert_entity', {
      p_project: this.projectId, p_kind: op.kind, p_guid: op.guid, p_parent: op.parentGuid,
      p_data: op.data, p_base_version: op.baseVersion, p_op_id: op.opId, p_deleted: op.deleted
    })
    if (error) throw new Error(error.message)
    return data as PushResult
  }

  async pullSince(seq: number, limit: number): Promise<RemoteRow[]> {
    const { data, error } = await this.client
      .from('entities').select('kind,guid,parent_guid,data,version,deleted,seq')
      .eq('project_id', this.projectId).gt('seq', seq).order('seq').limit(limit)
    if (error) throw new Error(error.message)
    return (data ?? []) as RemoteRow[]
  }

  /** Realtime is only a wake-up signal; callers must respond by pulling. */
  subscribe(onChange: () => void, onStatus?: (s: string) => void): () => void {
    const ch = this.client
      .channel(`entities:${this.projectId}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'entities', filter: `project_id=eq.${this.projectId}` },
        onChange)
      .subscribe((s) => {
        onStatus?.(s)
        if (s === 'SUBSCRIBED') onChange()
      })
    return () => { void this.client.removeChannel(ch) }
  }
}
