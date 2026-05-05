-- Branch webhook hardening: idempotency log + Notification deeplink column.
--
-- Two changes in one migration since they ship together:
--
-- 1. New BranchWebhookEvent table — every inbound delivery is logged here
--    with the Branch event ID under a UNIQUE constraint. The handler
--    INSERTs first; a duplicate POST collapses on the unique violation
--    and the handler short-circuits to 200 OK without reprocessing.
--    Full raw payload preserved for finance audit.
--
-- 2. Notification.linkUrl — optional deeplink so IN_APP notifications
--    can navigate (e.g. payroll failure → "/payroll?run={runId}"). The
--    bell renders the row as a link when set; un-set means click only
--    marks-read.

-- CreateEnum
CREATE TYPE "BranchWebhookStatus" AS ENUM ('PROCESSED', 'IGNORED', 'DUPLICATE', 'ERROR');

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN "linkUrl" TEXT;

-- CreateTable
CREATE TABLE "BranchWebhookEvent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "branchEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "BranchWebhookStatus" NOT NULL DEFAULT 'PROCESSED',
    "payrollItemId" UUID,
    "notes" TEXT,
    "receivedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMPTZ(6),

    CONSTRAINT "BranchWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BranchWebhookEvent_branchEventId_key" ON "BranchWebhookEvent"("branchEventId");

-- CreateIndex
CREATE INDEX "BranchWebhookEvent_eventType_receivedAt_idx" ON "BranchWebhookEvent"("eventType", "receivedAt");

-- CreateIndex
CREATE INDEX "BranchWebhookEvent_status_receivedAt_idx" ON "BranchWebhookEvent"("status", "receivedAt");

-- AddForeignKey
ALTER TABLE "BranchWebhookEvent" ADD CONSTRAINT "BranchWebhookEvent_payrollItemId_fkey" FOREIGN KEY ("payrollItemId") REFERENCES "PayrollItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
