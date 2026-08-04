-- Account lockout + org-enforced MFA policy. Strictly additive.
--
-- Lockout: failedLoginCount increments on every wrong-password attempt;
-- when it reaches 10 the account locks for 15 minutes via lockedUntil.
-- Both reset on a successful password verification. Persistent on purpose —
-- the in-memory per-email rate limiter resets on every deploy, this does
-- not. Passkey (WebAuthn) sign-in ignores both columns.
ALTER TABLE "User" ADD COLUMN "failedLoginCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "lockedUntil" TIMESTAMPTZ(6);

-- Org-wide MFA policy on the OrgSetting singleton. OFF = opt-in only,
-- ADMINS = admin-class roles (derived from capabilities, see
-- isMfaAdminRole in packages/shared) must enroll TOTP to complete a
-- password sign-in, ALL = every human role. Default OFF preserves
-- existing behavior for all orgs.
CREATE TYPE "MfaRequirement" AS ENUM ('OFF', 'ADMINS', 'ALL');
ALTER TABLE "OrgSetting" ADD COLUMN "mfaRequirement" "MfaRequirement" NOT NULL DEFAULT 'OFF';
