/**
 * One-time migration: copy every local blob under UPLOAD_ROOT into the
 * S3-compatible bucket the s3 storage driver will read from.
 *
 * Usage (from repo root or apps/api):
 *   npx tsx apps/api/scripts/migrate-blobs-to-s3.ts
 *
 * Requires STORAGE_S3_BUCKET + STORAGE_S3_REGION (plus STORAGE_S3_ENDPOINT /
 * credentials / STORAGE_S3_PREFIX as applicable) in the environment.
 * STORAGE_DRIVER may — and should — still be `local` while this runs; flip
 * it to `s3` only AFTER the summary reports zero failures (see STORAGE.md).
 *
 * Behavior:
 *   - Walks UPLOAD_ROOT recursively; each file's path relative to the root
 *     (forward-slash separators) is its object key — exactly the value in
 *     DocumentRecord.s3Key — under the optional STORAGE_S3_PREFIX.
 *   - Idempotent: HeadObject first; skip when the object already exists
 *     with the same size. Re-running only uploads what's new/changed.
 *   - Verifies every upload with a HeadObject size check.
 *   - Never wired to boot; run it manually (e.g. `railway run`).
 */
import { readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { env } from '../src/config/env.js';
import { UPLOAD_ROOT } from '../src/lib/storage.js';

const bucket = env.STORAGE_S3_BUCKET;
const region = env.STORAGE_S3_REGION;
if (!bucket || !region) {
  console.error(
    'FATAL: STORAGE_S3_BUCKET and STORAGE_S3_REGION must be set to migrate. ' +
      '(STORAGE_DRIVER can stay `local` while running this script.)',
  );
  process.exit(1);
}
if (
  Boolean(env.STORAGE_S3_ACCESS_KEY_ID) !==
  Boolean(env.STORAGE_S3_SECRET_ACCESS_KEY)
) {
  console.error(
    'FATAL: set both STORAGE_S3_ACCESS_KEY_ID and STORAGE_S3_SECRET_ACCESS_KEY, or neither.',
  );
  process.exit(1);
}

// Same client construction as S3BlobStore / uploadsBackup.ts.
const client = new S3Client({
  region,
  ...(env.STORAGE_S3_ENDPOINT ? { endpoint: env.STORAGE_S3_ENDPOINT } : {}),
  ...(env.STORAGE_S3_ACCESS_KEY_ID && env.STORAGE_S3_SECRET_ACCESS_KEY
    ? {
        credentials: {
          accessKeyId: env.STORAGE_S3_ACCESS_KEY_ID,
          secretAccessKey: env.STORAGE_S3_SECRET_ACCESS_KEY,
        },
      }
    : {}),
  forcePathStyle:
    env.STORAGE_S3_FORCE_PATH_STYLE ?? Boolean(env.STORAGE_S3_ENDPOINT),
});

const CONTENT_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.zip': 'application/zip',
};

function contentTypeFor(file: string): string {
  return CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
}

function objectKey(relKey: string): string {
  return env.STORAGE_S3_PREFIX ? `${env.STORAGE_S3_PREFIX}/${relKey}` : relKey;
}

/** HeadObject → size, or null when the object doesn't exist. */
async function headSize(key: string): Promise<number | null> {
  try {
    const res = await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
    );
    return res.ContentLength ?? -1;
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (
      e?.name === 'NotFound' ||
      e?.name === 'NoSuchKey' ||
      e?.$metadata?.httpStatusCode === 404
    ) {
      return null;
    }
    throw err;
  }
}

async function main(): Promise<void> {
  console.log(`[migrate-blobs] source: ${UPLOAD_ROOT}`);
  console.log(
    `[migrate-blobs] target: s3://${bucket}` +
      (env.STORAGE_S3_PREFIX ? `/${env.STORAGE_S3_PREFIX}` : '') +
      (env.STORAGE_S3_ENDPOINT ? ` via ${env.STORAGE_S3_ENDPOINT}` : ''),
  );

  const entries = readdirSync(UPLOAD_ROOT, {
    recursive: true,
    withFileTypes: true,
  });
  const files = entries
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));

  let uploaded = 0;
  let skipped = 0;
  let bytesUploaded = 0;
  const failed: Array<{ key: string; error: string }> = [];

  for (const fullPath of files) {
    // DB s3Keys use forward slashes regardless of host OS.
    const relKey = relative(UPLOAD_ROOT, fullPath).split(sep).join('/');
    const key = objectKey(relKey);
    try {
      const size = statSync(fullPath).size;
      const existing = await headSize(key);
      if (existing === size) {
        skipped++;
        continue;
      }
      const body = await readFile(fullPath);
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentTypeFor(fullPath),
        }),
      );
      // Verify: the object must now exist with the local size.
      const verified = await headSize(key);
      if (verified !== size) {
        throw new Error(
          `post-upload verification failed (local ${size} bytes, remote ${verified ?? 'missing'})`,
        );
      }
      uploaded++;
      bytesUploaded += size;
      console.log(`  uploaded ${relKey} (${size} bytes)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failed.push({ key: relKey, error: msg });
      console.error(`  FAILED ${relKey}: ${msg}`);
    }
  }

  console.log('');
  console.log('[migrate-blobs] summary');
  console.log(`  scanned:  ${files.length}`);
  console.log(`  uploaded: ${uploaded} (${(bytesUploaded / 1024 / 1024).toFixed(1)} MiB)`);
  console.log(`  skipped (already present, same size): ${skipped}`);
  console.log(`  failed:   ${failed.length}`);
  for (const f of failed) console.log(`    ${f.key}: ${f.error}`);
  if (failed.length > 0) {
    console.error(
      '[migrate-blobs] DO NOT flip STORAGE_DRIVER=s3 until a re-run reports zero failures.',
    );
    process.exit(1);
  }
  console.log(
    '[migrate-blobs] done — safe to set STORAGE_DRIVER=s3 (see apps/api/STORAGE.md).',
  );
}

void main();
