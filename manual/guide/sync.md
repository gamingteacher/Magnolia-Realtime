# Cloud Sync

Cloud Sync lets collaborators work on a Magnolia project through a Supabase backend that you own. It is optional: Magnolia remains fully usable offline, and local project files continue to work when sync is disconnected.

## Privacy and where data is stored

Project content, account profiles, membership, activity and uploaded media are stored in the Supabase project you configure. Magnolia does not send this project data to a Magnolia-operated cloud service. Supabase access is protected by account sign-in, project membership, and database row-level security (RLS). Members with access to a project can read its shared content; editors can change it, while viewers are read-only.

## Set up Supabase

1. Create a Supabase account and a new project at [supabase.com](https://supabase.com/). The free plan is sufficient for trying Cloud Sync.
2. In the Supabase project, open **Project Settings → API**. Copy the **Project URL** and the **publishable key** (or legacy **anon/public** key). Never copy the secret or `service_role` key into Magnolia.
3. Open **Authentication → Providers → Email**. Enable email/password sign-in and turn **Confirm email** off. Magnolia maps usernames to synthetic addresses ending in `@magnolia.sync`, so no email is sent. Turn **Anonymous sign-ins** off; Magnolia uses named accounts.
4. In Magnolia, open **Preferences → Cloud Sync** (or choose **Sign in / Sync…** on the welcome screen). Enter the Project URL and publishable/anon key, then choose **Save / test connection**.
5. In Magnolia, select **Copy setup SQL**. In Supabase, open **SQL Editor**, create a query, paste the SQL, and run it. This creates the tables, access policies, database functions, realtime configuration and private `sources` storage bucket used by Magnolia. If you update Magnolia later and its setup SQL changes, run the new SQL again; it is designed to be re-runnable.
6. Return to Magnolia and test the connection again. A successful connection only checks the Supabase API; the setup SQL must also have been run before account and project actions can work.

## Create an account and share a project

1. In **Preferences → Cloud Sync** or **Sign in / Sync…**, choose **Create account**. Enter a username, password and display name. Usernames are 3–32 lowercase letters, numbers, dots, underscores or hyphens. You can create an account without an invite.
2. To upload the open local project, choose **Upload and share this project**. Magnolia creates its cloud project and copies the first editor invite to the clipboard.
3. To invite someone later, use the **Invites** controls for the connected project. Choose **Editor** or **Viewer**, set an expiry time (up to 90 days), and optionally set a maximum number of uses. Copy the generated code and share it with collaborators. An invite can be used by multiple accounts until it expires, reaches its use limit, or is revoked.
4. The owner can review invite creation/expiry times and use counts, revoke an invite, change a member's editor/viewer role, or remove a member.

Projects created with the earlier anonymous-only Sync preview are not automatically converted to named accounts. For those unreleased test projects, create a new cloud project from the local project and invite the named accounts.

## Join or open a cloud project

1. On the welcome screen, choose **Sign in / Sync…**. Configure your Supabase URL/key if needed, then create an account or log in.
2. Select a project under **My cloud projects**, or enter an invite code and choose **Join with code**.
3. Magnolia opens the selected cloud project in a new empty window and downloads its content. You do not need to create or open a local project first.
4. If you enter an invite from Preferences while a project is already open, an empty local project adopts the cloud project. If the local project already has content, Magnolia opens a Merge review so you can choose what to keep before syncing.

## Roles

- **Owner**: manage invites and members, and read and edit project content.
- **Editor**: read and edit project content.
- **Viewer**: read project content; local edits are not uploaded.

Changes sync while online and queue for retry when disconnected. Magnolia merges compatible text edits and reports conflicts in the sync controls. The activity list attributes changes to the account's display name.

## Limits

Supabase limits depend on your plan and project settings. On the free plan, storage uploads are typically limited to **50 MB per file**, the database quota is **500 MB**, and projects may pause after **7 days of inactivity**. Magnolia's own per-file sync limit is 200 MB, but the Supabase project limit applies first. Check your Supabase dashboard for current quotas and usage.

## Troubleshooting

- **Invalid API key**: check that the URL and publishable/anon key belong to the same Supabase project. Do not use a secret or service-role key.
- **“Relation does not exist”**: run the complete setup SQL from **Copy setup SQL** in the Supabase SQL Editor.
- **RLS / permission error**: verify that the account is signed in, is a member of this project, and the schema setup completed successfully.
- **Invite expired, revoked or at its use limit**: ask the owner to create a fresh invite.
- **Username taken**: choose another username; usernames are unique within that Supabase project.
- **Forgotten password**: Magnolia's synthetic username account has no recovery email, so its password cannot be reset. Keep it safe. A future account recovery requires an email-based account flow.
- **Connection error**: verify the project URL and key and check whether Supabase has paused the project due to inactivity.

## Security notes

Never use a Supabase **secret** or **service-role** key in Magnolia. Magnolia rejects these keys and stores the accepted URL/key in the operating system's secure storage. Account sessions are encrypted there too. The publishable/anon key is intended to be present in client applications; it is not an administrator credential. Database access is restricted by authenticated account membership and RLS.
