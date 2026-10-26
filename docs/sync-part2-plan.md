# Magnolia Sync — Part 2 (accounts, invites, splash entry, setup docs)

Self-contained: a new chat can start from this file alone. Part 1 (core sync) is implemented and verified; see "State of the code".

## Feedback to address
1. **Name + password accounts**, independent of invites: a person must be able to create an account/log in even if nobody has invited them yet (or nobody can reach the invite). Changes must show the author's name (hook `project_members.display_name`).
2. **Invites**: owner picks role (editor/viewer) and an expiry timestamp. The code is **multi-use until it expires** (no longer single-use), shows created/expires time, can be revoked. After entering a code, the new user is prompted to **create account / log in with username+password**, then joins.
3. **Manual**: clear step-by-step Supabase database setup instructions.
4. **Splash screen button** "Sign in / Sync a project" so one can configure keys, log in, join or open a cloud project **without first creating a local project**.

## State of the code (Part 1, done)
- Schema: `src/renderer/sync/schema.sql` (idempotent). Tables `projects, project_members(project_id,user_id,role,display_name), project_invites(code,project_id,role,expires_at,used_by), entities(project_id,kind,guid,parent_guid,data,version,deleted,updated_by,updated_at,seq), ops(id,project_id,seq,kind,guid,op,patch,base_version,author,created_at)`; RPCs `is_member, upsert_entity, create_project, create_invite, join_project`; RLS by membership; private storage bucket `sources`; realtime on `entities`. Verified live with `scripts/sync-e2e.mjs` (16/16; `SUPABASE_URL=… SUPABASE_ANON_KEY=… node scripts/sync-e2e.mjs`).
- Main process: `src/main/sync-credentials.ts` (safeStorage-encrypted `{url, anonKey}` in userData `magnolia-sync.enc`; accepts JWT anon keys and `sb_publishable_…`, rejects `service_role`/`sb_secret_`; IPC `sync:getConfig/getKeys/setConfig/clearConfig/testConnection/loadState/saveState/deleteState/uploadBinary/downloadBinary`). Exposed in `src/preload/index.ts` and `ElectronAPI` in `src/renderer/models/types.ts`.
- Renderer `src/renderer/sync/`: `entity-map.ts` (project⇄entities), `engine.ts` (SyncEngine: outbox, CAS push, pull, merge, conflicts, snapshot/restore, keepMine, revertLocal), `text-merge.ts`, `rebase.ts`, `store-bridge.ts` (apply remote to zustand stores, observe local changes, binaries), `supabase-backend.ts`, `session.ts` (`signIn` (anonymous or email OTP), `createCloudProject`, `createInvite`, `joinWithCode`, `joinAndConnect` (empty project adopts, else Merge review), `startSync/stopSync`, presence, `fetchActivity`, `initSyncAutoconnect`, `resolveConflict`, `syncNow`), `sync-store.ts` (status/role/pending/conflicts/presence), `SyncStatusBadge.tsx` (mounted in `App.tsx`).
- UI: `src/renderer/components/Preferences/CloudSyncSettings.tsx` (tab "Cloud Sync" in `PreferencesWindow.tsx`). Today login = **anonymous sign-in** (`signIn()` in session.ts) — this is what must be replaced.
- Splash: separate Electron window. `src/renderer/components/Welcome/WelcomeScreen.tsx` (entry `welcome-entry.tsx`, window created in `src/main/index.ts` ~line 184); buttons call `window.api.sendWelcomeAction('open-project' | 'new-project' | 'open-recent:<path>' | 'quit' | 'sponsor')`, handled in main `index.ts`. The sync engine runs in the **main window renderer**, not the splash window.
- Manual: VitePress in `manual/`; sidebar in `manual/.vitepress/config.mjs` (add one `page('Title','/guide/x')` line). Existing `manual/guide/sync.md` is a short stub.
- Tests: vitest (`npx vitest run`), files `test/renderer/entity-map.test.ts`, `sync-engine.test.ts`, `sync-rebase.test.ts`. Build check: `npx electron-vite build`. `npx tsc --noEmit -p tsconfig.web.json` has pre-existing unrelated errors (DocumentViewer etc.); only look at sync-related ones.
- `npm run dev` could not be verified in the agent sandbox (GPU process failure); run it on the user's machine. The Electron binary was installed via `node node_modules/electron/install.js`.
- Constraints: never store/accept service-role/secret keys; secrets only via main-process safeStorage; keep local-first behaviour when sync is off.

## Design

