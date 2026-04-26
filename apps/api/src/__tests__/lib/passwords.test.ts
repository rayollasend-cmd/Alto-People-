import { describe, expect, it } from 'vitest';
import { DUMMY_HASH, hashPassword, verifyPassword } from '../../lib/passwords.js';

describe('hashPassword / verifyPassword', () => {
  it('round-trips a correct password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword(hash, 'wrong')).toBe(false);
  });

  it('produces a fresh argon2id hash with each call (random salt)', async () => {
    const a = await hashPassword('same input');
    const b = await hashPassword('same input');
    expect(a).not.toBe(b);
    // Both still verify
    expect(await verifyPassword(a, 'same input')).toBe(true);
    expect(await verifyPassword(b, 'same input')).toBe(true);
  });

  it('verifyPassword returns false for malformed hash strings rather than throwing', async () => {
    expect(await verifyPassword('not-a-valid-hash', 'anything')).toBe(false);
    expect(await verifyPassword('', 'anything')).toBe(false);
  });
});

describe('DUMMY_HASH', () => {
  it('does not verify against arbitrary inputs (timing-pad cannot be a backdoor)', async () => {
    expect(await verifyPassword(DUMMY_HASH, '')).toBe(false);
    expect(await verifyPassword(DUMMY_HASH, 'password')).toBe(false);
    expect(await verifyPassword(DUMMY_HASH, 'invalid-input-pad-pad-pad')).toBe(false);
    expect(await verifyPassword(DUMMY_HASH, 'admin')).toBe(false);
  });
});
