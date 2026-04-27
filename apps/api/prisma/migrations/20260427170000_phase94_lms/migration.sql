-- Phase 94 — LMS: courses, modules, enrollments, certifications, expirations.

CREATE TYPE "CourseStatus" AS ENUM (
  'DRAFT',
  'PUBLISHED',
  'ARCHIVED'
);

CREATE TYPE "EnrollmentStatus" AS ENUM (
  'ASSIGNED',
  'IN_PROGRESS',
  'COMPLETED',
  'EXPIRED',
  'WAIVED'
);

CREATE TYPE "CourseModuleKind" AS ENUM (
  'VIDEO',
  'READING',
  'QUIZ',
  'EXTERNAL_LINK',
  'POLICY_ACK'
);

CREATE TABLE "Course" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clientId"       UUID,
  "title"          TEXT NOT NULL,
  "description"    TEXT,
  -- Required for compliance roles? If true, anyone in the assigned
  -- audience MUST complete or be in violation.
  "isRequired"     BOOLEAN NOT NULL DEFAULT FALSE,
  -- Days from completion until the cert expires. NULL = never expires.
  "validityDays"   INTEGER,
  "status"         "CourseStatus" NOT NULL DEFAULT 'DRAFT',
  "createdById"    UUID,
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"      TIMESTAMPTZ(6) NOT NULL,
  "deletedAt"      TIMESTAMPTZ(6),
  CONSTRAINT "Course_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE,
  CONSTRAINT "Course_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL
);
CREATE INDEX "Course_clientId_status_idx" ON "Course" ("clientId", "status");

CREATE TABLE "CourseModule" (
  "id"        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "courseId"  UUID NOT NULL,
  "kind"      "CourseModuleKind" NOT NULL,
  "title"     TEXT NOT NULL,
  -- Free-form per-kind config: video URL, reading body, quiz JSON, etc.
  "content"   JSONB NOT NULL DEFAULT '{}'::jsonb,
  "order"     INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "CourseModule_courseId_fkey"
    FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE
);
CREATE INDEX "CourseModule_courseId_order_idx"
  ON "CourseModule" ("courseId", "order");

CREATE TABLE "CourseEnrollment" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "courseId"       UUID NOT NULL,
  "associateId"    UUID NOT NULL,
  "status"         "EnrollmentStatus" NOT NULL DEFAULT 'ASSIGNED',
  -- Granted on COMPLETED status; expires after validityDays.
  "completedAt"    TIMESTAMPTZ(6),
  "expiresAt"      TIMESTAMPTZ(6),
  -- Snapshot of completion progress (modules done) for resuming.
  "progress"       JSONB NOT NULL DEFAULT '{}'::jsonb,
  "score"          DECIMAL(5, 2),
  "assignedById"   UUID,
  "assignedAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"      TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "CourseEnrollment_courseId_fkey"
    FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE,
  CONSTRAINT "CourseEnrollment_associateId_fkey"
    FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE,
  CONSTRAINT "CourseEnrollment_assignedById_fkey"
    FOREIGN KEY ("assignedById") REFERENCES "User"("id") ON DELETE SET NULL
);
-- One active assignment per (course, associate) at a time.
CREATE UNIQUE INDEX "CourseEnrollment_unique_active"
  ON "CourseEnrollment" ("courseId", "associateId")
  WHERE "status" IN ('ASSIGNED', 'IN_PROGRESS');
CREATE INDEX "CourseEnrollment_associateId_status_idx"
  ON "CourseEnrollment" ("associateId", "status");
CREATE INDEX "CourseEnrollment_expiresAt_idx"
  ON "CourseEnrollment" ("expiresAt");
