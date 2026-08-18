-- Schedule-gated kiosk clock-ins: when the kiosk refuses an unscheduled
-- punch, the attempt parks here for a supervisor to approve (backdated
-- ACTIVE time entry) or deny.

CREATE TYPE "ClockInRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED');

CREATE TABLE "ClockInRequest" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "associateId" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "locationId" UUID,
    "requestedAt" TIMESTAMPTZ(6) NOT NULL,
    "status" "ClockInRequestStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" UUID,
    "decidedAt" TIMESTAMPTZ(6),
    "denyReason" TEXT,
    "timeEntryId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ClockInRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ClockInRequest_status_requestedAt_idx" ON "ClockInRequest"("status", "requestedAt");
CREATE INDEX "ClockInRequest_associateId_status_idx" ON "ClockInRequest"("associateId", "status");
CREATE INDEX "ClockInRequest_clientId_status_idx" ON "ClockInRequest"("clientId", "status");

ALTER TABLE "ClockInRequest" ADD CONSTRAINT "ClockInRequest_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClockInRequest" ADD CONSTRAINT "ClockInRequest_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
