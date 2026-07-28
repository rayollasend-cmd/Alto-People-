import { tryDecryptString } from './crypto.js';

/**
 * Routing-number storage, in one place.
 *
 * `PayoutMethod.routingNumberEnc` is written in TWO different formats by two
 * different routes, and has been since both existed:
 *
 *   - onboarding.ts POST /applications/:id/direct-deposit stores PLAIN UTF-8
 *     bytes, on the reasoning that routing numbers are public — they're
 *     printed on every cheque.
 *   - selfService.ts POST /me/payout-method stores AES-GCM ciphertext.
 *
 * Every reader assumed the first format and called `toString('utf8')`, so a
 * row written by the self-service path decoded to binary garbage. That
 * surfaced as a mojibake routing number on the audited admin reveal — the
 * screen HR uses to verify an account before payroll — and as a masked
 * `•••••` of nonsense in the onboarding view.
 *
 * This reader accepts either. Nine digits after a UTF-8 decode means it's
 * the plaintext format; anything else gets run through the decrypter. Both
 * writers keep their existing behaviour — changing the storage format is a
 * separate decision with migration implications, and it isn't needed to make
 * reads correct.
 */
export function readRoutingNumber(blob: Buffer | Uint8Array | null): string {
  if (!blob) return '';
  const buf = Buffer.from(blob);
  const utf8 = buf.toString('utf8');
  if (/^\d{9}$/.test(utf8)) return utf8;
  const decrypted = tryDecryptString(buf);
  return decrypted && /^\d{9}$/.test(decrypted) ? decrypted : '';
}

/** `•••••1234`, or null when the routing number can't be read at all. */
export function maskRoutingNumber(blob: Buffer | Uint8Array | null): string | null {
  const full = readRoutingNumber(blob);
  return full ? `•••••${full.slice(-4)}` : null;
}
