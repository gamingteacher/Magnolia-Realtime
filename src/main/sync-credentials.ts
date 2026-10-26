import { app, ipcMain, safeStorage } from 'electron'
import { join } from 'path'
import { createHash } from 'crypto'
import { putOverlay, resolveHandle } from './binary-store'
import { existsSync } from 'fs'
import { readFile, writeFile, unlink } from 'fs/promises'

interface SyncConfig {
  url: string
  anonKey: string
}

const file = (): string => join(app.getPath('userData'), 'magnolia-sync.enc')

export function validateConfig(url: string, anonKey: string): string | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return 'Invalid URL'
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) return 'URL must use https'
  if (anonKey.startsWith('sb_secret_')) {
    return 'Secret keys must never be used in Magnolia. Use the publishable (anon) key.'
  }
  if (anonKey.startsWith('sb_publishable_')) return null
  const parts = anonKey.split('.')
  if (parts.length !== 3) return 'Key is not a Supabase publishable/anon key'
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'))
    if (payload.role === 'service_role') {
      return 'Service-role keys must never be used in Magnolia. Use the anon/public key.'
    }
  } catch {
    return 'Key is not a Supabase publishable/anon key'
  }
  return null
}

const MAX_UPLOAD = 200 * 1024 * 1024

async function storage(path: string, token: string, init: RequestInit): Promise<Response> {
  const c = await load()
  if (!c) throw new Error('Not configured')
  return fetch(`${c.url.replace(/\/$/, '')}/storage/v1/object/${path}`, {
    ...init,
    headers: { apikey: c.anonKey, Authorization: `Bearer ${token}`, ...(init.headers ?? {}) }
  })
}

async function load(): Promise<SyncConfig | null> {
  if (!existsSync(file()) || !safeStorage.isEncryptionAvailable()) return null
  try {
    return JSON.parse(safeStorage.decryptString(await readFile(file())))
  } catch {
    return null
  }
}

const stateFile = (key: string): string =>
  join(app.getPath('userData'), `magnolia-sync-state-${createHash('sha256').update(key).digest('hex').slice(0, 24)}.json`)

export function registerSyncCredentialHandlers(): void {
  // Per-project sync state (project link, outbox, last seq). Contains project data, so keep it local only.
  ipcMain.handle('sync:loadState', async (_e, key: string) => {
    try {
      return JSON.parse(await readFile(stateFile(key), 'utf-8'))
    } catch {
      return null
    }
  })
  ipcMain.handle('sync:saveState', async (_e, key: string, state: unknown) => {
    await writeFile(stateFile(key), JSON.stringify(state))
    return true
  })
  ipcMain.handle('sync:deleteState', async (_e, key: string) => {
    if (existsSync(stateFile(key))) await unlink(stateFile(key))
    return true
  })
  ipcMain.handle('sync:uploadBinary', async (_e, token: string, projectId: string, handle: string, ext: string) => {
    const buf = await resolveHandle(handle)
    if (!buf) return { ok: false, error: 'Binary not found' }
    if (buf.length > MAX_UPLOAD) return { ok: false, error: 'File exceeds the 200 MB sync limit' }
    const sha256 = createHash('sha256').update(buf).digest('hex')
    const path = `sources/${projectId}/${sha256}.${ext}`
    const head = await storage(`authenticated/${path}`, token, { method: 'HEAD' })
    if (!head.ok) {
      const res = await storage(path, token, {
        method: 'POST', body: new Uint8Array(buf), headers: { 'Content-Type': 'application/octet-stream' }
      })
      if (!res.ok && res.status !== 409) return { ok: false, error: `Upload failed (HTTP ${res.status})` }
    }
    return { ok: true, sha256, size: buf.length }
  })
  ipcMain.handle('sync:downloadBinary', async (_e, token: string, projectId: string, sha256: string, ext: string) => {
    const res = await storage(`authenticated/sources/${projectId}/${sha256}.${ext}`, token, { method: 'GET' })
    if (!res.ok) return { ok: false, error: `Download failed (HTTP ${res.status})` }
    const buf = Buffer.from(await res.arrayBuffer())
    if (createHash('sha256').update(buf).digest('hex') !== sha256) return { ok: false, error: 'Checksum mismatch' }
    return { ok: true, handle: putOverlay(buf, ext) }
  })
  ipcMain.handle('sync:getConfig', async () => {
    const c = await load()
    return { url: c?.url ?? '', hasKey: !!c }
  })
  // The key is only handed to renderer code that runs the sync engine.
  ipcMain.handle('sync:getKeys', async () => load())
  ipcMain.handle('sync:setConfig', async (_e, url: string, anonKey: string) => {
    if (!safeStorage.isEncryptionAvailable()) {
      return { ok: false, error: 'OS secure storage is not available' }
    }
    const err = validateConfig(url, anonKey)
    if (err) return { ok: false, error: err }
    await writeFile(file(), safeStorage.encryptString(JSON.stringify({ url, anonKey })))
    return { ok: true }
  })
  ipcMain.handle('sync:clearConfig', async () => {
    if (existsSync(file())) await unlink(file())
    return { ok: true }
  })
  ipcMain.handle('sync:testConnection', async () => {
    const c = await load()
    if (!c) return { ok: false, error: 'Not configured' }
    try {
      const res = await fetch(`${c.url.replace(/\/$/, '')}/rest/v1/`, {
        headers: { apikey: c.anonKey },
        signal: AbortSignal.timeout(5000)
      })
      return res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status}` }
    } catch (e: any) {
      return { ok: false, error: e?.message ?? 'Connection failed' }
    }
  })
}
