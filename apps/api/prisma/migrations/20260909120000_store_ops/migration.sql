-- Store Operations module: SOP library, supervisor-run ops shifts,
-- typed task responses with evidence, and shift-to-shift handover.

CREATE TYPE "OpsPeriod" AS ENUM ('MORNING', 'EVENING', 'CLOSING', 'OVERNIGHT');
CREATE TYPE "OpsShiftStatus" AS ENUM ('ACTIVE', 'CLOSED');
CREATE TYPE "OpsResponseType" AS ENUM ('CHECK', 'YES_NO', 'YES_NO_PARTIAL', 'TEXT', 'NUMBER', 'TEMPERATURE', 'PHOTO');
CREATE TYPE "OpsTaskSource" AS ENUM ('SOP', 'ADHOC', 'CARRYOVER');
CREATE TYPE "OpsTaskStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'DONE', 'BLOCKED');
CREATE TYPE "OpsPriority" AS ENUM ('HIGH', 'MEDIUM', 'LOW');
CREATE TYPE "OpsHandoverKind" AS ENUM ('NOTE', 'UNFINISHED_TASK', 'SPECIAL_ORDER', 'COACH_COMPLAINT', 'EQUIPMENT', 'STOCKING');
CREATE TYPE "OpsHandoverStatus" AS ENUM ('PENDING', 'CARRIED', 'DISMISSED', 'REVIEWED');

CREATE TABLE "OpsSopTemplate" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "department" VARCHAR(80) NOT NULL,
    "period" "OpsPeriod" NOT NULL,
    "description" VARCHAR(500),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "retiredAt" TIMESTAMPTZ(6),
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "OpsSopTemplate_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OpsSopTemplate_department_period_active_idx" ON "OpsSopTemplate"("department", "period", "active");
ALTER TABLE "OpsSopTemplate" ADD CONSTRAINT "OpsSopTemplate_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "OpsSopTemplateTask" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "templateId" UUID NOT NULL,
    "section" VARCHAR(80) NOT NULL,
    "order" INTEGER NOT NULL,
    "title" VARCHAR(300) NOT NULL,
    "instructions" VARCHAR(1000),
    "responseType" "OpsResponseType" NOT NULL DEFAULT 'CHECK',
    "required" BOOLEAN NOT NULL DEFAULT true,
    "photoRequired" BOOLEAN NOT NULL DEFAULT false,
    "tempLabel" VARCHAR(80),
    "tempMin" DECIMAL(6,1),
    "tempMax" DECIMAL(6,1),
    CONSTRAINT "OpsSopTemplateTask_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OpsSopTemplateTask_templateId_order_idx" ON "OpsSopTemplateTask"("templateId", "order");
ALTER TABLE "OpsSopTemplateTask" ADD CONSTRAINT "OpsSopTemplateTask_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "OpsSopTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "OpsShift" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clientId" UUID NOT NULL,
    "department" VARCHAR(80) NOT NULL,
    "period" "OpsPeriod" NOT NULL,
    "position" VARCHAR(120) NOT NULL,
    "dateKey" VARCHAR(10) NOT NULL,
    "status" "OpsShiftStatus" NOT NULL DEFAULT 'ACTIVE',
    "openedById" UUID NOT NULL,
    "openedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedById" UUID,
    "closedAt" TIMESTAMPTZ(6),
    "scheduledHeadcount" INTEGER NOT NULL DEFAULT 0,
    "actualHeadcount" INTEGER NOT NULL DEFAULT 0,
    "templateId" UUID,
    "templateName" VARCHAR(200),
    "sopTotal" INTEGER NOT NULL DEFAULT 0,
    "sopDone" INTEGER NOT NULL DEFAULT 0,
    "taskTotal" INTEGER NOT NULL DEFAULT 0,
    "taskDone" INTEGER NOT NULL DEFAULT 0,
    "closedIncomplete" BOOLEAN NOT NULL DEFAULT false,
    "tempAlerts" INTEGER NOT NULL DEFAULT 0,
    "closingSummary" VARCHAR(2000),
    CONSTRAINT "OpsShift_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OpsShift_clientId_dateKey_idx" ON "OpsShift"("clientId", "dateKey");
