# Document storage

**TL;DR:** blob storage is driver-based (`apps/api/src/lib/blobStore.ts`),
selected by `STORAGE_DRIVER`:

- `local` (default) — files on the local filesystem under `UPLOAD_ROOT`
  (`apps/api/uploads/` or `UPLOAD_DIR`). On Railway you MUST mount a Volume
  and point `UPLOAD_DIR` at it, or every upload dies on the next redeploy.
- `s3` — an S3-compatible bucket (AWS S3, Backblaze B2, Cloudflare R2).
  Object keys are exactly the relative keys already stored in
  `DocumentRecord.s3Key`, so switching drivers never rewrites database rows.

## Driver matrix

| | `STORAGE_DRIVER=local` (default) | `STORAGE_DRIVER=s3` |
|---|---|---|
| Blob location | `UPLOAD_ROOT` on disk (`UPLOAD_DIR` or `apps/api/uploads/`) | `s3://$STORAGE_S3_BUCKET/[$STORAGE_S3_PREFIX/]<s3Key>` |
| Survives redeploy | Only with a mounted Volume | Yes |
| Multi-replica safe | No (single volume, single service) | Yes |
| `fileAvailable` in lists | Real `existsSync` per row | Assumed `true` when `s3Key` is non-null (see below) |
| Uploads-backup cron (`BACKUP_S3_*`) | Active when configured | Skipped with a boot log line — use bucket versioning/replication instead |
| Extra env required | none | `STORAGE_S3_BUCKET`, `STORAGE_S3_REGION` (fail-loud at boot if missing) |

### Env vars for the s3 driver

```
STORAGE_DRIVER=s3
STORAGE_S3_BUCKET=alto-people-uploads      # required
STORAGE_S3_REGION=us-west-004              # required (R2: "auto")
STORAGE_S3_ENDPOINT=https://...            # non-AWS providers only
STORAGE_S3_ACCESS_KEY_ID=...               # optional pair — omit both to use
STORAGE_S3_SECRET_ACCESS_KEY=...           #   the SDK default provider chain
STORAGE_S3_PREFIX=                         # optional key prefix in the bucket
STORAGE_S3_FORCE_PATH_STYLE=               # optional; defaults to true when
                                           #   ENDPOINT is set (B2/R2), else false
```

Boot fails loudly (`process.exit(1)`) when `STORAGE_DRIVER=s3` and bucket or
region is missing, or when only one credential half is set — a half-wired blob
store must never come up looking healthy.

### `fileAvailable` on the s3 driver

List endpoints (documents vault, compliance/drug-test/E-Verify drawers, I-9
thumbnails) compute `fileAvailable` per row inside serialization loops. On the
local driver that is a real `existsSync` — the flag exists because Railway's
ephemeral disk could wipe blobs while the DB rows survived. On the s3 driver
the blob store doesn't lose objects on redeploy, so those loops simply assume
available whenever `s3Key` is non-null instead of issuing a `HeadObject` per
row. Download/read endpoints still do a real `get()` and keep the genuine
404/410 on a missing object. (`blobExistsForListing` in `blobStore.ts`.)

## Migrating an existing deployment to S3

Order matters — enable the driver AFTER the copy:

1. Create the bucket + a key scoped to it (read/write/list).
2. Set `STORAGE_S3_BUCKET`, `STORAGE_S3_REGION` (+ `STORAGE_S3_ENDPOINT` /
   credentials / `STORAGE_S3_PREFIX` as applicable) on the service. Leave
   `STORAGE_DRIVER` at `local`.
3. Copy the existing local blobs into the bucket:

   ```
   npx tsx apps/api/scripts/migrate-blobs-to-s3.ts
   ```

   (On Railway: `railway run npx tsx apps/api/scripts/migrate-blobs-to-s3.ts`.)
   The script walks `UPLOAD_ROOT`, uploads each file under its relative key,
   verifies each upload with a `HeadObject` size check, and prints a summary.
   It is idempotent — objects already present with the same size are skipped —
   so re-run until it reports zero failures.