### A. Accounts (username + password, independent of projects)
- Supabase Auth email/password is the engine, with a **synthetic email** derived from the username: `<username-lowercase>@magnolia.sync` (alternatively the user may supply a real email, optional, enabling recovery). Account creation needs **no invite**.
- **Spike first (Ch.1)**: confirm against the real project that `signUp` with a synthetic address works. Needs Supabase setting *Authentication → Providers → Email: "Confirm email" OFF* (document it). If the hosted service rejects the synthetic domain, fall back to: ask for real email + username; keep username in `profiles`.
- New table `profiles(user_id uuid pk references auth.users, username text unique check (username ~ '^[a-z0-9_.-]{3,32}$'), display_name text, created_at)`; RLS: authenticated users can read profiles of people sharing a project; a user can update own display_name. Created by RPC `register_profile(p_username, p_display_name)` (SECURITY DEFINER, called right after signUp); username uniqueness enforced there with a clear "username taken" error.
- `project_members.display_name` is kept in sync from `profiles.display_name` (set at join and on rename via RPC `update_display_name`). Author attribution: view `ops_with_author` joining `ops.author → profiles`; `entities.updated_by → profiles`. Map the logged-in user to the project `User` entry (`users[]`, `creatingUser`/`modifyingUser` guids) so codings show the real name (see `store-bridge.ts`, `project-store.ts`).
- Remove anonymous sign-in from the app (no `signInAnonymously` in `session.ts`; docs say turn Anonymous sign-ins OFF). `scripts/sync-e2e.mjs` must be updated to use email/password users.
- Session persistence: store the Supabase session in the main process via safeStorage (new IPC `sync:saveSession/loadSession/clearSession`) with a custom supabase `auth.storage` adapter, so login survives restarts without plaintext tokens.
- Password reset without email is impossible → document it (keep your password; optional real email enables reset).

### B. Invites
- `project_invites` changes (re-runnable): add `created_at timestamptz default now()`, `created_by uuid`, `revoked bool default false`, `max_uses int null`; **drop single-use**: `join_project` no longer sets `used_by`; instead insert into new `project_invite_uses(code, user_id, joined_at)`; valid while `now() < expires_at and not revoked and (max_uses is null or uses < max_uses)`.
- `create_invite(p_project, p_role, p_expires_at timestamptz, p_max_uses int default null)` — owner only; expiry required, in the future, capped (e.g. 90 days). Drop the old 2-arg function. `revoke_invite(code)`; `list_invites(p_project)` (owner: code, role, created_at, expires_at, uses, revoked).
- `join_project(p_code)` requires an authenticated **account**, uses profile display name, is idempotent if already a member (never downgrades/changes an existing role).
- Owner can list members and change role / remove a member: RPCs `list_members`, `set_member_role(p_project, p_user, p_role)`, `remove_member(p_project, p_user)` (owner only; cannot remove the last owner). Removed members lose access automatically (RLS is membership-based).
- Invite UI (owner): role dropdown (editor/viewer), `datetime-local` expiry (default +7 days), optional max uses, create → code + copy; active invites list with revoke; members list with role change/remove.
- Join flow: enter code → if not logged in show **Create account / Log in** (username, password, display name for new accounts) → join → existing `joinAndConnect` (empty local project adopts; otherwise Merge review).

### C. Splash screen entry ("Sign in / Sync a project")
- Add a third action button to `WelcomeScreen.tsx`: **"Sign in / Sync…"** opening a modal in the splash window (`components/Welcome/CloudConnectDialog.tsx`), steps: (1) server URL + publishable key (reuse `sync:setConfig`/`testConnection`, with a "Where do I find this?" link to the manual), (2) log in or create account, (3) choose **My cloud projects** (RPC `list_my_projects()` → id, name, role), **Join with invite code**, or **Log out / change server**.
- The engine lives in the main-window renderer, so the splash must not run sync itself. Choosing a cloud project sends a new welcome action `cloud-open:<projectId>` (extend the type/handler in `src/main/index.ts`, `preload`, `ElectronAPI`): main opens a new empty project window (same path as `new-project`) with a pending connect request that the main-window renderer consumes on startup (`sync/pending-connect.ts` + IPC `sync:takePendingConnect`) and calls `startSync(projectId)`; the empty local project adopts the cloud data. Session/credentials are shared via the main-process safeStorage store.
- Preferences → Cloud Sync reuses the same components (`AccountPanel`, `InvitePanel`, `MembersPanel`, `ProjectPicker`). Show the logged-in username in `SyncStatusBadge`.

