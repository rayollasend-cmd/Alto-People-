-- Brief 1D-2 — Agent registry, permissions and audit trail.
--
-- Additive: an AGENT worker gains a profile, credentials, approval
-- requests and spend records. AuditLog becomes append-only at the
-- database: the only change a row may ever see is its actor reference
-- going NULL when that account is removed (the FK's ON DELETE SET NULL).

CREATE TYPE "AgentEnvironment" AS ENUM ('PRODUCTION', 'STAGING', 'DEVELOPMENT');
CREATE TYPE "AgentGatedAction" AS ENUM ('PAY_CHANGE', 'SEPARATION', 'CLIENT_MESSAGE', 'DATA_EXPORT');
CREATE TYPE "AgentApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CONSUMED', 'EXPIRED');

CREATE TABLE "AgentProfile" (
  "workerId"           UUID NOT NULL,
  "purpose"            VARCHAR(500) NOT NULL,
  "vendor"             VARCHAR(80) NOT NULL,
  "model"              VARCHAR(120) NOT NULL,
  "modelVersion"       VARCHAR(80) NOT NULL,
  "environment"        "AgentEnvironment" NOT NULL DEFAULT 'PRODUCTION',
  "scopes"             TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "spendCapCents"      INTEGER,
  "rateLimitPerMinute" INTEGER NOT NULL DEFAULT 60,
  "allowedHoursStart"  INTEGER,
  "allowedHoursEnd"    INTEGER,
  "builtInKey"         VARCHAR(60),
  "lastActiveAt"       TIMESTAMPTZ(6),
  "createdAt"          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "AgentProfile_pkey" PRIMARY KEY ("workerId")
);
CREATE UNIQUE INDEX "AgentProfile_builtInKey_key" ON "AgentProfile"("builtInKey");
ALTER TABLE "AgentProfile" ADD CONSTRAINT "AgentProfile_workerId_fkey"
  FOREIGN KEY ("workerId") REFERENCES "Worker"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AgentCredential" (
  "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
  "workerId"      UUID NOT NULL,
  "tokenHash"     VARCHAR(64) NOT NULL,
  "last4"         VARCHAR(4) NOT NULL,
  "issuedById"    UUID,
  "rotatedFromId" UUID,
  "issuedAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt"     TIMESTAMPTZ(6) NOT NULL,
  "lastUsedAt"    TIMESTAMPTZ(6),
  "revokedAt"     TIMESTAMPTZ(6),
  "revokedReason" VARCHAR(200),
  CONSTRAINT "AgentCredential_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AgentCredential_tokenHash_key" ON "AgentCredential"("tokenHash");
CREATE UNIQUE INDEX "AgentCredential_rotatedFromId_key" ON "AgentCredential"("rotatedFromId");
CREATE INDEX "AgentCredential_workerId_revokedAt_idx" ON "AgentCredential"("workerId", "revokedAt");
ALTER TABLE "AgentCredential" ADD CONSTRAINT "AgentCredential_workerId_fkey"
  FOREIGN KEY ("workerId") REFERENCES "AgentProfile"("workerId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentCredential" ADD CONSTRAINT "AgentCredential_issuedById_fkey"
  FOREIGN KEY ("issuedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "AgentApprovalRequest" (
  "id"           UUID NOT NULL DEFAULT gen_random_uuid(),
  "workerId"     UUID NOT NULL,
  "action"       "AgentGatedAction" NOT NULL,
  "summary"      VARCHAR(500) NOT NULL,
  "payload"      JSONB NOT NULL,
  "payloadHash"  VARCHAR(64) NOT NULL,
  "status"       "AgentApprovalStatus" NOT NULL DEFAULT 'PENDING',
  "requestedAt"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt"    TIMESTAMPTZ(6) NOT NULL,
  "decidedById"  UUID,
  "decidedAt"    TIMESTAMPTZ(6),
  "decisionNote" VARCHAR(500),
  "consumedAt"   TIMESTAMPTZ(6),
  CONSTRAINT "AgentApprovalRequest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AgentApprovalRequest_status_requestedAt_idx" ON "AgentApprovalRequest"("status", "requestedAt");
CREATE INDEX "AgentApprovalRequest_workerId_requestedAt_idx" ON "AgentApprovalRequest"("workerId", "requestedAt" DESC);
ALTER TABLE "AgentApprovalRequest" ADD CONSTRAINT "AgentApprovalRequest_workerId_fkey"
  FOREIGN KEY ("workerId") REFERENCES "AgentProfile"("workerId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentApprovalRequest" ADD CONSTRAINT "AgentApprovalRequest_decidedById_fkey"
  FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "AgentSpend" (
  "id"           UUID NOT NULL DEFAULT gen_random_uuid(),
  "workerId"     UUID NOT NULL,
  "occurredAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "amountCents"  INTEGER NOT NULL,
  "taskRef"      VARCHAR(120),
  "note"         VARCHAR(300),
  "recordedById" UUID,
  CONSTRAINT "AgentSpend_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AgentSpend_workerId_occurredAt_idx" ON "AgentSpend"("workerId", "occurredAt" DESC);
ALTER TABLE "AgentSpend" ADD CONSTRAINT "AgentSpend_workerId_fkey"
  FOREIGN KEY ("workerId") REFERENCES "AgentProfile"("workerId") ON DELETE CASCADE ON UPDATE CASCADE;

-- The audit trail cannot be edited. Row-level triggers do not fire on
-- TRUNCATE, so the test harness's reset between files is unaffected.
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AuditLog is append-only: rows cannot be deleted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."action" IS DISTINCT FROM OLD."action"
     OR NEW."entityType" IS DISTINCT FROM OLD."entityType"
     OR NEW."entityId" IS DISTINCT FROM OLD."entityId"
     OR NEW."clientId" IS DISTINCT FROM OLD."clientId"
     OR NEW."workerId" IS DISTINCT FROM OLD."workerId"
     OR NEW."metadata"::text IS DISTINCT FROM OLD."metadata"::text
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR (NEW."actorUserId" IS NOT NULL AND NEW."actorUserId" IS DISTINCT FROM OLD."actorUserId") THEN
    RAISE EXCEPTION 'AuditLog is append-only: rows cannot be edited'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_immutable ON "AuditLog";
CREATE TRIGGER audit_log_immutable
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
