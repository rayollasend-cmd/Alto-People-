-- OSHA 300-style safety incident log — scorecard tile 7 (safety).

CREATE TYPE "SafetyIncidentOutcome" AS ENUM (
    'NEAR_MISS',
    'FIRST_AID_ONLY',
    'MEDICAL_TREATMENT',
    'RESTRICTED_DUTY',
    'DAYS_AWAY',
    'LOSS_OF_CONSCIOUSNESS',
    'FATALITY'
);

CREATE TYPE "SafetyIncidentStatus" AS ENUM ('OPEN', 'CLOSED');

CREATE TABLE "SafetyIncident" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "associateId" UUID NOT NULL,
    "clientId" UUID,
    "occurredAt" TIMESTAMPTZ(6) NOT NULL,
    "location" TEXT,
    "description" TEXT NOT NULL,
    "outcome" "SafetyIncidentOutcome" NOT NULL,
    "recordable" BOOLEAN NOT NULL,
    "daysAway" INTEGER NOT NULL DEFAULT 0,
    "daysRestricted" INTEGER NOT NULL DEFAULT 0,
    "status" "SafetyIncidentStatus" NOT NULL DEFAULT 'OPEN',
    "closedAt" TIMESTAMPTZ(6),
    "closureNotes" TEXT,
    "reportedById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "SafetyIncident_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SafetyIncident_occurredAt_idx" ON "SafetyIncident"("occurredAt" DESC);
CREATE INDEX "SafetyIncident_clientId_occurredAt_idx" ON "SafetyIncident"("clientId", "occurredAt" DESC);
CREATE INDEX "SafetyIncident_status_idx" ON "SafetyIncident"("status");
CREATE INDEX "SafetyIncident_associateId_idx" ON "SafetyIncident"("associateId");

ALTER TABLE "SafetyIncident" ADD CONSTRAINT "SafetyIncident_associateId_fkey"
    FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SafetyIncident" ADD CONSTRAINT "SafetyIncident_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SafetyIncident" ADD CONSTRAINT "SafetyIncident_reportedById_fkey"
    FOREIGN KEY ("reportedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
