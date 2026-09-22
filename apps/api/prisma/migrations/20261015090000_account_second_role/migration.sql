-- One account, more than one hat.
--
-- A shift supervisor who also drives an Alto van is one person with one
-- email. Until now the only way to give them both jobs was a second
-- login, which meant two sets of notifications, two profiles to keep
-- current, and a driver nobody could tie back to the supervisor who ran
-- the shift.
--
--   additionalRoles  the other roles this account may act as (rarely more
--                    than one; the application caps it at three)
--   activeRole       which granted role it is wearing right now; NULL is
--                    the primary role
--
-- Both default to the status quo, so every existing account keeps exactly
-- the access it has today.
ALTER TABLE "User"
  ADD COLUMN "additionalRoles" "Role"[] NOT NULL DEFAULT ARRAY[]::"Role"[],
  ADD COLUMN "activeRole" "Role";

-- A switcher only ever reads these two columns for the signed-in account,
-- so no index is warranted. The one query that scans them is the admin
-- list, which is already capped and ordered by createdAt.
