-- Brief 2-3, step 1 — the audit floor's database half.
--
-- 1. The append-only trigger also covers the tenant: a row cannot be moved
--    to another tenant after it is written. Everything else it protected
--    stays protected; actorUserId may still go to NULL (the FK's SET NULL
--    when a user is removed), never to another user.
-- 2. A statement-level BEFORE TRUNCATE trigger: row triggers never fire on
--    TRUNCATE, so until now the whole table could be wiped in one statement
--    (directly, or through TRUNCATE ... CASCADE from User). It is refused
--    unless the session set alto.allow_audit_truncate = 'test', which only
--    the test harness does, inside its own transaction.
--
-- Additive: two functions replaced or created, one trigger added. No data
-- is touched. Reversal = drop audit_log_no_truncate and restore the
-- previous function body from 20261107090000_agent_registry.

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
     OR (NEW."actorUserId" IS NOT NULL AND NEW."actorUserId" IS DISTINCT FROM OLD."actorUserId") THEN
    RAISE EXCEPTION 'AuditLog is append-only: rows cannot be edited'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION audit_log_no_truncate() RETURNS trigger AS $$
BEGIN
  IF coalesce(current_setting('alto.allow_audit_truncate', true), '') <> 'test' THEN
    RAISE EXCEPTION 'AuditLog is append-only: the table cannot be truncated'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NULL;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_truncate ON "AuditLog";
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON "AuditLog"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_no_truncate();
