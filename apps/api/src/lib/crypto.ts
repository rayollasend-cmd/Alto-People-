import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';

/**
 * AES-256-GCM helpers for at-rest encryption of small PII fields
 * (account numbers, SSN). On-the-wire formats:
 *
 *   v1  [1][iv:12][ciphertext...][tag:16]          key id 0, PAYOUT_ENCRYPTION_KEY
 *   v2  [2][keyId:u8][iv:12][ciphertext...][tag:16] the keyring's key `keyId`
 *
 * Brief 2-5 step 3 — the keyring. FIELD_KEYS="1:<base64>,2:<base64>" adds
 * keys; FIELD_KEY_ACTIVE picks the one new writes use. Key id 0 is always
 * the payout key, so every v1 row still reads. With no keyring configured
 * the active key is 0 and writes stay v1: nothing changes until the owner
 * adds a key. A rotation (scripts/rotate-field-key.ts) re-encrypts every
 * column under the active key, then the old key leaves the ring. A key
 * missing from the ring fails at boot through the canary (lib/keyring), not
 * at a person's read (the 2026-06-11 lesson).
 *
 * Plaintext is intentionally never included in thrown errors.
 */

const V1 = 1;
const V2 = 2;
const IV_LEN = 12;
const TAG_LEN = 16;

interface Ring {
  keys: Map<number, Buffer>;
  active: number;
}

let cachedRing: Ring | null = null;

function decodeKey(b64: string, name: string): Buffer {
  const decoded = Buffer.from(b64, 'base64');
  if (decoded.length !== 32) throw new Error(`${name} must decode to 32 bytes (use openssl rand -base64 32)`);
  return decoded;
}

function ring(): Ring {
  if (cachedRing) return cachedRing;
  const keys = new Map<number, Buffer>([[0, decodeKey(env.PAYOUT_ENCRYPTION_KEY, 'PAYOUT_ENCRYPTION_KEY')]]);
  for (const part of (env.FIELD_KEYS ?? '').split(',').map((p) => p.trim()).filter(Boolean)) {
    const m = /^(\d{1,3}):(.+)$/.exec(part);
    const id = m ? Number(m[1]) : NaN;
    if (!m || !Number.isInteger(id) || id < 1 || id > 255) throw new Error('FIELD_KEYS entries are "<id 1-255>:<base64 key>"');
    keys.set(id, decodeKey(m[2]!, `FIELD_KEYS key ${id}`));
  }
  const active = env.FIELD_KEY_ACTIVE === undefined ? 0 : Number(env.FIELD_KEY_ACTIVE);
  if (!keys.has(active)) throw new Error(`FIELD_KEY_ACTIVE=${active} is not in the keyring`);
  cachedRing = { keys, active };
  return cachedRing;
}

/** The keyring as configured (ids only, never a key). */
export function fieldKeyring(): { ids: number[]; active: number } {
  const r = ring();
  return { ids: [...r.keys.keys()].sort((a, b) => a - b), active: r.active };
}

/** Test-only: re-read the keyring from env after a test changes it. */
export function __resetKeyringForTests(): void {
  cachedRing = null;
}

/** Encrypt under a specific key of the ring (the canary writes one per key); new data uses encryptBytes. */
export function encryptWithKey(plaintext: Uint8Array, keyId: number): Buffer<ArrayBuffer> {
  try {
    const key = ring().keys.get(keyId);
    if (!key) throw new Error('no such key');
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const head = keyId === 0 ? Buffer.from([V1]) : Buffer.from([V2, keyId]);
    return Buffer.concat([head, iv, ct, tag]);
  } catch {
    throw new Error('encryption failed');
  }
}

export function encryptBytes(plaintext: Uint8Array): Buffer<ArrayBuffer> {
  return encryptWithKey(plaintext, ring().active);
}

/** The key id a blob was written under (v1 = 0), or null for an unknown format. */
export function keyIdOf(blob: Uint8Array): number | null {
  if (blob[0] === V1) return 0;
  if (blob[0] === V2 && blob.length > 1) return blob[1]!;
  return null;
}

export function decryptBytes(blob: Uint8Array): Buffer<ArrayBuffer> {
  try {
    const keyId = keyIdOf(blob);
    if (keyId === null) throw new Error('unsupported encryption version');
    const offset = keyId === 0 && blob[0] === V1 ? 1 : 2;
    if (blob.length < offset + IV_LEN + TAG_LEN) throw new Error('ciphertext too short');
    const key = ring().keys.get(keyId);
    if (!key) throw new Error('key not in the ring');
    const iv = blob.subarray(offset, offset + IV_LEN);
    const tag = blob.subarray(blob.length - TAG_LEN);
    const ct = blob.subarray(offset + IV_LEN, blob.length - TAG_LEN);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new Error('decryption failed');
  }
}

export function encryptString(plaintext: string): Buffer<ArrayBuffer> {
  return encryptBytes(Buffer.from(plaintext, 'utf8'));
}

export function decryptString(blob: Uint8Array): string {
  return decryptBytes(blob).toString('utf8');
}

/**
 * Non-throwing decrypt. Null means the blob cannot be read under the
 * keyring — e.g. rows encrypted before the 2026-06-11 key-rotation
 * incident. Callers use this to distinguish "SSN on file" from "SSN on
 * file but unreadable, needs re-collection".
 */
export function tryDecryptString(blob: Uint8Array): string | null {
  try {
    return decryptString(blob);
  } catch {
    return null;
  }
}
