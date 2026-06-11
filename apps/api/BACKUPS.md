# Uploads backup (off-site)

**TL;DR:** the Railway Volume protects uploaded files against *redeploys*,
not against deletion, corruption, or a lost volume. The database has Neon
point-in-time recovery; the document blobs (I-9 photos, W-4 PDFs,
signature images, profile photos) had nothing — until this job. It tars
`UPLOAD_ROOT` nightly and streams it to any S3-compatible bucket. It is
**off until configured.**

## Setup (one-time, ~10 minutes)

1. Create a bucket at any S3-compatible provider. Cheapest at our size
   (single-digit GB): **Backblaze B2** (~$0.006/GB·mo) or
   **Cloudflare R2** (free tier 10 GB). Plain AWS S3 also works.
2. Create an access key scoped to that bucket (write + list + delete).
3. On the Railway `alto-people/api` service, add Variables:

   ```
   BACKUP_S3_BUCKET=alto-people-backups
   BACKUP_S3_REGION=us-west-004          # B2: from the bucket page; R2: auto; AWS: the region
   BACKUP_S3_ACCESS_KEY_ID=...
   BACKUP_S3_SECRET_ACCESS_KEY=...
   # Non-AWS providers only:
   BACKUP_S3_ENDPOINT=https://s3.us-west-004.backblazeb2.com
   ```

   Optional tuning: `BACKUP_INTERVAL_HOURS` (default 24),
   `BACKUP_RETENTION_DAYS` (default 30).

4. Redeploy. Boot logs print
   `[backup] uploads backup cron armed (…)`. The first archive lands
   ~5 minutes after boot, then daily:
   `[backup] uploads backed up to uploads-backup/uploads-2026-06-12T03-00.tar.gz`.

Until configured, production boots print a loud
`[backup] WARNING: uploads backup is not configured` — same pattern as
the `UPLOAD_DIR` warning in `storage.ts`.

## Restore

1. Download the newest `uploads-backup/uploads-*.tar.gz` from the bucket.
2. Get a shell on the api service (`railway ssh`) and extract into the
   volume:

   ```
   cd /data/uploads && tar -xzf /tmp/uploads-backup.tar.gz
   ```

   (Upload the tarball first, e.g. `railway ssh` + `curl` from a
   presigned URL, or locally `railway run`.)

3. Nothing else — the archive stores paths relative to `UPLOAD_ROOT`,
   and `DocumentRecord.s3Key` references files by that same relative
   path, so a straight extract puts every blob back where the app
   expects it. `fileAvailable` flips back to true on the next
   serialization.

## What it does NOT cover

- The database — that's Neon PITR (verify your branch's retention in
  the Neon console; the default may be as low as 24h).
- Selfies and face templates — those live in Postgres, covered by Neon.
- Point-in-time file recovery between nightly runs: a file uploaded and
  deleted the same day may miss the window. Acceptable at current scale;
  shrink `BACKUP_INTERVAL_HOURS` if that ever stops being true.
