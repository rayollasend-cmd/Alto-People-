import { existsSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { env } from '../config/env.js';
import { resolveStoragePath } from './storage.js';

/**
 * Driver-based blob storage for document/photo/PDF blobs.
 *
 * Every blob is addressed by the relative key already stored in
 * `DocumentRecord.s3Key` (e.g. "f3a8...-abcd.pdf", "i9/<associateId>/...",
 * "esign/<agreementId>/...", "profile-photos/<associateId>-<uuid>.jpg").
 * Keys map 1:1 between drivers, so switching drivers never rewrites rows:
 *
 *  - `local` (default): today's behavior — files under UPLOAD_ROOT via
 *    `resolveStoragePath` (which enforces the path-escape guard).
 *  - `s3`: an S3-compatible bucket (AWS, Backblaze B2, Cloudflare R2).
 *    The object key is the relative key, optionally under
 *    STORAGE_S3_PREFIX ("alto-uploads" → "alto-uploads/<s3Key>").
 *
 * Driver selection: STORAGE_DRIVER env (`local` | `s3`). See
 * apps/api/STORAGE.md for the driver matrix and the migration runbook
 * (run scripts/migrate-blobs-to-s3.ts BEFORE flipping the driver).
 *
 * Semantics shared by both drivers:
 *  - `get` returns null when the blob is missing (callers keep the
 *    existing 404/410 "blob missing" behavior).
 *  - `delete` is idempotent — deleting a missing blob resolves. That
 *    matches S3's DeleteObject and every existing local call site (all
 *    of them already swallowed ENOENT).
 */
export interface BlobStore {
  put(key: string, buffer: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
}

/**
 * Local-filesystem driver — exactly today's behavior: resolveStoragePath
 * (UPLOAD_ROOT + path-escape guard) + node:fs. `put` creates intermediate
 * directories, absorbing the ad-hoc `mkdir` calls the i9/esign writers
 * used to do themselves.
 */
export class LocalBlobStore implements BlobStore {
  async put(key: string, buffer: Buffer, _contentType: string): Promise<void> {
    const full = resolveStoragePath(key);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, buffer);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(resolveStoragePath(key));
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    return existsSync(resolveStoragePath(key));
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(resolveStoragePath(key));
    } catch (err) {
      if (isEnoent(err)) return; // idempotent — already gone
      throw err;
    }
  }
}

export interface S3BlobConfig {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Defaults to true when a custom endpoint is set (B2/R2 need it). */
  forcePathStyle?: boolean;
  /** Optional key prefix inside the bucket; no leading/trailing slashes. */
  prefix?: string;
}

/** Missing-object errors across AWS and S3-compatibles (B2, R2, MinIO). */
function isMissingObjectError(err: unknown): boolean {
  const e = err as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    e?.name === 'NoSuchKey' ||
    e?.name === 'NotFound' ||
    e?.$metadata?.httpStatusCode === 404
  );
}

/**
 * S3-compatible driver. Client construction mirrors lib/uploadsBackup.ts:
 * explicit region, optional custom endpoint, path-style addressing when an
 * endpoint is set (unless overridden), and static credentials only when
 * both halves are provided — otherwise the SDK default provider chain
 * (IAM role / env / shared config) applies.
 */
