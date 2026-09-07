-- The collaboration wave: client requests (the client in the loop),
-- cohorts (seasonal waves on the relay), and decision receipts on
-- work-note threads.

CREATE TYPE "ClientRequestKind" AS ENUM ('STAFFING', 'FEEDBACK', 'ISSUE');
CREATE TYPE "ClientRequestStatus" AS ENUM ('RECEIVED', 'IN_PROGRESS', 'RESOLVED');

CREATE TABLE "ClientRequest" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clientId" UUID NOT NULL,
    "kind" "ClientRequestKind" NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "ClientRequestStatus" NOT NULL DEFAULT 'RECEIVED',
    "createdByUserId" UUID,
    "resolvedById" UUID,
    "resolution" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMPTZ(6),

    CONSTRAINT "ClientRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ClientRequest_clientId_createdAt_idx"
    ON "ClientRequest"("clientId", "createdAt" DESC);
CREATE INDEX "ClientRequest_status_idx" ON "ClientRequest"("status");

ALTER TABLE "ClientRequest"
    ADD CONSTRAINT "ClientRequest_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClientRequest"
    ADD CONSTRAINT "ClientRequest_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ClientRequest"
    ADD CONSTRAINT "ClientRequest_resolvedById_fkey"
    FOREIGN KEY ("resolvedById") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "Cohort" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "clientId" UUID,
    "targetHeadcount" INTEGER NOT NULL,
    "landByDate" DATE NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" TIMESTAMPTZ(6),

    CONSTRAINT "Cohort_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Cohort_archivedAt_idx" ON "Cohort"("archivedAt");

ALTER TABLE "Cohort"
    ADD CONSTRAINT "Cohort_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Cohort"
    ADD CONSTRAINT "Cohort_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Application" ADD COLUMN "cohortId" UUID;
CREATE INDEX "Application_cohortId_idx" ON "Application"("cohortId");
ALTER TABLE "Application"
    ADD CONSTRAINT "Application_cohortId_fkey"
    FOREIGN KEY ("cohortId") REFERENCES "Cohort"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Decisions with receipts on threads.
ALTER TABLE "WorkNote" ADD COLUMN "decisionDesk" TEXT;
ALTER TABLE "WorkNote" ADD COLUMN "decisionStatus" TEXT;
ALTER TABLE "WorkNote" ADD COLUMN "decidedById" UUID;
ALTER TABLE "WorkNote" ADD COLUMN "decidedAt" TIMESTAMPTZ(6);
ALTER TABLE "WorkNote" ADD COLUMN "decisionNote" TEXT;

CREATE INDEX "WorkNote_decisionStatus_decisionDesk_idx"
    ON "WorkNote"("decisionStatus", "decisionDesk");

ALTER TABLE "WorkNote"
    ADD CONSTRAINT "WorkNote_decidedById_fkey"
    FOREIGN KEY ("decidedById") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
