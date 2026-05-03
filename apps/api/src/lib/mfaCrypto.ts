import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';

/**
 * AES-256-GCM helpers dedicated to encrypting TOTP secrets at rest. Uses the
 * same on-the-wire format as `lib/crypto.ts` (version byte + iv + ct + tag)
 * but with an independent key so the MFA secret can be rotated without
 * touching payout encryption (and vice versa).
 *
 * Key resolution: MFA_SECRET_ENCRYPTION_KEY when set, otherwise falls back
 * to PAYOUT_ENCRYPTION_KEY. The fallback keeps dev / test envs working
 * without a second secret; production should set both.
 */

const VERSION = 1;
const IV_LEN = 12;
const TAG_LEN = 16;

let cachedKey: Buffer | null = null;
function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = env.MFA_SECRET_ENCRYPTION_KEY ?? env.PAYOUT_ENCRYPTION_KEY;
  const decoded = Buffer.from(raw, 'base64');
  if (decoded.length !== 32) {
    throw new Error(
      'MFA_SECRET_ENCRYPTION_KEY (or PAYOUT_ENCRYPTION_KEY fallback) must decode to 32 bytes'
    );
  }
  cachedKey = decoded;
  return decoded;
}

export function encryptMfaSecret(plaintext: string): Buffer {
  try {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv('aes-256-gcm', getKey(), iv);
    const ct = Buffer.concat([
      cipher.update(Buffer.from(plaintext, 'utf8')),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([Buffer.from([VERSION]), iv, ct, tag]);
  } catch {
    throw new Error('mfa secret encryption failed');
  }
}

export function decryptMfaSecret(blob: Buffer): string {
  try {
    if (blob.length < 1 + IV_LEN + TAG_LEN) {
      throw new Error('ciphertext too short');
    }
    const version = blob[0];
    if (version !== VERSION) {
      throw new Error(`unsupported encryption version: ${version}`);
    }
    const iv = blob.subarray(1, 1 + IV_LEN);
    const tag = blob.subarray(blob.length - TAG_LEN);
    const ct = blob.subarray(1 + IV_LEN, blob.length - TAG_LEN);
    const decipher = createDecipheriv('aes-256-gcm', getKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('mfa secret decryption failed');
  }
}

/**
 * SHA-256 hex digest of a recovery code. Stored in MfaRecoveryCode.codeHash
 * with a unique constraint so we can verify a presented code without ever
 * persisting the plaintext.
 */
export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

/**
 * Generate a single human-readable recovery code: 10 lowercase alphanumerics
 * grouped 5-5 with a dash (e.g. "k3p9x-7r2qm"). Avoids visually-ambiguous
 * characters (0/O, 1/l/i) so users transcribing from a printout don't make
 * unrecoverable mistakes.
 */
export function generateRecoveryCode(): string {
  const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(10);
  let out = '';
  for (let i = 0; i < 10; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
    if (i === 4) out += '-';
  }
  return out;
}
