-- Executive command center: statement payment tracking (receivables),
-- quarterly targets, and the new-business pipeline.

ALTER TABLE "ClientStatement"
  ADD COLUMN "paidAt" TIMESTAMPTZ(6),
  ADD COLUMN "paidById" UUID,
  ADD COLUMN "paymentRef" TEXT;

ALTER TABLE "ClientStatement"
  ADD CONSTRAINT "ClientStatement_paidById_fkey"
  FOREIGN KEY ("paidById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ExecTarget" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "quarter" VARCHAR(8) NOT NULL,
  "revenueTarget" DECIMAL(12,2),
  "marginTarget" DECIMAL(12,2),
  "headcountTarget" INTEGER,
  "turnoverPctTarget" DECIMAL(5,2),
  "fillRatePctTarget" DECIMAL(5,2),
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExecTarget_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ExecTarget_quarter_key" ON "ExecTarget"("quarter");

CREATE TYPE "ProspectStage" AS ENUM ('LEAD', 'CONTACTED', 'PROPOSAL', 'VERBAL', 'WON', 'LOST');

CREATE TABLE "ClientProspect" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "stage" "ProspectStage" NOT NULL DEFAULT 'LEAD',
  "estWeeklyHours" INTEGER,
  "estBillRate" DECIMAL(8,2),
  "notes" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  "deletedAt" TIMESTAMPTZ(6),
  CONSTRAINT "ClientProspect_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ClientProspect_stage_idx" ON "ClientProspect"("stage");
