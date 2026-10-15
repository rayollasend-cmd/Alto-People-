-- Brief 2-3 step 4 — audit depth: the per-tenant hash chain, retention,
-- archives and the SIEM sink (docs/identity-rbac-audit-investigation.md §4.4).
--
-- 1. AuditLog gains seq / prevHash / hash, set by a BEFORE INSERT trigger
--    under a per-tenant advisory lock: hash = sha256(prevHash || '|' ||
--    the row's canonical text). The application never writes them. Rows
--    written before this migration stay unchained (seq NULL): the chain's
--    genesis is this deploy.
-- 2. The append-only trigger also protects the three chain columns.
-- 3. The canonical text leaves actorUserId out on purpose: the FK may set
--    it to NULL when a user row is removed, which the immutability trigger
--    allows; everything else in the row is in it.
--
-- Additive. Reversal = drop the trigger audit_log_chain, the two functions,
-- the columns and the four tables.

ALTER TABLE "AuditLog" ADD COLUMN "seq" BIGINT, ADD COLUMN "prevHash" VARCHAR(64), ADD COLUMN "hash" VARCHAR(64);
CREATE INDEX "AuditLog_tenantId_seq_idx" ON "AuditLog"("tenantId", "seq");

ALTER TABLE "Tenant" ADD COLUMN "auditRetentionYears" INTEGER NOT NULL DEFAULT 7;

CREATE OR REPLACE FUNCTION audit_log_canonical(r "AuditLog") RETURNS text AS $$
  SELECT concat_ws('|',
    r."id"::text,
    coalesce(r."tenantId"::text, ''),
    r."action",
    r."entityType",
    r."entityId",
    coalesce(r."clientId"::text, ''),
    coalesce(r."workerId"::text, ''),
    coalesce(r."apiClientId"::text, ''),
    coalesce(r."metadata"::text, ''),
    (extract(epoch from r."createdAt") * 1000000)::bigint::text,
    coalesce(r."seq"::text, ''))
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION audit_log_chain() RETURNS trigger AS $$
DECLARE
  prev_seq BIGINT;
  prev_hash VARCHAR(64);
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('alto.audit_chain'), hashtext(coalesce(NEW."tenantId"::text, '-')));
  IF NEW."tenantId" IS NULL THEN
    SELECT "seq", "hash" INTO prev_seq, prev_hash FROM "AuditLog"
      WHERE "tenantId" IS NULL AND "seq" IS NOT NULL ORDER BY "seq" DESC LIMIT 1;
  ELSE
    SELECT "seq", "hash" INTO prev_seq, prev_hash FROM "AuditLog"
      WHERE "tenantId" = NEW."tenantId" AND "seq" IS NOT NULL ORDER BY "seq" DESC LIMIT 1;
  END IF;
  NEW."seq" := coalesce(prev_seq, 0) + 1;
  NEW."prevHash" := prev_hash;
  NEW."hash" := encode(sha256(convert_to(coalesce(prev_hash, '') || '|' || audit_log_canonical(NEW), 'UTF8')), 'hex');
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_chain ON "AuditLog";
CREATE TRIGGER audit_log_chain
  BEFORE INSERT ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION audit_log_chain();

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
     OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."workerId" IS DISTINCT FROM OLD."workerId"
     OR NEW."metadata"::text IS DISTINCT FROM OLD."metadata"::text
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR NEW."seq" IS DISTINCT FROM OLD."seq"
     OR NEW."prevHash" IS DISTINCT FROM OLD."prevHash"
     OR NEW."hash" IS DISTINCT FROM OLD."hash"
     OR (NEW."actorUserId" IS NOT NULL AND NEW."actorUserId" IS DISTINCT FROM OLD."actorUserId") THEN
    RAISE EXCEPTION 'AuditLog is append-only: rows cannot be edited'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TABLE "AuditChainCheck" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID,
    "rows" INTEGER NOT NULL,
    "headSeq" BIGINT,
    "headHash" VARCHAR(64),
    "ok" BOOLEAN NOT NULL,
    "breaks" JSONB NOT NULL DEFAULT '[]',
    "checkedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditChainCheck_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AuditChainCheck_tenantId_checkedAt_idx" ON "AuditChainCheck"("tenantId", "checkedAt");

CREATE TABLE "AuditArchive" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID,
    "fromSeq" BIGINT,
    "toSeq" BIGINT,
    "before" TIMESTAMPTZ(6) NOT NULL,
    "rows" INTEGER NOT NULL,
    "objectKey" VARCHAR(300) NOT NULL,
    "sha256" VARCHAR(64) NOT NULL,
    "headHash" VARCHAR(64),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditArchive_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AuditArchive_tenantId_createdAt_idx" ON "AuditArchive"("tenantId", "createdAt");

CREATE TABLE "AuditSink" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
    "url" VARCHAR(500) NOT NULL,
    "secretEnc" BYTEA NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "cursorSeq" BIGINT NOT NULL DEFAULT 0,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(6),
    "lastDeliveredAt" TIMESTAMPTZ(6),
    "lastError" VARCHAR(500),
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "AuditSink_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AuditSink_tenantId_key" ON "AuditSink"("tenantId");

CREATE TABLE "AuditSinkDelivery" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sinkId" UUID NOT NULL,
    "fromSeq" BIGINT NOT NULL,
    "toSeq" BIGINT NOT NULL,
    "rows" INTEGER NOT NULL,
    "status" INTEGER,
    "ok" BOOLEAN NOT NULL,
    "error" VARCHAR(500),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditSinkDelivery_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AuditSinkDelivery_sinkId_createdAt_idx" ON "AuditSinkDelivery"("sinkId", "createdAt");
ALTER TABLE "AuditSinkDelivery" ADD CONSTRAINT "AuditSinkDelivery_sinkId_fkey" FOREIGN KEY ("sinkId") REFERENCES "AuditSink"("id") ON DELETE CASCADE ON UPDATE CASCADE;
