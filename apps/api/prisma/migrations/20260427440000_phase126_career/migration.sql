-- Phase 126 — Career ladders. Structured progression through ranked levels
-- per family (e.g. Engineering: I → II → Senior → Staff → Principal). Each
-- level optionally links a JobProfile and lists required skills with a
-- minimum SkillLevel from Phase 111.
CREATE TABLE "CareerLadder" (
  "id"          UUID            NOT NULL DEFAULT gen_random_uuid(),
  "clientId"    UUID,
  "name"        TEXT            NOT NULL,
  "family"      TEXT,
  "description" TEXT,
  "archivedAt"  TIMESTAMPTZ(6),
  "createdById" UUID,
  "createdAt"   TIMESTAMPTZ(6)  NOT NULL DEFAULT NOW(),
  "updatedAt"   TIMESTAMPTZ(6)  NOT NULL,
  CONSTRAINT "CareerLadder_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CareerLadder_clientId_idx" ON "CareerLadder"("clientId");

ALTER TABLE "CareerLadder" ADD CONSTRAINT "CareerLadder_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CareerLadder" ADD CONSTRAINT "CareerLadder_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "CareerLevel" (
  "id"           UUID            NOT NULL DEFAULT gen_random_uuid(),
  "ladderId"     UUID            NOT NULL,
  "rank"         INTEGER         NOT NULL,
  "title"        TEXT            NOT NULL,
  "description"  TEXT,
  "jobProfileId" UUID,
  "createdAt"    TIMESTAMPTZ(6)  NOT NULL DEFAULT NOW(),
  "updatedAt"    TIMESTAMPTZ(6)  NOT NULL,
  CONSTRAINT "CareerLevel_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CareerLevel_ladder_rank_key"
  ON "CareerLevel"("ladderId", "rank");
CREATE INDEX "CareerLevel_jobProfileId_idx" ON "CareerLevel"("jobProfileId");

ALTER TABLE "CareerLevel" ADD CONSTRAINT "CareerLevel_ladderId_fkey"
  FOREIGN KEY ("ladderId") REFERENCES "CareerLadder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CareerLevel" ADD CONSTRAINT "CareerLevel_jobProfileId_fkey"
  FOREIGN KEY ("jobProfileId") REFERENCES "JobProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "CareerLevelSkill" (
  "id"        UUID            NOT NULL DEFAULT gen_random_uuid(),
  "levelId"   UUID            NOT NULL,
  "skillId"   UUID            NOT NULL,
  "minLevel"  "SkillLevel"    NOT NULL,
  "createdAt" TIMESTAMPTZ(6)  NOT NULL DEFAULT NOW(),
  CONSTRAINT "CareerLevelSkill_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CareerLevelSkill_level_skill_key"
  ON "CareerLevelSkill"("levelId", "skillId");

ALTER TABLE "CareerLevelSkill" ADD CONSTRAINT "CareerLevelSkill_levelId_fkey"
  FOREIGN KEY ("levelId") REFERENCES "CareerLevel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CareerLevelSkill" ADD CONSTRAINT "CareerLevelSkill_skillId_fkey"
  FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE CASCADE ON UPDATE CASCADE;
