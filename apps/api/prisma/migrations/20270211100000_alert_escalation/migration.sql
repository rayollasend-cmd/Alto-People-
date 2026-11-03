-- The store's supervisor first, the office after 30 minutes (owner, 2026-11-02).
-- Possible no-shows and projected overtime used to reach HR, Ops and the
-- workforce manager by email at once — 1,590 no-show emails to 15 people in 14
-- days, 1% of the bell copies ever opened. Now the supervisors of that store
-- hear first; each alert they were told about is a row here, and the
-- escalation sweep (lib/alertEscalation) tells the office only when it is
-- still unresolved and unread 30 minutes on. A new table, tenant-keyed, under
-- the wall; nothing existing changes.

CREATE TABLE IF NOT EXISTS "AlertEscalation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
    "kind" VARCHAR(16) NOT NULL,
    "shiftId" UUID,
    "associateId" UUID,
    "weekKey" VARCHAR(10),
    "category" VARCHAR(64) NOT NULL,
    "linkUrl" TEXT,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "notifiedUserIds" UUID[],
    "notifiedAt" TIMESTAMPTZ(6) NOT NULL,
    "escalateAt" TIMESTAMPTZ(6) NOT NULL,
    "escalatedAt" TIMESTAMPTZ(6),
    "resolvedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertEscalation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AlertEscalation_tenantId_idx" ON "AlertEscalation"("tenantId");
CREATE INDEX IF NOT EXISTS "AlertEscalation_tenantId_escalateAt_idx" ON "AlertEscalation"("tenantId", "escalateAt");

SELECT alto_tenant_rls_policies('AlertEscalation');
ALTER TABLE "AlertEscalation" ENABLE ROW LEVEL SECURITY;
