-- A supervisor's shift: which of a store's named shift windows (the
-- labeled StaffingTarget windows — "Overnight 10p–6a") they lead. Keyed by
-- (store, label) so a new effective-dated headcount for the window keeps
-- its lead. Focus, not a lock: it shapes default views and alert routing.
CREATE TABLE "SupervisorShiftWindow" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupervisorShiftWindow_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SupervisorShiftWindow_locationId_label_idx" ON "SupervisorShiftWindow"("locationId", "label");

CREATE UNIQUE INDEX "SupervisorShiftWindow_userId_locationId_label_key" ON "SupervisorShiftWindow"("userId", "locationId", "label");

ALTER TABLE "SupervisorShiftWindow" ADD CONSTRAINT "SupervisorShiftWindow_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SupervisorShiftWindow" ADD CONSTRAINT "SupervisorShiftWindow_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;
