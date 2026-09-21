-- GET /onboarding/applications filters by client AND status, then orders by
-- invitedAt DESC. Neither existing index serves that: (status, invitedAt)
-- narrows by status and sorts across every client, (clientId, invitedAt)
-- narrows by client and sorts across every status. Postgres picks one and
-- filters + re-sorts the rest, which is the list a client-scoped ops
-- manager opens every morning.
--
-- Plain CREATE INDEX, not CONCURRENTLY: Prisma wraps each migration in a
-- transaction and CONCURRENTLY cannot run inside one. That is fine here —
-- Application is a table of hundreds, not millions, so the ACCESS EXCLUSIVE
-- lock is measured in milliseconds. If this table ever reaches a size where
-- that matters, the index wants building by hand, outside migrate.
CREATE INDEX IF NOT EXISTS "Application_clientId_status_invitedAt_idx"
  ON "Application" ("clientId", "status", "invitedAt" DESC);
