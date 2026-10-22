import { afterEach, describe, expect, it } from 'vitest';
import { env } from '../../config/env.js';
import { __resetKeyringForTests, decryptString, encryptString, fieldKeyring, keyIdOf } from '../../lib/crypto.js';

/**
 * Brief 2-5 step 3 — the keyring in lib/crypto, without a database.
 *
 *   No keyring configured: key 0 (the payout key) and v1 blobs, exactly as
 *   before. With one: new writes are v2 under the active key, and v1 rows
 *   and every key in the ring still read. A blob under a key that left the
 *   ring does not read.
 */

const K1 = Buffer.alloc(32, 7).toString('base64');
const K2 = Buffer.alloc(32, 9).toString('base64');
const set = (keys: string | undefined, active: number | undefined) => {
  (env as Record<string, unknown>).FIELD_KEYS = keys;
  (env as Record<string, unknown>).FIELD_KEY_ACTIVE = active;
  __resetKeyringForTests();
};

afterEach(() => set(undefined, undefined));

describe('the field-encryption keyring', () => {
  it('unconfigured: key 0 and v1, as before', () => {
    expect(fieldKeyring()).toEqual({ ids: [0], active: 0 });
    const blob = encryptString('123-45-6789');
    expect(blob[0]).toBe(1);
    expect(keyIdOf(blob)).toBe(0);
  });

  it('configured: new writes carry the active key id; old v1 and every ring key still read', () => {
    const old = encryptString('123-45-6789');
    set(`1:${K1},2:${K2}`, 2);
    expect(fieldKeyring()).toEqual({ ids: [0, 1, 2], active: 2 });
    const fresh = encryptString('987-65-4321');
    expect([fresh[0], fresh[1]]).toEqual([2, 2]);
    expect(keyIdOf(fresh)).toBe(2);
    expect(decryptString(fresh)).toBe('987-65-4321');
    expect(decryptString(old)).toBe('123-45-6789');

    // A key that left the ring no longer reads its rows.
    set(`1:${K1}`, 1);
    expect(() => decryptString(fresh)).toThrow('decryption failed');
  });

  it('refuses a malformed ring or an active key outside it', () => {
    set('one:abc', undefined);
    expect(() => fieldKeyring()).toThrow(/FIELD_KEYS/);
    set(`1:${K1}`, 3);
    expect(() => fieldKeyring()).toThrow(/names a key that is not in the ring/);
  });
});
