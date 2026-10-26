import type { SupabaseClient } from '@supabase/supabase-js'
import { createSupabaseClient } from './supabase-backend'
import { useSyncStore, type SyncAccount } from './sync-store'
import { useProjectStore } from '../stores/project-store'

export type SyncProfile = SyncAccount

let client: SupabaseClient | null = null
let clientConfig = ''

export const usernameEmail = (username: string): string => `${username.trim().toLowerCase()}@magnolia.sync`
export const isValidUsername = (username: string): boolean => /^[a-z0-9_.-]{3,32}$/.test(username)

export async function getAuthClient(): Promise<SupabaseClient> {
  const config = await window.api.syncGetKeys()
  if (!config) throw new Error('Cloud Sync is not configured. Enter your Supabase URL and publishable key first.')
  const signature = `${config.url}\n${config.anonKey}`
  if (!client || signature !== clientConfig) {
    client = createSupabaseClient(config.url, config.anonKey)
    clientConfig = signature
  }
  return client
}

function friendlyAuthError(message: string): string {
  if (/username already taken|duplicate key/i.test(message)) return 'That username is already taken.'
  if (/invalid login credentials/i.test(message)) return 'Incorrect username or password.'
  if (/email.*(invalid|not allowed)|invalid.*email/i.test(message)) {
    return 'This Supabase project rejected Magnolia usernames as email addresses. Enable email/password sign-in and disable email confirmation.'
  }
  if (/email not confirmed/i.test(message)) return 'Email confirmation is enabled. Disable it in Supabase Authentication settings, then try again.'
  return message
}

async function loadProfile(): Promise<SyncProfile | null> {
  const c = await getAuthClient()
  const { data: userData, error: userError } = await c.auth.getUser()
  if (userError) {
    useSyncStore.getState().set({ account: null })
    throw new Error(friendlyAuthError(userError.message))
  }
  if (!userData.user) {
    useSyncStore.getState().set({ account: null })
    return null
  }
  const { data, error } = await c.from('profiles').select('user_id,username,display_name')
    .eq('user_id', userData.user.id).maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) {
    useSyncStore.getState().set({ account: null })
    return null
  }
  const profile: SyncProfile = {
    userId: data.user_id,
    username: data.username,
    displayName: data.display_name
  }
  useSyncStore.getState().set({ account: profile })
  return profile
}

export async function signUp(username: string, password: string, displayName: string): Promise<SyncProfile> {
  const normalized = username.trim().toLowerCase()
  if (!isValidUsername(normalized)) {
    throw new Error('Username must be 3–32 characters: lowercase letters, numbers, dot, underscore, or hyphen.')
  }
  if (password.length < 6) throw new Error('Password must be at least 6 characters.')
  if (!displayName.trim() || displayName.trim().length > 80) throw new Error('Display name must be between 1 and 80 characters.')
  const c = await getAuthClient()
  const { data, error } = await c.auth.signUp({ email: usernameEmail(normalized), password })
  if (error) throw new Error(friendlyAuthError(error.message))
  if (!data.session) {
    throw new Error('Account created but not signed in. Disable email confirmation in Supabase Authentication settings and sign up again.')
  }
  const { error: profileError } = await c.rpc('register_profile', {
    p_username: normalized,
    p_display_name: displayName.trim()
  })
  if (profileError) {
    await c.auth.signOut()
    await window.api.syncClearSession()
    useSyncStore.getState().set({ account: null })
    throw new Error(friendlyAuthError(profileError.message))
  }
  const profile = await loadProfile()
  if (!profile) throw new Error('Account was created, but its profile could not be loaded.')
  return profile
}

export async function logIn(username: string, password: string): Promise<SyncProfile> {
  const normalized = username.trim().toLowerCase()
  if (!isValidUsername(normalized)) throw new Error('Enter a valid username.')
  const { data, error } = await (await getAuthClient()).auth.signInWithPassword({
    email: usernameEmail(normalized), password
  })
  if (error) throw new Error(friendlyAuthError(error.message))
  if (!data.session) throw new Error('Sign-in did not create a session.')
  const profile = await loadProfile()
  if (!profile) {
    await (await getAuthClient()).auth.signOut()
    await window.api.syncClearSession()
    useSyncStore.getState().set({ account: null })
    throw new Error('This account has no Magnolia profile. Contact the project owner.')
  }
  return profile
}

export async function logOut(): Promise<void> {
  const c = await getAuthClient()
  const { error } = await c.auth.signOut()
  await window.api.syncClearSession()
  useSyncStore.getState().set({ account: null })
  if (error) throw new Error(error.message)
}

export async function currentUser(): Promise<SyncProfile | null> {
  const c = await getAuthClient()
  const { data, error } = await c.auth.getSession()
  if (error) throw new Error(friendlyAuthError(error.message))
  if (!data.session) {
    useSyncStore.getState().set({ account: null })
    return null
  }
  return loadProfile()
}

export async function changeDisplayName(displayName: string): Promise<SyncProfile> {
  if (!displayName.trim() || displayName.trim().length > 80) {
    throw new Error('Display name must be between 1 and 80 characters.')
  }
  const { error } = await (await getAuthClient()).rpc('update_display_name', {
    p_display_name: displayName.trim()
  })
  if (error) throw new Error(error.message)
  const profile = await loadProfile()
  if (!profile) throw new Error('Profile could not be loaded after updating the display name.')
  const project = useProjectStore.getState()
  useProjectStore.setState({
    users: project.users.map((user) => user.guid === profile.userId
      ? { ...user, name: profile.displayName }
      : user)
  })
  return profile
}

export function clearAuthClient(): void {
  client = null
  clientConfig = ''
}