### D. Documentation
- Rewrite `manual/guide/sync.md` into a full guide and add the sidebar entry in `manual/.vitepress/config.mjs`. Sections: what it is / privacy (data only in your Supabase); **step-by-step Supabase setup** (create free project; copy Project URL and publishable/anon key from Settings → API Keys; Authentication → Providers → Email enabled, **Confirm email OFF**, Anonymous sign-ins OFF; SQL Editor → paste `schema.sql` (also via "Copy setup SQL" button) → Run; verify with Test connection; storage bucket `sources` is created by the SQL); first use (splash button, create account, upload project, create invite with role + expiry); joining with an invite; roles; limits (free tier: 50 MB per file, 500 MB database, projects pause after 7 days idle); troubleshooting (invalid API key, "relation does not exist" → schema not run, RLS errors, expired invite, username taken, lost password); security notes (never use secret/service-role key; the publishable key is safe to share, access is gated by accounts + membership).
- Update `CHANGELOG.md` (Unreleased → Cloud Sync).

## Chapters (each = a self-contained prompt for a local/free LLM; paste only the files named)
Prepend to every prompt: *"Project: Magnolia (Electron, React 18, zustand, TypeScript, vitest). Cloud Sync via user-owned Supabase already exists in src/renderer/sync/ and src/main/sync-credentials.ts. Keep local-first behaviour when sync is off. Never accept service-role/secret keys. Secrets only in main process via safeStorage. Output only code/diffs. Comment sparingly."*

1. **Auth spike**: in `scripts/sync-e2e.mjs` add a step that `signUp({email:'<rand>@magnolia.sync', password})` against the real project and `signInWithPassword`; report the result and decide synthetic-email vs real-email. (Files: scripts/sync-e2e.mjs.)
2. **Schema migration** (`schema.sql`, idempotent `add column if not exists`, `create or replace`): `profiles`, `register_profile`, `update_display_name`, invite columns + `project_invite_uses`, new `create_invite/revoke_invite/list_invites/join_project`, `list_my_projects`, `list_members`, `set_member_role`, `remove_member`, view `ops_with_author`, RLS for all. Must not break existing rows/functions (drop the old 2-arg `create_invite` explicitly). Update the e2e script to the new RPCs and add checks: multi-use invite, expired rejected, revoked rejected, viewer cannot write, removed member loses access, username uniqueness.
3. **Main: session storage IPC** (`sync-credentials.ts`, preload, `ElectronAPI`): `sync:saveSession/loadSession/clearSession` with safeStorage; supabase `auth.storage` adapter in `sync/supabase-backend.ts`/`session.ts`.
4. **Auth module** `sync/auth.ts`: `signUp(username,password,displayName)`, `logIn`, `logOut`, `currentUser()`, username→email mapping + validation, friendly error messages; remove anonymous sign-in from `session.ts`; add `account` to `sync-store.ts`. Unit-test username validation/mapping.
5. **Invite/member API** (`session.ts` or `sync/invites.ts`): `createInvite(projectId, role, expiresAt, maxUses?)`, `listInvites`, `revokeInvite`, `listMembers`, `setMemberRole`, `removeMember`, `listMyProjects`, `joinWithCode` over the new RPCs.
6. **Shared UI** `components/Sync/AccountPanel.tsx`, `InvitePanel.tsx`, `MembersPanel.tsx`, `ProjectPicker.tsx`; refactor `CloudSyncSettings.tsx` to use them (server config → account → project actions).
7. **Author names**: map logged-in profile → project `User` guid on join/start; show author names in the activity list (`ops_with_author`) and wherever coding authors are shown; keep `project_members.display_name` updated.
8. **Splash**: `CloudConnectDialog.tsx` + button in `WelcomeScreen.tsx`; welcome action `cloud-open:<projectId>`; main handler opens a new project window with the pending connect; `sync/pending-connect.ts` consumed at main-window startup; IPC `sync:takePendingConnect`.
9. **Docs**: rewrite `manual/guide/sync.md`, add sidebar line, CHANGELOG.
10. **Verification**: `npx vitest run`, `npx electron-vite build`, `node scripts/sync-e2e.mjs` (user supplies URL + publishable key and re-runs `schema.sql` in the Supabase SQL editor — the publishable key cannot apply admin SQL), then manual two-instance test: splash → sign up → upload → invite (viewer, +1h) → second account joins with code → edit → names appear → expired invite rejected.

## Order / dependencies
1 → 2 → (3, 5) → 4 → 6 → 7; 8 depends on 4, 5, 6; 9 after 8; 10 last. Chapters 3 and 5 are independent of each other.

## Notes / risks
- Synthetic emails depend on Supabase accepting the domain and "Confirm email" being OFF; the spike decides.
- Free-tier projects pause when idle; show a clear error on connection failure.
- Part-1 projects used anonymous users: those users must create accounts and be re-invited (feature unreleased, acceptable).
- The test project `https://kxeaknoybkifsnwnhroh.supabase.co` is disposable. Never use service/secret keys.
