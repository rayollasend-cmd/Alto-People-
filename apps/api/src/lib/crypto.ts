import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';

/**
 * AES-256-GCM helpers for at-rest encryption of small PII fields
 * (account numbers, SSN). On-the-wire format:
 *
 *   [version:u8 = 1][iv:12 bytes][ciphertext...][tag:16 bytes]
 *
 * Phase 6 KMS will introduce v=2 with a key-wrapped DEK; old v=1 rows
 * decrypt unchanged because branching happens on the leading byte.
 *
 * Plaintext is intentionally never included in thrown errors.
 */

const VERSION = 1;
const IV_LEN = 12;
const TAG_LEN = 16;

let cachedKey: Buffer | null = null;
function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const decoded = Buffer.from(env.PAYOUT_ENCRYPTION_KEY, 'base64');
  if (decoded.length !== 32) {
    throw new Error(
      'PAYOUT_ENCRYPTION_KEY must decode to 32 bytes (use openssl rand -base64 32)'
    );
  }
  cachedKey = decoded;
  return decoded;
}

export function encryptBytes(plaintext: Buffer): Buffer {
  try {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv('aes-256-gcm', getKey(), iv);
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([Buffer.from([VERSION]), iv, ct, tag]);
  } catch {
    throw new Error('encryption failed');
  }
}

export function decryptBytes(blob: Buffer): Buffer {
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
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new Error('decryption failed');
  }
}

export function encryptString(plaintext: string): Buffer {
  return encryptBytes(Buffer.from(plaintext, 'utf8'));
}

export function decryptString(blob: Buffer): string {
  return decryptBytes(blob).toString('utf8');
}
