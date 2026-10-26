# Cloud Sync (experimental)

Magnolia works fully offline by default. Cloud Sync is optional and sends data only to a Supabase project that you own.

1. Create a Supabase project and enable **Anonymous sign-ins** (Authentication → Providers) or use email sign-in.
2. In **Preferences → Cloud Sync**, click **Copy setup SQL** and run it once in the Supabase SQL editor.
3. Enter the project URL and the **anon/public** key. Never use the service-role key; Magnolia refuses it.
4. Open your project and click **Upload and share this project**. Send the invite code to collaborators, who enter it under **Join**.

Changes sync automatically. When two people edit the same field of an item, the remote version is kept and the conflict is listed in the Cloud Sync tab. Edits to different parts of a document's text are merged. The not-yet-synced items are kept in a queue while you are offline.

Imported media (PDF, image, audio, video) is uploaded to your Supabase Storage (up to 200 MB per file; the free tier allows 50 MB) and downloaded on demand by collaborators. Viewers see the project read-only. Click the cloud badge at the bottom right for status, pending changes, and to resolve conflicts (keep mine / take theirs).