export class S3BlobStore implements BlobStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string | undefined;

  constructor(cfg: S3BlobConfig) {
    if (!cfg.bucket || !cfg.region) {
      throw new Error(
        'S3BlobStore requires STORAGE_S3_BUCKET and STORAGE_S3_REGION',
      );
    }
    if (Boolean(cfg.accessKeyId) !== Boolean(cfg.secretAccessKey)) {
      throw new Error(
        'S3BlobStore: STORAGE_S3_ACCESS_KEY_ID and STORAGE_S3_SECRET_ACCESS_KEY must be set together',
      );
    }
    this.bucket = cfg.bucket;
    this.prefix = cfg.prefix || undefined;
    this.client = new S3Client({
      region: cfg.region,
      ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
      ...(cfg.accessKeyId && cfg.secretAccessKey
        ? {
            credentials: {
              accessKeyId: cfg.accessKeyId,
              secretAccessKey: cfg.secretAccessKey,
            },
          }
        : {}),
      // B2/R2 generally need path-style when used via custom endpoint.
      forcePathStyle: cfg.forcePathStyle ?? Boolean(cfg.endpoint),
    });
  }

  private objectKey(key: string): string {
    return this.prefix ? `${this.prefix}/${key}` : key;
  }

  async put(key: string, buffer: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.objectKey(key),
        Body: buffer,
        ContentType: contentType,
      }),
    );
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }),
      );
      if (!res.Body) return null;
      return Buffer.from(await res.Body.transformToByteArray());
    } catch (err) {
      if (isMissingObjectError(err)) return null;
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }),
      );
      return true;
    } catch (err) {
      if (isMissingObjectError(err)) return false;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    // S3 DeleteObject is idempotent — no error on a missing key.
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }),
    );
  }
}

export interface BlobStoreConfig {
  driver: 'local' | 's3';
  bucket?: string;
  region?: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
  prefix?: string;
}

export function blobStoreConfigFromEnv(): BlobStoreConfig {
  return {
    driver: env.STORAGE_DRIVER,
    bucket: env.STORAGE_S3_BUCKET,
    region: env.STORAGE_S3_REGION,
    endpoint: env.STORAGE_S3_ENDPOINT,
    accessKeyId: env.STORAGE_S3_ACCESS_KEY_ID,
    secretAccessKey: env.STORAGE_S3_SECRET_ACCESS_KEY,
    forcePathStyle: env.STORAGE_S3_FORCE_PATH_STYLE,
    prefix: env.STORAGE_S3_PREFIX,
  };
}

/**
 * Build a store for the given config. Throws on driver=s3 with missing
 * bucket/region — env.ts additionally fail-louds at boot (process.exit)
 * so a misconfigured deploy never comes up half-working.
 */
export function createBlobStore(
  cfg: BlobStoreConfig = blobStoreConfigFromEnv(),
): BlobStore {
  if (cfg.driver === 's3') {
    if (!cfg.bucket || !cfg.region) {
      throw new Error(
        'STORAGE_DRIVER=s3 requires STORAGE_S3_BUCKET and STORAGE_S3_REGION',
      );
    }
    return new S3BlobStore({
      bucket: cfg.bucket,
      region: cfg.region,
      endpoint: cfg.endpoint,
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      forcePathStyle: cfg.forcePathStyle,
      prefix: cfg.prefix,
    });
  }
  return new LocalBlobStore();
}

let singleton: BlobStore | null = null;

/** Process-wide store selected by STORAGE_DRIVER (default local). */
export function getBlobStore(): BlobStore {
  if (!singleton) singleton = createBlobStore();
  return singleton;
}

/**
 * Synchronous `fileAvailable` check for LIST endpoints (documents vault,
 * compliance/drug-test/E-Verify drawers, I-9 thumbnails). These run inside
 * serialization loops, so an async per-row round-trip is off the table.
 *
 * - local driver: real existsSync — the whole reason fileAvailable exists
 *   is Railway's ephemeral disk leaving zombie rows after a redeploy.
 * - s3 driver: assume available whenever s3Key is non-null. S3 doesn't
 *   lose blobs on redeploy, so the zombie-row failure mode this flag was
 *   built for doesn't exist there; a per-row HeadObject (or an exists()
 *   cache) would add latency/complexity to cover a case the download
 *   endpoint already handles with its 410.
 *
 * Download/read paths do NOT use this — they call `get()` and keep the
 * genuine 404/410 semantics on a missing blob.
 */
export function blobExistsForListing(s3Key: string | null): boolean {
  if (s3Key === null) return false;
  if (env.STORAGE_DRIVER === 's3') return true;
  return existsSync(resolveStoragePath(s3Key));
}
