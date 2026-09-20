-- Product analytics: three rollups + a "last seen" stamp.
--
-- Deliberately NOT built on AuditLog. That table has 209 action types, no
-- retention sweep, and its indexes serve entity timelines — aggregating
-- DAU over it would scan an ever-growing table and contend with the write
-- path every mutation depends on. These tables are written by a flusher
-- and read by the dashboard; nothing queries the raw log.

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lastSeenAt" TIMESTAMPTZ(6);

-- One row per user per day they were active. DAU = COUNT on day;
-- WAU/MAU = COUNT DISTINCT over a range of days.
CREATE TABLE IF NOT EXISTS "UserActivityDay" (
  "id"      UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId"  UUID NOT NULL,
  "day"     DATE NOT NULL,
  -- The role held THAT day. Re-deriving it from User later would rewrite
  -- history whenever somebody changes job.
  "role"    VARCHAR(40) NOT NULL,
  "firstAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "UserActivityDay_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "UserActivityDay_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "UserActivityDay_userId_day_key"
  ON "UserActivityDay" ("userId", "day");
CREATE INDEX IF NOT EXISTS "UserActivityDay_day_idx" ON "UserActivityDay" ("day");
CREATE INDEX IF NOT EXISTS "UserActivityDay_day_role_idx" ON "UserActivityDay" ("day", "role");
CREATE INDEX IF NOT EXISTS "UserActivityDay_userId_day_idx"
  ON "UserActivityDay" ("userId", "day" DESC);

-- Traffic and health per day, keyed by Express route PATTERN. Never a
-- resolved path: "/rides/:id", so no analytics row can become a record of
-- who looked at whom.
CREATE TABLE IF NOT EXISTS "RouteUsageDaily" (
  "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
  "day"         DATE NOT NULL,
  "method"      VARCHAR(10) NOT NULL,
  "route"       VARCHAR(200) NOT NULL,
  "ok"          INTEGER NOT NULL DEFAULT 0,
  "clientError" INTEGER NOT NULL DEFAULT 0,
  "serverError" INTEGER NOT NULL DEFAULT 0,
  "totalMs"     BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT "RouteUsageDaily_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "RouteUsageDaily_day_method_route_key"
  ON "RouteUsageDaily" ("day", "method", "route");
CREATE INDEX IF NOT EXISTS "RouteUsageDaily_day_idx" ON "RouteUsageDaily" ("day");

-- Networks an account has actually signed in from, so "somewhere new?" is
-- an indexed lookup rather than a scan of the audit log.
CREATE TABLE IF NOT EXISTS "UserKnownIp" (
  "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId"      UUID NOT NULL,
  "ip"          VARCHAR(64) NOT NULL,
  "timezone"    VARCHAR(64),
  "firstSeenAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "lastSeenAt"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "logins"      INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "UserKnownIp_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "UserKnownIp_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "UserKnownIp_userId_ip_key"
  ON "UserKnownIp" ("userId", "ip");
CREATE INDEX IF NOT EXISTS "UserKnownIp_userId_lastSeenAt_idx"
  ON "UserKnownIp" ("userId", "lastSeenAt" DESC);
