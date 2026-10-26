import { entityKey, diffEntities, type SyncEntity } from './entity-map'
import { mergeText } from './text-merge'

export interface RemoteRow {
  kind: SyncEntity['kind']
  guid: string
  parent_guid: string | null
  data: any
  version: number
  deleted: boolean
  seq: number
}

export interface PushOp {
  opId: string
  kind: SyncEntity['kind']
  guid: string
  parentGuid: string | null
  data: any
  deleted: boolean
  baseVersion: number
}

export type PushResult =
  | { ok: true; version: number; seq: number }
  | { ok: false; current: RemoteRow | null }

/** Transport abstraction; the Supabase implementation wraps rpc('upsert_entity') and table select. */
export interface SyncBackend {
  upsert(op: PushOp): Promise<PushResult>
  pullSince(seq: number, limit: number): Promise<RemoteRow[]>
}

export interface SyncConflict {
  kind: SyncEntity['kind']
  guid: string
  mine: any
  theirs: any
  reason: 'field' | 'text' | 'deleted'
}

export interface EngineHooks {
  /** Apply remote entities to the app stores. deleted=true means remove. */
  applyRemote(entities: (SyncEntity & { deleted: boolean })[]): void
  onConflict?(c: SyncConflict): void
  newId(): string
}

export interface Known {
  entity: SyncEntity
  version: number
  deleted?: boolean
}

/** Retry delay in ms: 1s doubling to a 60s cap. */
export function planRetry(attempt: number): number {
  return Math.min(60_000, 1000 * 2 ** Math.max(0, attempt))
}

export interface EngineState {
  lastSeq: number
  outbox: PushOp[]
  known: [string, Known][]
}

const MAX_REBASE = 5

export class SyncEngine {
  /** Last state agreed with the server (base for 3-way merges). */
  private known = new Map<string, Known>()
  private outbox: PushOp[] = []
  lastSeq = 0
  conflicts: SyncConflict[] = []

  constructor(private backend: SyncBackend, private hooks: EngineHooks) {}

  snapshot(): EngineState {
    return { lastSeq: this.lastSeq, outbox: this.outbox, known: [...this.known] }
  }

  restore(st: EngineState): void {
    this.lastSeq = st.lastSeq
    this.outbox = st.outbox
    this.known = new Map(st.known)
  }

  /** Viewer mode: discard local edits by re-applying the server state, deleting anything not on the server. */
  revertLocal(current: SyncEntity[]): void {
    const live = [...this.known.values()].filter((v) => !v.deleted).map((v) => v.entity)
    const liveKeys = new Set(live.map(entityKey))
    const extra = current.filter((e) => !liveKeys.has(entityKey(e)))
    this.outbox = []
    this.hooks.applyRemote([
      ...live.map((e) => ({ ...e, deleted: false })),
      ...extra.map((e) => ({ ...e, deleted: true }))
    ])
  }

  /** Re-queue the user's version of a conflicted item on top of the current server version. */
  keepMine(c: SyncConflict): void {
    const k = entityKey(c)
    const known = this.known.get(k)
    this.outbox = this.outbox.filter((o) => entityKey(o) !== k)
    this.outbox.push({
      opId: this.hooks.newId(), kind: c.kind, guid: c.guid,
      parentGuid: known?.entity.parentGuid ?? null, data: c.mine, deleted: false,
      baseVersion: known?.version ?? 0
    })
    this.conflicts = this.conflicts.filter((x) => x !== c)
  }

  dismissConflict(c: SyncConflict): void {
    this.conflicts = this.conflicts.filter((x) => x !== c)
  }

  get pending(): number {
    return this.outbox.length
  }

  /** Feed the current local state (from projectToEntities). Enqueues changes; coalesces per entity. */
  localChanged(current: SyncEntity[]): void {
    const prev = new Map([...this.known].filter(([, v]) => !v.deleted).map(([k, v]) => [k, v.entity]))
    // Include unsent pending changes in the baseline so repeated calls don't duplicate ops.
    for (const op of this.outbox) {
      const k = entityKey(op)
      if (op.deleted) prev.delete(k)
      else prev.set(k, { kind: op.kind, guid: op.guid, parentGuid: op.parentGuid, data: op.data })
    }
    const { upserts, deletes } = diffEntities(prev, current)
    for (const e of upserts) this.enqueue(e, false)
    for (const e of deletes) this.enqueue(e, true)
  }

  private enqueue(e: SyncEntity, deleted: boolean): void {
    const k = entityKey(e)
    const idx = this.outbox.findIndex((o) => entityKey(o) === k)
    const baseVersion = this.known.get(k)?.version ?? 0
    const op: PushOp = {
      opId: this.hooks.newId(), kind: e.kind, guid: e.guid, parentGuid: e.parentGuid,
      data: e.data, deleted, baseVersion
    }
    if (idx >= 0) this.outbox[idx] = op
    else this.outbox.push(op)
  }

