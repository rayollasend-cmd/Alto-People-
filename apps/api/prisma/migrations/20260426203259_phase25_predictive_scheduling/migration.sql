-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "state" VARCHAR(2);

-- AlterTable
ALTER TABLE "Shift" ADD COLUMN     "lateNoticeReason" TEXT,
ADD COLUMN     "publishedAt" TIMESTAMPTZ(6);
