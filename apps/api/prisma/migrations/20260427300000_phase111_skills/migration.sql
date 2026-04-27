-- Phase 111 — Skills & competencies.
--
-- Skill is a global catalog (one row per "Python", "Forklift",
-- "Spanish"). AssociateSkill is the join — each row is one
-- associate's claim of one skill at a proficiency level. Self-
-- attested by default; an HR/manager-attested flag lets us mark
-- skills that have been verified through a course or assessment.

CREATE TYPE "SkillLevel" AS ENUM (
    'BEGINNER',
    'INTERMEDIATE',
    'ADVANCED',
    'EXPERT'
);

CREATE TABLE "Skill" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "category" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Skill_pkey" PRIMARY KEY ("id")
);

-- Names are case-insensitive unique. We store the original casing for
-- display and lower(name) for the unique check.
CREATE UNIQUE INDEX "Skill_name_lower_key"
    ON "Skill"(LOWER("name"));

CREATE INDEX "Skill_category_idx" ON "Skill"("category");

CREATE TABLE "AssociateSkill" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "associateId" UUID NOT NULL,
    "skillId" UUID NOT NULL,
    "level" "SkillLevel" NOT NULL,
    "verifiedById" UUID,
    "verifiedAt" TIMESTAMPTZ(6),
    "yearsExperience" SMALLINT,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "AssociateSkill_pkey" PRIMARY KEY ("id")
);

-- One row per (associate, skill). Re-claiming updates the existing row.
CREATE UNIQUE INDEX "AssociateSkill_associate_skill_key"
    ON "AssociateSkill"("associateId", "skillId");

CREATE INDEX "AssociateSkill_skillId_idx" ON "AssociateSkill"("skillId");
CREATE INDEX "AssociateSkill_level_idx" ON "AssociateSkill"("level");

ALTER TABLE "AssociateSkill"
    ADD CONSTRAINT "AssociateSkill_associateId_fkey"
    FOREIGN KEY ("associateId") REFERENCES "Associate"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AssociateSkill"
    ADD CONSTRAINT "AssociateSkill_skillId_fkey"
    FOREIGN KEY ("skillId") REFERENCES "Skill"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AssociateSkill"
    ADD CONSTRAINT "AssociateSkill_verifiedById_fkey"
    FOREIGN KEY ("verifiedById") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
