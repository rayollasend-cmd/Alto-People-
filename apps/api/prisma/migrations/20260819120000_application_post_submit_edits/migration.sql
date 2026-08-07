-- Applicants may revise their application until HR approves/rejects it.
-- When an edit lands after the application reached HR (SUBMITTED/IN_REVIEW),
-- this stamp powers the reviewer-facing "updated after submission" flag so
-- stale data is never approved unnoticed.
ALTER TABLE "Application" ADD COLUMN "updatedAfterSubmitAt" TIMESTAMPTZ(6);
