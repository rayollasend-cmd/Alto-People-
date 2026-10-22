-- HR walk 9: an interview panel (up to three people per interview).
CREATE TABLE "InterviewInterviewer" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "interviewId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tenantId" UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InterviewInterviewer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InterviewInterviewer_interviewId_userId_key" ON "InterviewInterviewer"("interviewId", "userId");
CREATE INDEX "InterviewInterviewer_userId_idx" ON "InterviewInterviewer"("userId");
CREATE INDEX "InterviewInterviewer_tenantId_idx" ON "InterviewInterviewer"("tenantId");

ALTER TABLE "InterviewInterviewer" ADD CONSTRAINT "InterviewInterviewer_interviewId_fkey"
    FOREIGN KEY ("interviewId") REFERENCES "Interview"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InterviewInterviewer" ADD CONSTRAINT "InterviewInterviewer_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Existing single-interviewer rows become a one-person panel.
INSERT INTO "InterviewInterviewer" ("interviewId", "userId", "tenantId")
SELECT "id", "interviewerUserId", "tenantId" FROM "Interview" WHERE "interviewerUserId" IS NOT NULL
ON CONFLICT DO NOTHING;

-- HR walk 13: HR opens a case on someone's behalf (phone, walk-in, email).
ALTER TABLE "HrCase" ADD COLUMN "channel" VARCHAR(12);
ALTER TABLE "HrCase" ADD COLUMN "filedByUserId" UUID;
ALTER TABLE "HrCase" ADD CONSTRAINT "HrCase_filedByUserId_fkey"
    FOREIGN KEY ("filedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- HR walk 17: the report builder reports on HR events.
ALTER TYPE "ReportEntity" ADD VALUE IF NOT EXISTS 'SEPARATION';
ALTER TYPE "ReportEntity" ADD VALUE IF NOT EXISTS 'LEAVE_CASE';
ALTER TYPE "ReportEntity" ADD VALUE IF NOT EXISTS 'HR_CASE';
ALTER TYPE "ReportEntity" ADD VALUE IF NOT EXISTS 'OFFER';
