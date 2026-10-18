-- Labor rules go live state by state, and timekeeping controls.
--
--   LaborRuleActivation   a tenant's decision to pay a jurisdiction (or one
--                         site) by the engine: counsel's sign-off, a second
--                         person, the exact rule-set rows signed (frozen).
--   ScheduleChangePremium predictability pay owed for a late schedule change.
--   PunchRoundingPolicy   neutral rounding, applied at payroll only.
--   TimeCorrectionRequest a worker's missed-punch / correction request with
--                         their signed attestation.
--   BreakAttestation      "did you get your meal break?" at clock-out.
--   OvertimeOffer         overtime offered fewest-overtime-first.

ALTER TYPE "PayrollEarningKind" ADD VALUE IF NOT EXISTS 'PREMIUM';
ALTER TYPE "ApprovalRequestKind" ADD VALUE IF NOT EXISTS 'LABOR_RULES_LIVE';

ALTER TABLE "OrgSetting" ADD COLUMN "otEqualization" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "LaborRuleActivation" (
  "id"                UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"          UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "jurisdiction"      VARCHAR(60) NOT NULL,
  "siteId"            UUID,
  "status"            VARCHAR(12) NOT NULL DEFAULT 'PENDING',
  "signedSetIds"      TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "signedLabels"      TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "counselName"       VARCHAR(120) NOT NULL,
  "counselFirm"       VARCHAR(160) NOT NULL,
  "counselSignedOn"   DATE NOT NULL,
  "attestation"       VARCHAR(2000) NOT NULL,
  "changeReport"      JSONB,
  "approvalRequestId" UUID,
  "requestedById"     UUID,
  "activatedById"     UUID,
  "activatedAt"       TIMESTAMPTZ(6),
  "endedById"         UUID,
  "endedAt"           TIMESTAMPTZ(6),
  "endReason"         VARCHAR(500),
  "createdAt"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "LaborRuleActivation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "LaborRuleActivation_tenantId_jurisdiction_status_idx" ON "LaborRuleActivation"("tenantId", "jurisdiction", "status");
CREATE INDEX "LaborRuleActivation_approvalRequestId_idx" ON "LaborRuleActivation"("approvalRequestId");

CREATE TABLE "ScheduleChangePremium" (
  "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"      UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "associateId"   UUID NOT NULL,
  "shiftId"       UUID,
  "siteId"        UUID,
  "workDate"      DATE NOT NULL,
  "change"        VARCHAR(12) NOT NULL,
  "noticeDays"    DECIMAL(6,2) NOT NULL,
  "hoursAffected" DECIMAL(6,2) NOT NULL DEFAULT 0,
  "premiumHours"  DECIMAL(6,2) NOT NULL DEFAULT 0,
  "premiumCents"  INTEGER NOT NULL DEFAULT 0,
  "exempt"        BOOLEAN NOT NULL DEFAULT false,
  "exemptReason"  VARCHAR(40),
  "reasonText"    VARCHAR(500),
  "rule"          VARCHAR(300) NOT NULL,
  "live"          BOOLEAN NOT NULL DEFAULT false,
  "payrollRunId"  UUID,
  "createdById"   UUID,
  "createdAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "ScheduleChangePremium_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ScheduleChangePremium_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ScheduleChangePremium_tenantId_associateId_workDate_idx" ON "ScheduleChangePremium"("tenantId", "associateId", "workDate");
CREATE INDEX "ScheduleChangePremium_payrollRunId_idx" ON "ScheduleChangePremium"("payrollRunId");

CREATE TABLE "PunchRoundingPolicy" (
  "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"    UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "siteId"      UUID,
  "mode"        VARCHAR(16) NOT NULL DEFAULT 'NONE',
  "increment"   INTEGER NOT NULL DEFAULT 15,
  "updatedById" UUID,
  "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "PunchRoundingPolicy_pkey" PRIMARY KEY ("id")
);
-- One tenant-wide row (siteId NULL) and at most one per site.
CREATE UNIQUE INDEX "PunchRoundingPolicy_tenant_default_key" ON "PunchRoundingPolicy"("tenantId") WHERE "siteId" IS NULL;
CREATE UNIQUE INDEX "PunchRoundingPolicy_tenantId_siteId_key" ON "PunchRoundingPolicy"("tenantId", "siteId");

CREATE TABLE "TimeCorrectionRequest" (
  "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"         UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "associateId"      UUID NOT NULL,
  "timeEntryId"      UUID,
  "kind"             VARCHAR(20) NOT NULL,
  "status"           VARCHAR(12) NOT NULL DEFAULT 'SUBMITTED',
  "workDate"         DATE,
  "siteId"           UUID,
  "proposedClockIn"  TIMESTAMPTZ(6),
  "proposedClockOut" TIMESTAMPTZ(6),
  "reason"           VARCHAR(1000),
  "attestationText"  VARCHAR(1000),
  "attestedAt"       TIMESTAMPTZ(6),
  "attestationIp"    VARCHAR(64),
  "attestationUa"    VARCHAR(300),
  "before"           JSONB,
  "after"            JSONB,
  "decidedById"      UUID,
  "decidedAt"        TIMESTAMPTZ(6),
  "decisionReason"   VARCHAR(1000),
  "createdAt"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "TimeCorrectionRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TimeCorrectionRequest_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "TimeCorrectionRequest_tenantId_status_idx" ON "TimeCorrectionRequest"("tenantId", "status");
CREATE INDEX "TimeCorrectionRequest_associateId_status_idx" ON "TimeCorrectionRequest"("associateId", "status");

CREATE TABLE "BreakAttestation" (
  "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"      UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "timeEntryId"   UUID NOT NULL,
  "associateId"   UUID NOT NULL,
  "meal"          VARCHAR(8) NOT NULL,
  "rest"          VARCHAR(8),
  "note"          VARCHAR(500),
  "flagged"       BOOLEAN NOT NULL DEFAULT false,
  "createdAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "BreakAttestation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BreakAttestation_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "BreakAttestation_timeEntryId_key" ON "BreakAttestation"("timeEntryId");
CREATE INDEX "BreakAttestation_tenantId_flagged_idx" ON "BreakAttestation"("tenantId", "flagged");

CREATE TABLE "OvertimeOffer" (
  "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"        UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "shiftId"         UUID NOT NULL,
  "associateId"     UUID NOT NULL,
  "rank"            INTEGER NOT NULL,
  "overtimeHoursInPeriod" DECIMAL(8,2) NOT NULL DEFAULT 0,
  "wouldAddOvertimeHours" DECIMAL(8,2) NOT NULL DEFAULT 0,
  "status"          VARCHAR(10) NOT NULL DEFAULT 'OFFERED',
  "offeredById"     UUID,
  "offeredAt"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "respondedAt"     TIMESTAMPTZ(6),
  "note"            VARCHAR(500),
  CONSTRAINT "OvertimeOffer_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OvertimeOffer_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "OvertimeOffer_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "OvertimeOffer_tenantId_offeredAt_idx" ON "OvertimeOffer"("tenantId", "offeredAt");
CREATE INDEX "OvertimeOffer_shiftId_idx" ON "OvertimeOffer"("shiftId");
