# Runbook: one secret per job (Brief 2-5, step 2)

`PAYOUT_ENCRYPTION_KEY` encrypts sensitive fields (SSNs, bank accounts, TINs, I-9 numbers, kiosk numbers, QuickBooks tokens). Until this change it was also the secret behind four other jobs, so rotating it would have silently broken them. Each job now reads its own variable (`apps/api/src/lib/jobSecrets.ts`).

| Job | Variable | Used by |
|---|---|---|
| MFA secrets (encrypt and decrypt) | `MFA_SECRET_ENCRYPTION_KEY` | `lib/mfaCrypto.ts` |
| Kiosk PIN lookup (HMAC) | `KIOSK_PIN_SECRET` | `lib/kioskAuth.ts` |
| Pulse-survey responder hash (HMAC) | `PULSE_HASH_SECRET` | `routes/pulseSurveys109.ts` |
| Bank-account fingerprint (HMAC, shared-account check) | `ACCOUNT_FINGERPRINT_SECRET` (new) | `lib/financialChanges.ts` |

Production already refuses to boot without `MFA_SECRET_ENCRYPTION_KEY` and `KIOSK_PIN_SECRET`, so those two are set today. `PULSE_HASH_SECRET` and `ACCOUNT_FINGERPRINT_SECRET` may still be falling back.

## How the fallback works

A job whose variable is unset uses `PAYOUT_ENCRYPTION_KEY`, exactly as before. Every stored fingerprint, PIN lookup, survey hash and MFA secret keeps matching. The API logs one warning at boot naming the unset variables (never a value). The daily evidence sweep records the same names on the Compliance evidence page (control `job-secrets-separated`, WARN while any is unset, PASS when all are set).

## Rollout (no change for anyone on the day)

1. In Railway (API service, production), for each variable that is **not** already set, add it with **exactly the current value of `PAYOUT_ENCRYPTION_KEY`**. Do not generate a new value: an HMAC secret with a new value changes every lookup it produces.
   - `ACCOUNT_FINGERPRINT_SECRET` = the current `PAYOUT_ENCRYPTION_KEY` value.
   - `PULSE_HASH_SECRET` = the current `PAYOUT_ENCRYPTION_KEY` value, if it is not set.
   - Leave `MFA_SECRET_ENCRYPTION_KEY` and `KIOSK_PIN_SECRET` as they are.
2. Redeploy. The boot warning disappears. The next evidence sweep (within an hour of the next day's first run) records PASS.
3. Add `REQUIRE_SPLIT_SECRETS=1`. From then on the API refuses to start if any of the four is missing, so a later change cannot quietly fall back again.
4. Only after step 3 may the field-encryption key rotate (Brief 2-5 step 3, the keyring). The four jobs no longer depend on it.

## Rotating one of these secrets later

Each is rotated on its own, and each has a different cost, because an HMAC with a new secret produces new values:

- **Kiosk PIN secret:** every issued kiosk number must be re-issued (Kiosk admin, Rotate). Plan it with the store managers.
- **Pulse-survey hash:** open surveys lose duplicate-response protection for responses already given; rotate between surveys.
- **Account fingerprint:** the shared-bank-account check stops matching existing rows until they are re-fingerprinted; a re-fingerprint script is part of that rotation, not of this rollout.
- **MFA key:** stored MFA secrets must be re-encrypted (decrypt with the old key, encrypt with the new) before the old key is removed, or users re-enroll.

## Verify

- The boot log has no "falling back to PAYOUT_ENCRYPTION_KEY" warning.
- The Compliance evidence page shows `job-secrets-separated` as PASS.
- A kiosk punch, a pulse-survey response and an MFA sign-in still work (nothing changed if the values were copied exactly).
