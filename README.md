# Stillroom

Stillroom is a local, invitation-only photo and video library. The owner manages the collection and can share it with up to ten guests. Guests sign in to browse and play shared media.

## Start locally

1. Install Node.js 24 or newer and open a terminal in this folder.
2. Copy `.env.example` to `.env` if you want to choose the first owner's email and password.
3. Run `npm start`.
4. Open [http://127.0.0.1:4321](http://127.0.0.1:4321). If you skipped the optional configuration, use `owner@stillroom.test` and the generated password printed on first launch. Save that password somewhere safe. Editing the configuration after first launch does not change an existing owner account.

The app uses built-in Node.js modules, SQLite, and local files. It starts with an empty collection. Run `npm test` to check access, upload recovery, byte-range playback, and backup restoration. Local data goes into `.data/` by default.

## Use the library

- **Discover** opens a shuffled selection. Choose photos or videos, shuffle again, or open an item and enable **Auto-next** for continuous viewing through the current selection.
- In **Library**, browse the date grid or search by title, description, or filename. Open an item and use Previous, Next, or the arrow keys to move through the selection.
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

Stop the app before running either command. Use a separate disk or location if you are backing up important originals.

```sh
npm run backup -- export /path/to/new-backup-folder
npm run backup -- restore /path/to/existing-backup-folder
```

The backup includes the originals currently in the library, their titles and descriptions, collection assignments, and the owner's favourites. Start the app after restoring to browse the recovered collection. Older media backups still restore. Owner credentials and guest invitations are managed separately from this media backup.

## Cloud integration milestone

The local version uses separate access, catalog, and media storage modules. Connecting the hosted version requires a Supabase project for Auth and Postgres, a private Cloudflare R2 bucket for multipart uploads and media, and the target GitHub repository. Provider credentials belong in environment secrets. After integration, verify invited account access and revocation, direct uploads and video seeking, and recovery with a second account and a physical phone before using the hosted version for private originals.
