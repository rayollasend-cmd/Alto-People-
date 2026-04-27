-- Phase 114 — Learning paths.
--
-- Sequence multiple Courses into an ordered track (e.g., "Manager
-- onboarding" = Course A -> Course B -> Course C). Steps run in
-- order: an associate's "current step" on a path is the lowest-order
-- step where their CourseEnrollment isn't COMPLETED/WAIVED.
--
-- Path enrollment lifecycle is independent from individual course
-- enrollments: the path enrollment goes COMPLETED only when every
-- step's course is COMPLETED/WAIVED for that associate.

CREATE TYPE "LearningPathStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');
CREATE TYPE "LearningPathEnrollmentStatus" AS ENUM (
    'ASSIGNED',
    'IN_PROGRESS',
    'COMPLETED',
    'WITHDRAWN'
);

CREATE TABLE "LearningPath" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clientId" UUID,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "isRequired" BOOLEAN NOT NULL DEFAULT false,
    "status" "LearningPathStatus" NOT NULL DEFAULT 'DRAFT',
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "LearningPath_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LearningPath_clientId_status_idx"
    ON "LearningPath"("clientId", "status");

ALTER TABLE "LearningPath"
    ADD CONSTRAINT "LearningPath_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LearningPath"
    ADD CONSTRAINT "LearningPath_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "LearningPathStep" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "pathId" UUID NOT NULL,
    "courseId" UUID NOT NULL,
    "order" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "LearningPathStep_pkey" PRIMARY KEY ("id")
);

-- Each course appears at most once per path.
CREATE UNIQUE INDEX "LearningPathStep_path_course_key"
    ON "LearningPathStep"("pathId", "courseId");

-- Order is unique per path so the sequence is unambiguous.
CREATE UNIQUE INDEX "LearningPathStep_path_order_key"
    ON "LearningPathStep"("pathId", "order");

ALTER TABLE "LearningPathStep"
    ADD CONSTRAINT "LearningPathStep_pathId_fkey"
    FOREIGN KEY ("pathId") REFERENCES "LearningPath"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LearningPathStep"
    ADD CONSTRAINT "LearningPathStep_courseId_fkey"
    FOREIGN KEY ("courseId") REFERENCES "Course"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "LearningPathEnrollment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "pathId" UUID NOT NULL,
    "associateId" UUID NOT NULL,
    "status" "LearningPathEnrollmentStatus" NOT NULL DEFAULT 'ASSIGNED',
    "assignedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "LearningPathEnrollment_pkey" PRIMARY KEY ("id")
);

-- An associate can be on a path at most once at a time. Re-assigning
-- updates the existing row.
CREATE UNIQUE INDEX "LearningPathEnrollment_path_associate_key"
    ON "LearningPathEnrollment"("pathId", "associateId");

CREATE INDEX "LearningPathEnrollment_associateId_idx"
    ON "LearningPathEnrollment"("associateId");

ALTER TABLE "LearningPathEnrollment"
    ADD CONSTRAINT "LearningPathEnrollment_pathId_fkey"
    FOREIGN KEY ("pathId") REFERENCES "LearningPath"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LearningPathEnrollment"
    ADD CONSTRAINT "LearningPathEnrollment_associateId_fkey"
    FOREIGN KEY ("associateId") REFERENCES "Associate"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
