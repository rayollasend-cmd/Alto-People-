-- TOTP MFA enrollment.
-- Two columns on User and a new MfaRecoveryCode table. Strictly additive; no
-- backfill required. mfaEnabledAt being non-null is the canonical "MFA is on"
-- flag — login enforcement is wired in a follow-up PR. mfaSecretEncrypted
-- holds AES-256-GCM ciphertext (version + iv + ct + tag) of the base32
-- secret; the key is MFA_SECRET_ENCRYPTION_KEY (falls back to
-- PAYOUT_ENCRYPTION_KEY in dev so existing envs keep working).

ALTER TABLE "User" ADD COLUMN "mfaSecretEncrypted" BYTEA;
ALTER TABLE "User" ADD COLUMN "mfaEnabledAt" TIMESTAMPTZ(6);

-- Recovery codes: only sha256(code) is stored. usedAt nullable so we keep a
-- forensic trail of which code was consumed without permitting reuse.
CREATE TABLE "MfaRecoveryCode" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MfaRecoveryCode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MfaRecoveryCode_codeHash_key" ON "MfaRecoveryCode"("codeHash");

CREATE INDEX "MfaRecoveryCode_userId_usedAt_idx" ON "MfaRecoveryCode"("userId", "usedAt");

ALTER TABLE "MfaRecoveryCode" ADD CONSTRAINT "MfaRecoveryCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
