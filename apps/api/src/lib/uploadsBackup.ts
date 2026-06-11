import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Readable } from 'node:stream';
import * as tar from 'tar';
import { env } from '../config/env.js';
import { UPLOAD_ROOT } from './storage.js';

/**
 * Nightly off-site backup of the uploads volume.
 *
 * The Railway Volume fixed files dying on REDEPLOY; it does nothing for
 * deletion, corruption, or a lost volume. The database has Neon
 * point-in-time recovery — this is the equivalent for the document blobs
 * (I-9 photos, W-4 PDFs, signatures, profile photos).
 *
 * Design:
 *  - One gzipped tar of UPLOAD_ROOT, streamed straight to an
 *    S3-compatible bucket (AWS, Backblaze B2, Cloudflare R2) — no temp
 *    file, so disk usage doesn't double during the run.
 *  - Key: uploads-backup/uploads-YYYY-MM-DDTHH-mm.tar.gz
 *  - Retention: objects under the prefix older than
 *    BACKUP_RETENTION_DAYS are deleted after each successful upload.
 *  - Off unless ALL FOUR BACKUP_S3_* credentials are configured.
 *
 * Restore (see BACKUPS.md): download the newest tar, extract into the
 * volume, redeploy. The DB rows reference files by relative path, so a
 * straight extract puts every blob back where DocumentRecord expects it.
 */

export function backupConfigured(): boolean {
  return Boolean(
    env.BACKUP_S3_BUCKET &&
      env.BACKUP_S3_REGION &&
      env.BACKUP_S3_ACCESS_KEY_ID &&
      env.BACKUP_S3_SECRET_ACCESS_KEY,
  );
}

const KEY_PREFIX = 'uploads-backup/';

function client(): S3Client {
  return new S3Client({
    region: env.BACKUP_S3_REGION!,
    ...(env.BACKUP_S3_ENDPOINT ? { endpoint: env.BACKUP_S3_ENDPOINT } : {}),
    credentials: {
      accessKeyId: env.BACKUP_S3_ACCESS_KEY_ID!,
      secretAccessKey: env.BACKUP_S3_SECRET_ACCESS_KEY!,
    },
    // B2/R2 generally need path-style when used via custom endpoint.
    ...(env.BACKUP_S3_ENDPOINT ? { forcePathStyle: true } : {}),
  });
}

export interface BackupResult {
  key: string;
  prunedOld: number;
}

export async function runUploadsBackup(
  now: Date = new Date(),
): Promise<BackupResult> {
  if (!backupConfigured()) {
    throw new Error('uploads backup is not configured (BACKUP_S3_* unset)');
  }
  const s3 = client();
  const stamp = now.toISOString().slice(0, 16).replace(/:/g, '-');
  const key = `${KEY_PREFIX}uploads-${stamp}.tar.gz`;

  // tar.create with a stream result; cwd = UPLOAD_ROOT so the archive
  // holds relative paths (restore = extract straight into the volume).
  const tarStream = tar.create(
    { gzip: true, cwd: UPLOAD_ROOT, portable: true },
    ['.'],
  );

  const upload = new Upload({
    client: s3,
    params: {
      Bucket: env.BACKUP_S3_BUCKET!,
      Key: key,
      Body: Readable.from(tarStream),
      ContentType: 'application/gzip',
    },
    // 8 MB parts, 4 in flight — gentle on the API container's memory.
    partSize: 8 * 1024 * 1024,
    queueSize: 4,
  });
  await upload.done();

  // Retention sweep — only after a successful upload, and never the
  // object we just wrote.
  const cutoff = new Date(
    now.getTime() - env.BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
  let prunedOld = 0;
  const listed = await s3.send(
    new ListObjectsV2Command({
      Bucket: env.BACKUP_S3_BUCKET!,
      Prefix: KEY_PREFIX,
    }),
  );
  const stale = (listed.Contents ?? []).filter(
    (o) => o.Key && o.Key !== key && o.LastModified && o.LastModified < cutoff,
  );
  if (stale.length > 0) {
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: env.BACKUP_S3_BUCKET!,
        Delete: { Objects: stale.map((o) => ({ Key: o.Key! })) },
      }),
    );
    prunedOld = stale.length;
  }
  return { key, prunedOld };
}

let timer: NodeJS.Timeout | null = null;

export function startUploadsBackupCron(): void {
  if (timer) return;
  if (!backupConfigured()) {
    if (env.NODE_ENV === 'production') {
      // Loud nudge, not fatal — mirrors the UPLOAD_DIR warning in
      // storage.ts. A volume with no backup is one bad day from losing
      // every compliance document.
      console.warn(
        '[backup] WARNING: uploads backup is not configured in production. ' +
          'Set BACKUP_S3_BUCKET / _REGION / _ACCESS_KEY_ID / _SECRET_ACCESS_KEY ' +
          '(and _ENDPOINT for B2/R2). See apps/api/BACKUPS.md.',
      );
    }
    return;
  }
  const run = () => {
    void runUploadsBackup()
      .then((r) =>
        console.log(
          `[backup] uploads backed up to ${r.key}` +
            (r.prunedOld ? ` (pruned ${r.prunedOld} old)` : ''),
        ),
      )
      .catch((err) => console.error('[backup] uploads backup failed:', err));
  };
  // First run shortly after boot (not immediately — let the service warm
  // up), then every BACKUP_INTERVAL_HOURS.
  const first = setTimeout(run, 5 * 60_000);
  first.unref();
  timer = setInterval(run, env.BACKUP_INTERVAL_HOURS * 60 * 60 * 1000);
  timer.unref();
  console.log(
    `[backup] uploads backup cron armed (every ${env.BACKUP_INTERVAL_HOURS}h, ` +
      `retention ${env.BACKUP_RETENTION_DAYS}d, bucket ${env.BACKUP_S3_BUCKET})`,
  );
}

export function stopUploadsBackupCron(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
