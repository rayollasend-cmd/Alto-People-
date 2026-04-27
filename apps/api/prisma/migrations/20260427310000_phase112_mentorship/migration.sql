-- Phase 112 — Mentorship matching.
--
-- A Mentorship is a directed pairing: mentorAssociateId teaches
-- menteeAssociateId. Status tracks the lifecycle so HR/managers can
-- see active programs and post-completion outcomes. The optional
-- focusSkillId hooks into Phase 111 — we suggest mentors for a
-- mentee by intersecting "skills the mentee wants to grow" with
-- "skills the mentor holds at ADVANCED+".

CREATE TYPE "MentorshipStatus" AS ENUM (
    'PROPOSED',
    'ACTIVE',
    'COMPLETED',
    'DECLINED',
    'CANCELLED'
);

CREATE TABLE "Mentorship" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "mentorAssociateId" UUID NOT NULL,
    "menteeAssociateId" UUID NOT NULL,
    "focusSkillId" UUID,
    "goals" TEXT,
    "status" "MentorshipStatus" NOT NULL DEFAULT 'PROPOSED',
    "startedAt" TIMESTAMPTZ(6),
    "endedAt" TIMESTAMPTZ(6),
    "endedReason" TEXT,
    "proposedById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Mentorship_pkey" PRIMARY KEY ("id")
);

-- An associate can only mentor or be mentored by the same person once
-- in an active state at a time. Partial unique on (mentor, mentee)
-- when status is ACTIVE.
CREATE UNIQUE INDEX "Mentorship_active_pair_idx"
    ON "Mentorship"("mentorAssociateId", "menteeAssociateId")
    WHERE "status" = 'ACTIVE';

CREATE INDEX "Mentorship_mentorAssociateId_idx"
    ON "Mentorship"("mentorAssociateId");
CREATE INDEX "Mentorship_menteeAssociateId_idx"
    ON "Mentorship"("menteeAssociateId");
CREATE INDEX "Mentorship_status_idx" ON "Mentorship"("status");

ALTER TABLE "Mentorship"
    ADD CONSTRAINT "Mentorship_mentorAssociateId_fkey"
    FOREIGN KEY ("mentorAssociateId") REFERENCES "Associate"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Mentorship"
    ADD CONSTRAINT "Mentorship_menteeAssociateId_fkey"
    FOREIGN KEY ("menteeAssociateId") REFERENCES "Associate"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Mentorship"
    ADD CONSTRAINT "Mentorship_focusSkillId_fkey"
    FOREIGN KEY ("focusSkillId") REFERENCES "Skill"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Mentorship"
    ADD CONSTRAINT "Mentorship_proposedById_fkey"
    FOREIGN KEY ("proposedById") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
