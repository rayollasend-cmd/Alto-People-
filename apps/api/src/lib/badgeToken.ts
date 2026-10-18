import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { jobSecret } from './jobSecrets.js';

/**
 * A worker's badge credential — the value an NFC badge carries and the
 * QR code on their Apple / Google Wallet pass shows. One credential, two
 * carriers, and the kiosk accepts it in place of the clock-in number.
 *
 *   altob1.<payload>.<sig>
 *     payload  base64url JSON { a: associateId, v: badgeVersion, t: tenantId }
 *     sig      base64url HMAC-SHA256(payload) — 16 bytes, short enough for
 *              a cheap NTAG213 tag and a QR a phone screen renders crisply.
 *
 * It is not a secret in the strong sense (it is printed on a badge), so it
 * carries no expiry: it is revoked by bumping KioskPin.badgeVersion, which
 * every verify checks against the database. Reading it proves a badge was
 * presented — the kiosk still takes its selfie and face match, exactly as
 * for a typed number.
 */

const PREFIX = 'altob1';
const SIG_BYTES = 16;

function secret(): string {
  if (env.KIOSK_BADGE_SECRET) return env.KIOSK_BADGE_SECRET;
  // Derived, so a deployment needs no new secret to start issuing badges,
  // and rotating KIOSK_PIN_SECRET rotates badges with it.
  return createHmac('sha256', jobSecret('kioskPin')).update('alto-badge-v1').digest('hex');
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function sign(payload: string): string {
  return b64url(createHmac('sha256', secret()).update(payload).digest().subarray(0, SIG_BYTES));
}

export interface BadgeClaims {
  associateId: string;
  version: number;
  tenantId: string | null;
}

export function signBadgeToken(claims: BadgeClaims): string {
  const payload = b64url(Buffer.from(JSON.stringify({ a: claims.associateId, v: claims.version, t: claims.tenantId })));
  return `${PREFIX}.${payload}.${sign(payload)}`;
}

/** The claims, or null for anything that isn't a well-formed, correctly signed badge. */
export function verifyBadgeToken(token: string): BadgeClaims | null {
  if (typeof token !== 'string' || token.length > 400) return null;
  const parts = token.trim().split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  const [, payload, sig] = parts as [string, string, string];
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { a?: unknown; v?: unknown; t?: unknown };
    if (typeof parsed.a !== 'string' || typeof parsed.v !== 'number') return null;
    return { associateId: parsed.a, version: parsed.v, tenantId: typeof parsed.t === 'string' ? parsed.t : null };
  } catch {
    return null;
  }
}