  /** Push queued ops in order. Throws on transport errors, leaving the op queued for retry. */
  async flush(): Promise<void> {
    while (this.outbox.length) {
      const op = this.outbox[0]
      const res = await this.backend.upsert(op)
      if (res.ok) {
        this.outbox.shift()
        this.recordPushed(op, res.version)
        continue
      }
      this.outbox.shift()
      const retry = this.resolve(op, res.current, this.known.get(entityKey(op))?.entity.data)
      if (retry) this.outbox.unshift(retry)
    }
  }

  private recordPushed(op: PushOp, version: number): void {
    const k = entityKey(op)
    this.known.set(k, {
      entity: { kind: op.kind, guid: op.guid, parentGuid: op.parentGuid, data: op.data },
      version,
      deleted: op.deleted
    })
  }

  /** Returns a rebased op to retry, or null when remote wins. */
  private resolve(op: PushOp, current: RemoteRow | null, base: any): PushOp | null {
    const k = entityKey(op)
    const conflict = (reason: SyncConflict['reason'], theirs: any): null => {
      const c = { kind: op.kind, guid: op.guid, mine: op.data, theirs, reason }
      this.conflicts.push(c)
      this.hooks.onConflict?.(c)
      if (current) this.acceptRemote(current)
      return null
    }
    if (!current) return conflict('deleted', null)
    if (current.deleted) return conflict('deleted', null)
    if (op.deleted) return conflict('deleted', current.data)

    let merged: any
    if (op.kind === 'source_text') {
      const r = mergeText(base?.text ?? '', op.data.text, current.data.text)
      if (!r.ok) return conflict('text', current.data)
      merged = { text: r.text }
    } else {
      merged = { ...current.data }
      for (const f of new Set([...Object.keys(op.data), ...Object.keys(base ?? {})])) {
        const mine = JSON.stringify(op.data[f])
        const orig = JSON.stringify(base?.[f])
        if (mine === orig) continue
        if (JSON.stringify(current.data[f]) !== orig && JSON.stringify(current.data[f]) !== mine) {
          return conflict('field', current.data)
        }
        if (op.data[f] === undefined) delete merged[f]
        else merged[f] = op.data[f]
      }
    }
    // Adopt the server version as the new base, then retry on top of it.
    this.known.set(k, {
      entity: { kind: current.kind, guid: current.guid, parentGuid: current.parent_guid, data: current.data },
      version: current.version
    })
    this.hooks.applyRemote([{ kind: current.kind, guid: current.guid, parentGuid: current.parent_guid, data: merged, deleted: false }])
    this.rebaseCount.set(k, (this.rebaseCount.get(k) ?? 0) + 1)
    if ((this.rebaseCount.get(k) ?? 0) > MAX_REBASE) return conflict('field', current.data)
    return { ...op, opId: this.hooks.newId(), data: merged, parentGuid: op.parentGuid, baseVersion: current.version }
  }
  private rebaseCount = new Map<string, number>()

  private acceptRemote(row: RemoteRow): void {
    this.known.set(entityKey(row), {
      entity: { kind: row.kind, guid: row.guid, parentGuid: row.parent_guid, data: row.data },
      version: row.version,
      deleted: row.deleted
    })
    this.hooks.applyRemote([{ kind: row.kind, guid: row.guid, parentGuid: row.parent_guid, data: row.data, deleted: row.deleted }])
  }

  /** Catch up from lastSeq. Safe to call on any realtime wake-up, reconnect, or timer. */
  async pull(): Promise<number> {
    let total = 0
    for (;;) {
      const rows = await this.backend.pullSince(this.lastSeq, 500)
      if (!rows.length) return total
      const fresh: (SyncEntity & { deleted: boolean })[] = []
      for (const r of rows) {
        this.lastSeq = Math.max(this.lastSeq, r.seq)
        const k = entityKey(r)
        if ((this.known.get(k)?.version ?? 0) >= r.version) continue
        const pendingIdx = this.outbox.findIndex((o) => entityKey(o) === k)
        const baseData = this.known.get(k)?.entity.data
        this.known.set(k, {
          entity: { kind: r.kind, guid: r.guid, parentGuid: r.parent_guid, data: r.data },
          version: r.version,
          deleted: r.deleted
        })
        if (pendingIdx >= 0) {
          // Local unsent edit on top of a newer remote: rebase it on the new base now.
          const op = this.outbox[pendingIdx]
          const retry = this.resolve(op, r, baseData)
          if (retry) this.outbox[pendingIdx] = retry
          else this.outbox.splice(pendingIdx, 1)
          continue
        }
        fresh.push({ kind: r.kind, guid: r.guid, parentGuid: r.parent_guid, data: r.data, deleted: r.deleted })
        total++
      }
      if (fresh.length) this.hooks.applyRemote(fresh)
    }
  }
}
