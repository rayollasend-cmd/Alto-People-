import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { env } from '../../config/env.js';
import { jobSecret, jobSecretStates, SECRET_JOB_VARS, SECRET_JOBS, unsetJobSecrets } from '../../lib/jobSecrets.js';
import { accountFingerprint } from '../../lib/financialChanges.js';
import { hmacPin } from '../../lib/kioskAuth.js';
import { decryptMfaSecret, encryptMfaSecret } from '../../lib/mfaCrypto.js';

/**
 * Brief 2-5 step 2 — one secret per job, with nothing changing on the day.
 *
 *   Unset, each job resolves to the payout key exactly as before, so every
 *   stored bank-account fingerprint, kiosk PIN lookup, survey hash and MFA
 *   secret still matches. Set to the payout key's value (how the owner
 *   rolls it out), the output is byte-identical. Set to anything else, only
 *   that job's output changes.
 */

const VARS = Object.values(SECRET_JOB_VARS);
const saved = Object.fromEntries(VARS.map((k) => [k, env[k]])) as Record<(typeof VARS)[number], string | undefined>;
const OTHER = 'a-completely-different-secret-value-of-enough-length-0123456789';

function setVar(k: (typeof VARS)[number], v: string | undefined) {
  (env as Record<string, unknown>)[k] = v;
}

afterEach(() => {
  for (const k of VARS) setVar(k, saved[k]);
});

const payoutFingerprint = (r: string, a: string) => createHmac('sha256', env.PAYOUT_ENCRYPTION_KEY).update(`${r}:${a}`).digest('hex');
const pinWith = (secret: string, pin: string) => createHmac('sha256', secret).update(pin).digest();

describe('each job has its own secret, falling back to the payout key', () => {
  it('unset: every job resolves to the payout key, and the outputs are what they were', () => {
    for (const k of VARS) setVar(k, undefined);
    for (const job of SECRET_JOBS) expect(jobSecret(job), job).toBe(env.PAYOUT_ENCRYPTION_KEY);
    expect(accountFingerprint('063100277', '12345678')).toBe(payoutFingerprint('063100277', '12345678'));
    expect(Buffer.compare(hmacPin('4821'), pinWith(env.PAYOUT_ENCRYPTION_KEY, '4821'))).toBe(0);
    expect(unsetJobSecrets().sort()).toEqual([...VARS].sort());
  });

  it("set to the payout key's value (the rollout): byte-identical", () => {
    for (const k of VARS) setVar(k, env.PAYOUT_ENCRYPTION_KEY);
    expect(accountFingerprint('063100277', '12345678')).toBe(payoutFingerprint('063100277', '12345678'));
    expect(Buffer.compare(hmacPin('4821'), pinWith(env.PAYOUT_ENCRYPTION_KEY, '4821'))).toBe(0);
    expect(unsetJobSecrets()).toEqual([]);
    expect(jobSecretStates().every((s) => s.set && s.sharesPayoutKey)).toBe(true);
  });

  it('a different value changes only its own job', () => {
    for (const k of VARS) setVar(k, undefined);
    const pinBefore = hmacPin('4821');
    setVar('ACCOUNT_FINGERPRINT_SECRET', OTHER);
    expect(accountFingerprint('063100277', '12345678')).not.toBe(payoutFingerprint('063100277', '12345678'));
    expect(accountFingerprint('063100277', '12345678')).toBe(createHmac('sha256', OTHER).update('063100277:12345678').digest('hex'));
    // The kiosk PIN lookup did not move.
    expect(Buffer.compare(hmacPin('4821'), pinBefore)).toBe(0);
    expect(jobSecret('pulseHash')).toBe(env.PAYOUT_ENCRYPTION_KEY);

    setVar('KIOSK_PIN_SECRET', OTHER);
    expect(Buffer.compare(hmacPin('4821'), pinWith(OTHER, '4821'))).toBe(0);
    setVar('PULSE_HASH_SECRET', OTHER);
    expect(jobSecret('pulseHash')).toBe(OTHER);
    expect(jobSecretStates().find((s) => s.job === 'accountFingerprint')).toMatchObject({ set: true, sharesPayoutKey: false });
  });

  it('MFA secrets still round-trip under the fallback', () => {
    const blob = encryptMfaSecret('JBSWY3DPEHPK3PXP');
    expect(decryptMfaSecret(blob)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('the state report names variables and never carries a value', () => {
    for (const k of VARS) setVar(k, OTHER);
    const text = JSON.stringify(jobSecretStates());
    expect(text).not.toContain(OTHER);
    expect(text).not.toContain(env.PAYOUT_ENCRYPTION_KEY);
    expect(text).toContain('ACCOUNT_FINGERPRINT_SECRET');
  });
});
