import { create } from 'zustand'
import type { SyncConflict } from './engine'
import type { PresenceEntry } from './session'

export type SyncStatus = 'off' | 'connecting' | 'synced' | 'syncing' | 'offline' | 'error'

interface SyncState {
  status: SyncStatus
  projectId: string | null
  role: 'owner' | 'editor' | 'viewer' | null
  pending: number
  lastSyncAt: string | null
  error: string | null
  conflicts: SyncConflict[]
  paused: boolean
  presence: PresenceEntry[]
  set: (patch: Partial<Omit<SyncState, 'set'>>) => void
}

export const useSyncStore = create<SyncState>((set) => ({
  status: 'off',
  projectId: null,
  role: null,
  pending: 0,
  lastSyncAt: null,
  error: null,
  conflicts: [],
  paused: false,
  presence: [],
  set: (patch) => set(patch)
}))

export const isReadOnly = (): boolean => useSyncStore.getState().role === 'viewer'
