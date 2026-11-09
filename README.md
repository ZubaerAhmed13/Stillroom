# Stillroom

Stillroom is a local, invitation-only photo and video library. The owner manages the collection and can share it with up to ten guests. Guests sign in to browse and play shared media.

## Start locally

1. Install Node.js 24 or newer and open a terminal in this folder.
2. Copy `.env.example` to `.env` if you want to choose the first owner's email and password.
3. Run `npm start`.
4. Open [http://127.0.0.1:4321](http://127.0.0.1:4321). If you skipped the optional configuration, use `owner@stillroom.test` and the generated password printed on first launch. Save that password somewhere safe. Editing the configuration after first launch does not change an existing owner account.

The app uses built-in Node.js modules, SQLite, and local files. It starts with an empty collection. Run `npm test` to check access, upload recovery, byte-range playback, and backup restoration. Local data goes into `.data/` by default.

## Use the library

- **Discover** opens a shuffled selection. Choose **Videos** or **Photos** to shuffle each type separately. A collection viewer follows the order shown in that collection.
- In the viewer, swipe up for the next item or down for the previous item. On a TV browser, use Down or Up on the remote. Each video plays on repeat until you pause it or move to another item. Photos have a separate queue with an **Auto-next** option that advances every five seconds.
- On a TV or projector, the Watch screen places portrait videos on a cinematic dark stage and shows the title, collection, and large Play/Pause, Sound, Full Screen, Previous, and Next controls in a side panel. The remote's **OK** button controls playback when the player is focused; **Back/Return** leaves the viewer. On phones, the controls move below the video and vertical swipe navigation still works. Fullscreen and autoplay with sound depend on the browser's capabilities.
- In **Library**, browse the date grid or search by title, description, or filename. The viewer also supports Previous and Next buttons and the left and right arrow keys.
- The owner can create and rename **Collections**. To change a title or description, or to move an item to a collection, open the item and choose **Details → Edit details**. Each item can be in one collection. Guests can browse shared collections and read descriptions.
- The owner can tap the heart in the viewer to add or remove a media item from **Library → Favourites**. This list is private to the owner.
- The owner can choose **Upload** in Library or **Manage → Uploads**. The queue shows progress per file. Choose the same file again to resume an interrupted upload after a reload or restart. **Manage** also opens storage, guest invitations, and Trash.
- In **Invitations**, create and copy a single-use link for the guest. Send it privately to the intended person. A link expires in seven days. Pending links and active guests share the ten slots. Revoking access invalidates the guest's local session.
- In **Trash**, restore an item or delete its original file. Items in Trash still use storage until you permanently delete them.
- Supported formats are JPG, PNG, WebP, GIF, MP4 and WebM, with a 4 GiB limit per file. Video playback depends on the browser's codec support. MOV and HEIC files need conversion before upload.

## Free-tier protection

The owner can see available storage in **Library** and in the upload dialog. Stillroom uses a fixed **9 GB** ceiling and reserves the full size of each new upload before accepting any bytes. Completed files, Trash, and unfinished reservations all count. Cancel an unfinished upload or permanently delete a trashed file to free space. The backup restore command also respects the limit.

The meter measures this Stillroom library. When connecting R2, keep the bucket on Standard storage and route all writes through the server-side admission check. Cloudflare's free allowance applies at the account level. Other buckets, direct writes, and request charges are tracked separately in Cloudflare billing.

## Back up and restore

Stop the local app before exporting or restoring its data. Use a separate disk or location for important originals.

```sh
npm run backup -- export /path/to/new-backup-folder
npm run backup -- restore /path/to/existing-backup-folder
```

The backup includes the originals currently in the library, their titles and descriptions, collection assignments, and the owner's favourites. Start the app after restoring to browse the recovered collection. Older media backups still restore. Owner credentials and guest invitations are managed separately from this media backup.

### Back up the hosted library

Run this from the Stillroom checkout in an interactive terminal on a computer with Node.js 24 or newer. The command keeps your owner email and password hidden as you enter them.

```sh
npm run backup -- export-hosted /path/to/new-backup-folder
```

Choose a new folder on a drive you control. The export downloads each original in the active library, records its SHA-256 checksum, and saves the catalog with collections, descriptions, and favourites. Items in Trash can be restored to the active library before export. The download uses the normal authenticated, metered R2 read path.

To verify the backup, set `STILLROOM_DATA_DIR` to a new local directory and restore into it. Start the local app with the same data directory. Set local owner credentials before first launch as described in [Start locally](#start-locally), or use the password printed at first launch.

```sh
STILLROOM_DATA_DIR=/path/to/new-restore-folder npm run backup -- restore /path/to/backup-folder
STILLROOM_DATA_DIR=/path/to/new-restore-folder npm start
```

The restore verifies every original's size, format, and checksum before making the new library available. Keep the backup folder intact so the catalog and originals stay together. Credentials and invitation links are managed separately.

## Hosted sign-in preview

The [Stillroom preview](https://stillroom-pilot.zubaerahmed13.workers.dev/) supports owner setup, password sign-in, shared collections, and guest invitations and revocation. The owner activates their account through a one-use setup link. Returning guests use their existing hosted password when redeeming a fresh invitation.

The Cloudflare Worker serves the same interface as the local app. Supabase Auth checks passwords. Postgres stores membership and checks each Stillroom session against the current invitation status. The bridge shared key belongs in a Worker secret, with its SHA-256 digest registered in the database and configured in the Supabase Edge Function. The Supabase service role key stays in the Edge Function. Use a dedicated Supabase project because the enrollment trigger enforces invitation-only creation on its Auth user table.

Run `node hosted/bundle.mjs` to prepare the Worker modules and `npm test` for local tests. The rollback-only check in `supabase/tests/hosted_access.sql` requires an empty Stillroom project. It covers deferred enrollment, invitation reuse and expiry rules, the guest cap, and revocation.

### Recover hosted owner access

This is a project administrator procedure. Identify the owner in the dedicated Stillroom Supabase project by querying `select id from stillroom_private.members where role = 'owner';`. Confirm the same UUID under Authentication → Users. From a trusted administrator environment, reset that user's password with Supabase Auth's server-only `auth.admin.updateUserById(ownerId, { password })` method. [Supabase Auth admin reference](https://supabase.com/docs/reference/javascript/auth-admin-updateuserbyid)

After the password change, clear the owner's existing Stillroom sessions in the SQL editor. Substitute the verified UUID before running the transaction.

```sql
begin;
select pg_advisory_xact_lock(216401, 1);
delete from stillroom_private.sessions s using stillroom_private.members m
where s.member_id = m.id and m.role = 'owner' and m.id = '<verified-owner-uuid>';
commit;
```

Check that a previous session is denied. Sign in with the replacement password and confirm the existing library and settings are visible.

## Private R2 media pilot

Hosted transfer requires the private Standard R2 bucket as the Worker’s `MEDIA` binding and `STILLROOM_MEDIA_ENABLED=true`. Keep the switch off until the database migration is applied, the account-wide billing settings are checked, and the pilot is ready for synthetic files.

Postgres reserves each file’s full size before the Worker sends a part to R2. Published files, Trash and unfinished uploads share the 9 GB limit. Cleanup releases a reservation only after R2 confirms deletion. The Worker uses 8 MiB parts, and the browser checks the full file before reusing an upload reservation. Playback uses the current Stillroom session for every request, including video seeks.

Manage shows the storage total and the rolling request counters. The caps are 100,000 Class A attempts and 1,000,000 Class B attempts over the previous 32 days, rounded conservatively to the hour. Stillroom tracks calls it initiates. Check account-wide usage separately for other bucket or direct API activity. Run `supabase/tests/private_media.sql` against an empty media catalog with an owner configured to check the ledger with temporary lower caps. The check rolls back its fixtures and does not write to R2.
