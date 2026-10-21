-- 1:1s that repeat. A 1:1 can belong to a series with a cadence (weekly or
-- every two weeks); completing one schedules the next, and the action
-- items still open carry forward onto it. Action items are their own rows
-- so "done" is a fact with a date, not an edit to a notes field.

ALTER TABLE "OneOnOne" ADD COLUMN "cadence" VARCHAR(16);
ALTER TABLE "OneOnOne" ADD COLUMN "seriesId" UUID;
ALTER TABLE "OneOnOne" ADD CONSTRAINT "OneOnOne_cadence_check" CHECK ("cadence" IS NULL OR "cadence" IN ('WEEKLY', 'BIWEEKLY'));
CREATE INDEX "OneOnOne_seriesId_idx" ON "OneOnOne"("seriesId");

CREATE TABLE "OneOnOneActionItem" (
  "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"      UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "oneOnOneId"    UUID NOT NULL,
  "text"          VARCHAR(500) NOT NULL,
  "ownerIsManager" BOOLEAN NOT NULL DEFAULT true,
  "doneAt"        TIMESTAMPTZ(6),
  "carriedFromId" UUID,
  "createdById"   UUID,
  "createdAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "OneOnOneActionItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OneOnOneActionItem_oneOnOneId_fkey" FOREIGN KEY ("oneOnOneId") REFERENCES "OneOnOne"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "OneOnOneActionItem_oneOnOneId_idx" ON "OneOnOneActionItem"("oneOnOneId");
CREATE INDEX "OneOnOneActionItem_tenantId_idx" ON "OneOnOneActionItem"("tenantId");