CREATE INDEX "OpsShift_clientId_department_status_idx" ON "OpsShift"("clientId", "department", "status");
CREATE INDEX "OpsShift_status_openedAt_idx" ON "OpsShift"("status", "openedAt");
ALTER TABLE "OpsShift" ADD CONSTRAINT "OpsShift_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OpsShift" ADD CONSTRAINT "OpsShift_openedById_fkey" FOREIGN KEY ("openedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OpsShift" ADD CONSTRAINT "OpsShift_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "OpsTask" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "opsShiftId" UUID NOT NULL,
    "source" "OpsTaskSource" NOT NULL DEFAULT 'SOP',
    "templateTaskId" UUID,
    "section" VARCHAR(80),
    "order" INTEGER NOT NULL DEFAULT 0,
    "title" VARCHAR(300) NOT NULL,
    "instructions" VARCHAR(1000),
    "priority" "OpsPriority" NOT NULL DEFAULT 'MEDIUM',
    "status" "OpsTaskStatus" NOT NULL DEFAULT 'OPEN',
    "responseType" "OpsResponseType" NOT NULL DEFAULT 'CHECK',
    "required" BOOLEAN NOT NULL DEFAULT true,
    "photoRequired" BOOLEAN NOT NULL DEFAULT false,
    "tempLabel" VARCHAR(80),
    "tempMin" DECIMAL(6,1),
    "tempMax" DECIMAL(6,1),
    "answerChoice" VARCHAR(10),
    "answerNumber" DECIMAL(12,2),
    "answerText" VARCHAR(2000),
    "tempOutOfRange" BOOLEAN NOT NULL DEFAULT false,
    "note" VARCHAR(1000),
    "blockedReason" VARCHAR(500),
    "doneAssociateId" UUID,
    "completedById" UUID,
    "completedAt" TIMESTAMPTZ(6),
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "OpsTask_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OpsTask_opsShiftId_order_idx" ON "OpsTask"("opsShiftId", "order");
CREATE INDEX "OpsTask_tempOutOfRange_idx" ON "OpsTask"("tempOutOfRange");
ALTER TABLE "OpsTask" ADD CONSTRAINT "OpsTask_opsShiftId_fkey" FOREIGN KEY ("opsShiftId") REFERENCES "OpsShift"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OpsTask" ADD CONSTRAINT "OpsTask_doneAssociateId_fkey" FOREIGN KEY ("doneAssociateId") REFERENCES "Associate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OpsTask" ADD CONSTRAINT "OpsTask_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OpsTask" ADD CONSTRAINT "OpsTask_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "OpsTaskPhoto" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "taskId" UUID NOT NULL,
    "s3Key" TEXT NOT NULL,
    "filename" VARCHAR(255) NOT NULL,
    "mimeType" VARCHAR(100) NOT NULL,
    "size" INTEGER NOT NULL,
    "uploadedById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OpsTaskPhoto_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OpsTaskPhoto_taskId_idx" ON "OpsTaskPhoto"("taskId");
ALTER TABLE "OpsTaskPhoto" ADD CONSTRAINT "OpsTaskPhoto_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "OpsTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OpsTaskPhoto" ADD CONSTRAINT "OpsTaskPhoto_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "OpsHandoverItem" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "fromShiftId" UUID NOT NULL,
    "kind" "OpsHandoverKind" NOT NULL DEFAULT 'NOTE',
    "body" VARCHAR(1000) NOT NULL,
    "priority" "OpsPriority" NOT NULL DEFAULT 'MEDIUM',
    "status" "OpsHandoverStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" UUID,
    "decidedAt" TIMESTAMPTZ(6),
    "decidedInShiftId" UUID,
    "carriedTaskId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OpsHandoverItem_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OpsHandoverItem_fromShiftId_status_idx" ON "OpsHandoverItem"("fromShiftId", "status");
ALTER TABLE "OpsHandoverItem" ADD CONSTRAINT "OpsHandoverItem_fromShiftId_fkey" FOREIGN KEY ("fromShiftId") REFERENCES "OpsShift"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OpsHandoverItem" ADD CONSTRAINT "OpsHandoverItem_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OpsHandoverItem" ADD CONSTRAINT "OpsHandoverItem_decidedInShiftId_fkey" FOREIGN KEY ("decidedInShiftId") REFERENCES "OpsShift"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OpsHandoverItem" ADD CONSTRAINT "OpsHandoverItem_carriedTaskId_fkey" FOREIGN KEY ("carriedTaskId") REFERENCES "OpsTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;
