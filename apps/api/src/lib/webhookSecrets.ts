import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { jobSecret } from './jobSecrets.js';

/**
 * Brief 2-4 step 5 — webhook signing secrets, sealed at rest with their own
 * key (the webhookSecret job: WEBHOOK_SECRET_KEY, falling back to the payout
 * key like every per-job secret until the owner sets it; owner's decision 9:
 * never a key shared across domains once split, the QuickBooks lesson).
 *
 *   AES-256-GCM, version byte + IV + ciphertext + tag. New webhooks store
 *   only the sealed secret; existing plain-text ones are sealed by
 *   sealLegacyWebhookSecrets on the delivery tick, after which the plain
 *   column is emptied.
 *
 * Signature v2: Alto-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">.
 * Receivers reject a timestamp older than five minutes, so a captured
 * delivery cannot be replayed. The legacy X-Alto-Signature (HMAC of the body)
 * keeps being sent until LEGACY_SIGNATURE_UNTIL for existing subscriptions.
 */

const VERSION = 1;
const IV_LEN = 12;
const TAG_LEN = 16;
/** 90 days from the v2 signature's release (2026-10-15). */
export const LEGACY_SIGNATURE_UNTIL = new Date('2027-01-13T00:00:00Z');

function key(): Buffer {
  const raw = Buffer.from(jobSecret('webhookSecret'), 'base64');
  // A 32-byte base64 key is used as is; anything else is hashed to 32 bytes.
  return raw.length === 32 ? raw : createHash('sha256').update(jobSecret('webhookSecret')).digest();
}

export function sealWebhookSecret(plain: string): Buffer<ArrayBuffer> {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, ct, cipher.getAuthTag()]);
}

/** The signing secret of a webhook row: sealed if it has been, else the legacy plain text. */
export function openWebhookSecret(row: { secret: string; secretEnc: Uint8Array | null }): string {
  if (!row.secretEnc) return row.secret;
  const blob = Buffer.from(row.secretEnc);
  if (blob[0] !== VERSION || blob.length < 1 + IV_LEN + TAG_LEN) throw new Error('webhook secret: unsupported format');
  const decipher = createDecipheriv('aes-256-gcm', key(), blob.subarray(1, 1 + IV_LEN));
  decipher.setAuthTag(blob.subarray(blob.length - TAG_LEN));
  return Buffer.concat([decipher.update(blob.subarray(1 + IV_LEN, blob.length - TAG_LEN)), decipher.final()]).toString('utf8');
}

export const newWebhookSecret = () => randomBytes(32).toString('hex');

/** Signature v2 header value for a body at a time. */
export function signatureV2(secret: string, body: string, at: Date): string {
  const t = Math.floor(at.getTime() / 1000);
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

/**
 * Verify a v2 signature as a receiver would (used by the sample integration
 * and the tests): the HMAC matches and the timestamp is within tolerance.
 */
export function verifySignatureV2(secret: string, body: string, header: string, now: Date = new Date(), toleranceSeconds = 300): boolean {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(now.getTime() / 1000 - t) > toleranceSeconds) return false;
  return createHmac('sha256', secret).update(`${t}.${body}`).digest('hex') === parts.v1;
}

/** Seal every plain-text secret still on file, then empty the plain column. Returns how many. */
export async function sealLegacyWebhookSecrets(db: PrismaClient): Promise<number> {
  const rows = await db.webhook.findMany({ where: { secretEnc: null, NOT: { secret: '' } }, select: { id: true, secret: true }, take: 500 });
  for (const r of rows) {
    await db.webhook.updateMany({ where: { id: r.id, secretEnc: null }, data: { secretEnc: sealWebhookSecret(r.secret), secret: '' } });
  }
  return rows.length;
}
