-- Email language preference, Finance settings, retire-not-overwrite payout
-- methods, and the financial-change ledger + packet download log.

-- CreateEnum
CREATE TYPE "FinancialChangeKind" AS ENUM ('BANK_ACCOUNT', 'PAY_CARD', 'PAY_METHOD', 'W4', 'LEGAL_NAME', 'SSN', 'HOME_ADDRESS');

-- CreateEnum
CREATE TYPE "FinancialChangeSource" AS ENUM ('SELF', 'ADMIN', 'ONBOARDING');

-- CreateEnum
CREATE TYPE "FinancialChangeStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED', 'HELD');

-- CreateEnum
CREATE TYPE "UnverifiedPayoutPolicy" AS ENUM ('PREVIOUS_VERIFIED', 'HOLD');

-- AlterTable
ALTER TABLE "User" ADD COLUMN "language" VARCHAR(2);

-- AlterTable
ALTER TABLE "OrgSetting" ADD COLUMN "financeMailbox" VARCHAR(254),
ADD COLUMN "unverifiedPayoutPolicy" "UnverifiedPayoutPolicy" NOT NULL DEFAULT 'PREVIOUS_VERIFIED';

-- AlterTable
ALTER TABLE "PayoutMethod" ADD COLUMN "retiredAt" TIMESTAMPTZ(6),
ADD COLUMN "verifiedById" UUID,
ADD COLUMN "accountLast4" VARCHAR(4),
ADD COLUMN "accountFingerprint" VARCHAR(64);

-- Grandfather every account payroll is already paying into. Before this
-- change nothing set verifiedAt, and an unverified method is now held back
-- from payroll; treating the accounts in use as verified as of this deploy
-- is what keeps the next run paying everyone. New changes start unverified.
UPDATE "PayoutMethod" SET "verifiedAt" = COALESCE("verifiedAt", "updatedAt") WHERE "retiredAt" IS NULL;

-- CreateTable
CREATE TABLE "FinancialChange" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "associateId" UUID NOT NULL,
    "kind" "FinancialChangeKind" NOT NULL,
    "source" "FinancialChangeSource" NOT NULL,
    "actorUserId" UUID,
    "actorRole" VARCHAR(40),
    "onBehalf" BOOLEAN NOT NULL DEFAULT false,
    "ip" VARCHAR(64),
    "userAgent" VARCHAR(512),
    "authStrength" VARCHAR(16) NOT NULL DEFAULT 'UNKNOWN',
    "oldSummary" VARCHAR(200),
    "newSummary" VARCHAR(200),
    "oldPayoutMethodId" UUID,
    "newPayoutMethodId" UUID,
    "riskFlags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "riskScore" INTEGER NOT NULL DEFAULT 0,
    "highRisk" BOOLEAN NOT NULL DEFAULT false,
    "status" "FinancialChangeStatus" NOT NULL DEFAULT 'PENDING',
    "verifyPhoneLast4" VARCHAR(4),
    "verifiedById" UUID,
    "verifiedAt" TIMESTAMPTZ(6),
    "verifiedVia" VARCHAR(32),
    "verificationNote" VARCHAR(1000),
    "financeNotifiedAt" TIMESTAMPTZ(6),
    "associateNotifiedAt" TIMESTAMPTZ(6),
    "priorContactNotifiedAt" TIMESTAMPTZ(6),
    "acknowledgedAt" TIMESTAMPTZ(6),
    "acknowledgedById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "FinancialChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PacketDownload" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "format" VARCHAR(8) NOT NULL,
    "from" TIMESTAMPTZ(6) NOT NULL,
    "to" TIMESTAMPTZ(6) NOT NULL,
    "clientId" UUID,
    "locationId" UUID,
    "associateId" UUID,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "associateCount" INTEGER NOT NULL DEFAULT 0,
    "changeCount" INTEGER NOT NULL DEFAULT 0,
    "unverifiedCount" INTEGER NOT NULL DEFAULT 0,
    "acknowledgedChangeIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ip" VARCHAR(64),
    "userAgent" VARCHAR(512),
    "watermark" VARCHAR(200) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PacketDownload_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PayoutMethod_associateId_isPrimary_retiredAt_idx" ON "PayoutMethod"("associateId", "isPrimary", "retiredAt");

-- CreateIndex
CREATE INDEX "PayoutMethod_accountFingerprint_idx" ON "PayoutMethod"("accountFingerprint");

-- CreateIndex
CREATE INDEX "FinancialChange_status_createdAt_idx" ON "FinancialChange"("status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "FinancialChange_associateId_createdAt_idx" ON "FinancialChange"("associateId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "FinancialChange_createdAt_idx" ON "FinancialChange"("createdAt");

-- CreateIndex
CREATE INDEX "PacketDownload_createdAt_idx" ON "PacketDownload"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "PacketDownload_userId_createdAt_idx" ON "PacketDownload"("userId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "FinancialChange" ADD CONSTRAINT "FinancialChange_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialChange" ADD CONSTRAINT "FinancialChange_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialChange" ADD CONSTRAINT "FinancialChange_verifiedById_fkey" FOREIGN KEY ("verifiedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PacketDownload" ADD CONSTRAINT "PacketDownload_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
