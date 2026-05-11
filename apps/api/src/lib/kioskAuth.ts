import { createHmac, randomBytes, randomInt } from 'node:crypto';
import { env } from '../config/env.js';

/**
 * Phase 99 — kiosk auth helpers.
 *
 * PIN storage: 4-digit PIN → HMAC-SHA256 keyed with KIOSK_PIN_SECRET.
 * Lookup is by pinHmac (now globally unique per the employee-number
 * refactor) so it's O(1) without leaking the PIN from a DB-only dump
 * (the secret is needed to brute-force).
 *
 * Device tokens: 32-byte random token, prefixed `altokiosk_`. Stored as
 * bcrypt hash (we already use bcrypt for passwords). Plaintext shown
 * once at registration time.
 */

const KIOSK_TOKEN_PREFIX = 'altokiosk_';

// First N chars of the plaintext token, stored alongside the bcrypt
// hash so /kiosk/punch can find the right device row in O(1) rather
// than bcrypt-verifying every active device. 16 chars = `altokiosk_`
// + 6 hex = 24 bits of entropy beyond the static prefix. Collision
// rate at 100 devices: < 0.001%. Even if two devices collide on
// prefix, bcrypt-verify still distinguishes them — the prefix is a
// non-secret address, not the credential.
const TOKEN_PREFIX_LENGTH = 16;

export function tokenLookupPrefix(plaintext: string): string {
  return plaintext.slice(0, TOKEN_PREFIX_LENGTH);
}

function pinSecret(): string {
  return env.KIOSK_PIN_SECRET ?? env.PAYOUT_ENCRYPTION_KEY;
}

export function hmacPin(pin: string): Buffer {
  // Validate format here so we never HMAC garbage. 4-digit numeric only.
  if (!/^\d{4}$/.test(pin)) {
    throw new Error('PIN must be exactly 4 digits.');
  }
  return createHmac('sha256', pinSecret()).update(pin).digest();
}

export function generatePin(): string {
  // Avoid 0000 / 1234 / 1111 etc. Could go further, but for v1 just
  // generate uniformly and let HR re-roll if they want.
  const n = randomInt(0, 10_000);
  return n.toString().padStart(4, '0');
}

export function generateDeviceToken(): { plaintext: string; prefix: string } {
  const plaintext = `${KIOSK_TOKEN_PREFIX}${randomBytes(32).toString('hex')}`;
  return { plaintext, prefix: tokenLookupPrefix(plaintext) };
}

/**
 * Haversine great-circle distance in meters between two lat/lng points.
 * Earth radius 6371008.8 m (mean). Accurate to ~0.5% over short
 * distances, which is fine for geofence checks where the radius itself
 * is fuzzy (GPS accuracy is typically 5-15m).
 */
export function distanceMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371008.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
