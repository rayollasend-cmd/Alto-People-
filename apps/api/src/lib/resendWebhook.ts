import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

/**
 * Hand-rolled Svix webhook signature verification for Resend's email-event
 * webhook (Resend delivers webhooks through Svix). No svix dependency —
 * the scheme is small and stable:
 *
 *   - The endpoint secret is "whsec_<base64>"; the HMAC key is the DECODED
 *     base64 payload after the prefix (not the whsec_ string itself).
 *   - Signed content is "{svix-id}.{svix-timestamp}.{rawBody}" — raw bytes,
 *     never a re-serialized parse.
 *   - Expected signature = base64(HMAC-SHA256(key, signedContent)).
 *   - The svix-signature header can carry MULTIPLE space-separated entries
 *     ("v1,abc= v1,def= v2,ghi=") to support secret rotation; the delivery
 *     is valid if ANY v1 entry matches. Non-v1 schemes are skipped.
 *   - svix-timestamp is unix seconds; deliveries outside the tolerance
 *     window are rejected to blunt replay of a captured request.
 *
 * Comparison is constant-time (timingSafeEqual) with an explicit byte-length
 * pre-check — timingSafeEqual THROWS on length mismatch, and byte length can
 * differ from string length on multibyte input (same July-review lesson as
 * lib/calendarFeed.ts).
 */

/** ±5 minutes, matching Svix's own default tolerance. */
export const RESEND_WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

export interface ResendWebhookHeaders {
  svixId: string | undefined;
  svixTimestamp: string | undefined;
  svixSignature: string | undefined;
}

/** Decode the HMAC key out of a "whsec_..." secret. Null on malformed input. */
function decodeSecret(secret: string): Buffer | null {
  const b64 = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  if (b64.length === 0) return null;
  try {
    const key = Buffer.from(b64, 'base64');
    return key.length > 0 ? key : null;
  } catch {
    return null;
  }
}

/**
 * Verify one Resend/Svix webhook delivery.
 *
 * `nowMs` is injectable for tests (fixed-date test rot: never let a fixture
 * timestamp race the wall clock). Returns plain boolean — the route maps
 * false to 401 without distinguishing why (don't oracle the failure mode
 * to an attacker).
 */
export function verifyResendWebhookSignature(
  rawBody: Buffer | string,
  headers: ResendWebhookHeaders,
  opts: { secret?: string; nowMs?: number } = {},
): boolean {
  const secret = opts.secret ?? env.RESEND_WEBHOOK_SECRET;
  if (!secret) return false;
  const { svixId, svixTimestamp, svixSignature } = headers;
  if (!svixId || !svixTimestamp || !svixSignature) return false;

  // Timestamp window. Reject non-numeric outright.
  const ts = Number(svixTimestamp);
  if (!Number.isFinite(ts)) return false;
  const nowSeconds = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - ts) > RESEND_WEBHOOK_TOLERANCE_SECONDS) return false;

  const key = decodeSecret(secret);
  if (!key) return false;

  const bodyBuf =
    typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  const signedContent = Buffer.concat([
    Buffer.from(`${svixId}.${svixTimestamp}.`, 'utf8'),
    bodyBuf,
  ]);
  const expected = createHmac('sha256', key).update(signedContent).digest();

  // Any matching v1 entry passes (rotation sends old+new side by side).
  for (const entry of svixSignature.split(/\s+/)) {
    const [version, sig] = entry.split(',', 2);
    if (version !== 'v1' || !sig) continue;
    let candidate: Buffer;
    try {
      candidate = Buffer.from(sig, 'base64');
    } catch {
      continue;
    }
    if (candidate.length !== expected.length) continue;
    if (timingSafeEqual(candidate, expected)) return true;
  }
  return false;
}

/**
 * Test helper: produce a valid svix-signature header value for a payload.
 * Lives here (not in test files) so route tests and unit tests sign with
 * the exact same algorithm being verified.
 */
export function signResendWebhook(
  rawBody: Buffer | string,
  svixId: string,
  svixTimestamp: string,
  secret: string,
): string {
  const key = decodeSecret(secret);
  if (!key) throw new Error('signResendWebhook: malformed secret');
  const bodyBuf =
    typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  const signedContent = Buffer.concat([
    Buffer.from(`${svixId}.${svixTimestamp}.`, 'utf8'),
    bodyBuf,
  ]);
  const sig = createHmac('sha256', key).update(signedContent).digest('base64');
  return `v1,${sig}`;
}
