-- Ops intelligence batch: attendance points, OT-radar alert stamps, and
-- client billing/SLA statements.

CREATE TYPE "AttendanceKind" AS ENUM ('LATE', 'EARLY_OUT', 'CALL_OUT', 'NO_CALL_NO_SHOW');

CREATE TABLE "AttendanceEvent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "associateId" UUID NOT NULL,
    "shiftId" UUID,
    "clientId" UUID,
    "kind" "AttendanceKind" NOT NULL,
    "points" DECIMAL(4,1) NOT NULL,
    "occurredOn" DATE NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'AUTO',
    "note" TEXT,
    "excusedById" UUID,
    "excusedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "AttendanceEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AttendanceEvent_shiftId_kind_key" ON "AttendanceEvent"("shiftId", "kind");
CREATE INDEX "AttendanceEvent_associateId_occurredOn_idx" ON "AttendanceEvent"("associateId", "occurredOn");
CREATE INDEX "AttendanceEvent_clientId_occurredOn_idx" ON "AttendanceEvent"("clientId", "occurredOn");

ALTER TABLE "AttendanceEvent" ADD CONSTRAINT "AttendanceEvent_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AttendanceEvent" ADD CONSTRAINT "AttendanceEvent_excusedById_fkey" FOREIGN KEY ("excusedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "OtAlertStamp" (
    "associateId" UUID NOT NULL,
    "weekStart" DATE NOT NULL,
    "notifiedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OtAlertStamp_pkey" PRIMARY KEY ("associateId", "weekStart")
);

ALTER TABLE "OtAlertStamp" ADD CONSTRAINT "OtAlertStamp_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ClientStatement" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clientId" UUID NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "number" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "snapshot" JSONB NOT NULL,
    "finalizedById" UUID,
    "finalizedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ClientStatement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ClientStatement_clientId_periodStart_periodEnd_key" ON "ClientStatement"("clientId", "periodStart", "periodEnd");
CREATE INDEX "ClientStatement_clientId_status_idx" ON "ClientStatement"("clientId", "status");

ALTER TABLE "ClientStatement" ADD CONSTRAINT "ClientStatement_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClientStatement" ADD CONSTRAINT "ClientStatement_finalizedById_fkey" FOREIGN KEY ("finalizedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
