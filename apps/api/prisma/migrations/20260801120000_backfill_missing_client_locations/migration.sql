-- Backfill: a default work site for every client that has none.
--
-- Three eras of clients exist: (1) pre-Phase-131 clients got one location
-- each from that migration's backfill; (3) clients created after
-- 2026-07-31 get one at birth from POST /clients. This closes era (2) —
-- clients created in between have ZERO Location rows, so the invite
-- dialogs' work-site picker renders empty ("only Front Beach appears"),
-- invites can't record a site, and approval never opens an
-- AssociateAssignment.
--
-- Same shape as the Phase 131 backfill: named after the client, copying
-- its address. Geofence coordinates no longer live on Client (they moved
-- to Location in Phase 131), so new sites start without one — admins set
-- per-site geofences in Clients → Locations.
--
-- Deliberately locations-only: people already onboarded without a site
-- are fixed person-by-person via the scheduling team's "Assign to this
-- site" action, because bulk-guessing assignments could place someone at
-- the wrong store.

INSERT INTO "Location" (
  "clientId", "name",
  "addressLine1", "addressLine2", "city", "state", "zip",
  "isActive", "updatedAt"
)
SELECT
  c."id", c."name",
  c."addressLine1", c."addressLine2", c."city", c."state", c."zip",
  TRUE, NOW()
FROM "Client" c
WHERE c."deletedAt" IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "Location" l
    WHERE l."clientId" = c."id"
      AND l."deletedAt" IS NULL
  );
