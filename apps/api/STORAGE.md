# Document storage on Railway

**TL;DR:** uploads go to the local filesystem (`apps/api/uploads/` by default).
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

then `apps/api/src/lib/storage.ts` should be re-pointed at S3. The
`DocumentRecord.s3Key` column already names what the migration target is —
the resolver just changes from `resolveStoragePath()` returning a local path
to `getSignedUrl()` returning an S3 presigned URL. Until then, a single
volume is sufficient.