4. Only then set `STORAGE_DRIVER=s3` and redeploy. New uploads and reads now
   go to the bucket; `DocumentRecord.s3Key` values are unchanged.
5. Optional cleanup once verified: keep the Volume mounted for a grace period
   (instant rollback = flip `STORAGE_DRIVER` back to `local`), then remove it.

Note: the nightly uploads-backup cron (`BACKUP_S3_*`, see BACKUPS.md) backs up
the LOCAL disk only. With `STORAGE_DRIVER=s3` it skips itself with a log line —
turn on bucket versioning (and/or cross-region replication) on the primary
bucket for the equivalent protection.

---

# Local driver on Railway (the default setup)

Railway's container filesystem is ephemeral, so without a mounted Volume every
uploaded file is lost on the next redeploy. Mount a Railway Volume and point
`UPLOAD_DIR` at it.

## What writes to disk

- `DocumentRecord` blobs — IDs, SSN cards, I-9 supporting docs, offer letters,
  and any other associate-uploaded file (`POST /documents/me/upload`,
  `POST /documents/admin/upload`, `POST /documents/admin/upload-for-associate`).
- Profile photos — `apps/api/src/routes/profilePhoto.ts` writes to
  `${UPLOAD_ROOT}/profile-photos/`.
- I-9 supporting docs — `apps/api/src/routes/onboarding.ts` writes signed
  Section 1 / Section 2 PDFs and uploaded ID images.
- E-sign signature images — `onboarding.ts` writes captured signatures.

## Why this matters

The `DocumentRecord` (and similar) rows live in Neon Postgres and survive
redeploys. The blobs they reference do not. The result is a UI that lists a
file, a download endpoint that returns 410, and an angry user.

The serializer in `apps/api/src/routes/documents.ts` now sets
`fileAvailable: false` on rows whose blob is missing so the UI can warn the
user instead of pointing them at a broken iframe — but that's a band-aid.
The real fix is below.

## Real fix: attach a Railway Volume

1. Open the Alto People project on the Railway dashboard.
2. Pick the `alto-people/api` service.
3. Settings → Volumes → **+ New Volume**.
4. Mount path: `/data/uploads` (any persistent path; this one keeps it out of
   the source tree).
5. Size: start with 5 GB. Resizable later.
6. Save → the service redeploys with the volume mounted.
7. In Variables, add:
   ```
   UPLOAD_DIR=/data/uploads
   ```
8. Trigger a redeploy. On boot, `apps/api/src/lib/storage.ts` will resolve
   `UPLOAD_ROOT` to `/data/uploads` and `mkdir -p` the `profile-photos/`
   subdirectory inside the volume.

## Verifying it worked

After redeploy:

- Boot logs no longer print
  `[storage] WARNING: UPLOAD_DIR is not set in production`.
- Upload a test document via the UI.
- Trigger another redeploy (any commit / dashboard restart).
- Open the Documents tab; the test document still previews.
- Or shell into the container: `ls /data/uploads` shows your files.

## Migrating existing uploads

Files written before the volume was attached are gone. There is no recovery —
the rows are zombies. The UI labels them "File missing on server — please
re-upload". Admins can either:

- Delete the affected `DocumentRecord` rows and ask associates to re-upload
  (cleanest), or
- Leave them in place; the UI hides preview/download buttons when
  `fileAvailable: false` so users don't hit dead URLs.

Going forward, every new upload lands on the volume and survives redeploys.

## When to migrate to S3

Volumes are attached to a single service and don't replicate. If we ever:

- Run multiple API instances behind a load balancer, or
- Need uploads accessible from a different deploy target (e.g. a worker
  service), or
- Want lifecycle policies (e.g. auto-delete rejected I-9 docs after 90 days),

then switch `STORAGE_DRIVER=s3` — the driver ships in
`apps/api/src/lib/blobStore.ts` and the runbook is at the top of this file
("Migrating an existing deployment to S3"). Until then, a single volume is
sufficient.
