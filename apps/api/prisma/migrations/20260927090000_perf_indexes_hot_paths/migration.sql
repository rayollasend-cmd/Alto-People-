-- Performance pass on the two endpoints the production report flagged:
--   GET /time/me/earnings        p95 1248ms
--   GET /onboarding/applications p95 1251ms
--
-- Indexes only; no data or shape changes.

-- ── AssociateQualification had NO indexes at all. Every eligibility check
-- (the open-shift list, the claim guard, and the earnings widget through
-- listEligibleOpenShifts) filters associateId + deletedAt, so each one was
-- a sequential scan of the whole table.
CREATE INDEX IF NOT EXISTS "AssociateQualification_associateId_deletedAt_idx"
  ON "AssociateQualification"("associateId", "deletedAt");
-- Join/cascade side: qualification → its holders.
CREATE INDEX IF NOT EXISTS "AssociateQualification_qualificationId_idx"
  ON "AssociateQualification"("qualificationId");

-- ── Application: the list always ORDER BY "invitedAt" DESC, and the two
-- filters that matter are the status chip (ACTIVE / ARCHIVED expand to an
-- IN list) and the client scope. Separate single-column indexes on
-- "status" and "invitedAt" forced a filter-then-sort; these carry the sort.
CREATE INDEX IF NOT EXISTS "Application_status_invitedAt_idx"
  ON "Application"("status", "invitedAt" DESC);
CREATE INDEX IF NOT EXISTS "Application_clientId_invitedAt_idx"
  ON "Application"("clientId", "invitedAt" DESC);

-- ── Notification: the applications list resolves the latest invite
-- delivery for a page of associates — recipientUserId IN (…) AND category
-- IN (…) ORDER BY "createdAt" DESC. The existing (recipientUserId,
-- createdAt) index had to read every notification for those users and
-- discard the non-invite ones; this one carries the category.
CREATE INDEX IF NOT EXISTS "Notification_recipientUserId_category_createdAt_idx"
  ON "Notification"("recipientUserId", "category", "createdAt" DESC);
