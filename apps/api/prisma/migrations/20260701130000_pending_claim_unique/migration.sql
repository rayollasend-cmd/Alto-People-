-- P1 from the July re-audit: the open-shift claim path dup-checked then
-- created without a transaction, so two concurrent requests could file two
-- PENDING claims for the same associate+shift. A partial unique index makes
-- the database the arbiter; the route catches P2002 and returns the same
-- 409 the app-level check produces. Decided claims (any other status) are
-- history rows and stay unconstrained.
CREATE UNIQUE INDEX "OpenShiftClaim_pending_once"
  ON "OpenShiftClaim"("shiftId", "associateId")
  WHERE "status" = 'PENDING';
