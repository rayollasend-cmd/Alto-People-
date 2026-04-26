-- AlterTable
ALTER TABLE "InviteToken" ADD COLUMN     "reminderSentAt" TIMESTAMPTZ(6);

-- CreateIndex
CREATE INDEX "InviteToken_consumedAt_reminderSentAt_createdAt_idx" ON "InviteToken"("consumedAt", "reminderSentAt", "createdAt");
