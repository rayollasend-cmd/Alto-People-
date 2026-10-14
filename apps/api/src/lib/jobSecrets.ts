import { env } from '../config/env.js';

/**
 * Brief 2-5, step 2 — one secret per job.
 *
 *   PAYOUT_ENCRYPTION_KEY encrypts fields. Until now it was also the HMAC
 *   secret for the bank-account fingerprint and the fallback for the MFA
 *   key, the kiosk PIN lookup and the pulse-survey responder hash, so a
 *   rotation of the field key would have silently broken four other
 *   things (the QuickBooks lesson). Each job now reads its own variable.
 *
 *   Deploy safety: a job whose variable is unset FALLS BACK to the payout
 *   key, exactly as before, so every stored fingerprint, PIN lookup,
 *   survey hash and MFA secret keeps working byte for byte. The owner sets
 *   each variable in Railway to today's payout key value (no change on the
 *   day), then turns on REQUIRE_SPLIT_SECRETS=1 so boot refuses a missing
 *   one; only after that can the field key rotate alone. Runbook:
 *   docs/runbooks/job-secrets.md.
 *
 *   Values are never logged or recorded; only which variables are set.
 */

export const SECRET_JOBS = ['mfa', 'kioskPin', 'pulseHash', 'accountFingerprint'] as const;
export type SecretJob = (typeof SECRET_JOBS)[number];

export const SECRET_JOB_VARS: Record<SecretJob, 'MFA_SECRET_ENCRYPTION_KEY' | 'KIOSK_PIN_SECRET' | 'PULSE_HASH_SECRET' | 'ACCOUNT_FINGERPRINT_SECRET'> = {
  mfa: 'MFA_SECRET_ENCRYPTION_KEY',
  kioskPin: 'KIOSK_PIN_SECRET',
  pulseHash: 'PULSE_HASH_SECRET',
  accountFingerprint: 'ACCOUNT_FINGERPRINT_SECRET',
};

/** The secret a job uses: its own variable, else the payout key (today's behaviour). */
export function jobSecret(job: SecretJob): string {
  return env[SECRET_JOB_VARS[job]] ?? env.PAYOUT_ENCRYPTION_KEY;
}

export interface JobSecretState {
  job: SecretJob;
  variable: string;
  /** Its own variable is set. */
  set: boolean;
  /** It resolves to the same value as the payout key (by fallback or because it was set to it). */
  sharesPayoutKey: boolean;
}

/** Which jobs have their own secret. Never returns a value. */
export function jobSecretStates(): JobSecretState[] {
  return SECRET_JOBS.map((job) => {
    const own = env[SECRET_JOB_VARS[job]];
    return { job, variable: SECRET_JOB_VARS[job], set: own !== undefined, sharesPayoutKey: (own ?? env.PAYOUT_ENCRYPTION_KEY) === env.PAYOUT_ENCRYPTION_KEY };
  });
}

/** The variables still falling back to the payout key. */
export function unsetJobSecrets(): string[] {
  return jobSecretStates().filter((s) => !s.set).map((s) => s.variable);
}
