-- AlterEnum
ALTER TYPE "DocumentKind" ADD VALUE 'SIGNED_AGREEMENT';

-- AlterTable
ALTER TABLE "Signature" ADD COLUMN     "agreementId" UUID,
ADD COLUMN     "pdfHash" TEXT,
ADD COLUMN     "typedName" TEXT;

-- CreateTable
CREATE TABLE "EsignAgreement" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "applicationId" UUID NOT NULL,
    "taskId" UUID,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signedAt" TIMESTAMPTZ(6),
    "signatureId" UUID,

    CONSTRAINT "EsignAgreement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EsignAgreement_applicationId_idx" ON "EsignAgreement"("applicationId");

-- CreateIndex
CREATE INDEX "EsignAgreement_taskId_idx" ON "EsignAgreement"("taskId");

-- CreateIndex
CREATE INDEX "EsignAgreement_signedAt_idx" ON "EsignAgreement"("signedAt");

-- CreateIndex
CREATE INDEX "Signature_agreementId_idx" ON "Signature"("agreementId");

-- AddForeignKey
ALTER TABLE "Signature" ADD CONSTRAINT "Signature_agreementId_fkey" FOREIGN KEY ("agreementId") REFERENCES "EsignAgreement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EsignAgreement" ADD CONSTRAINT "EsignAgreement_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EsignAgreement" ADD CONSTRAINT "EsignAgreement_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "OnboardingTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EsignAgreement" ADD CONSTRAINT "EsignAgreement_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
