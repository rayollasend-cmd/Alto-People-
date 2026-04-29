-- Wave 3.2 — QBO Employee/Vendor cache on Associate.

ALTER TABLE "Associate" ADD COLUMN "qboEmployeeId" TEXT;
ALTER TABLE "Associate" ADD COLUMN "qboVendorId"   TEXT;
ALTER TABLE "Associate" ADD COLUMN "qboSyncedAt"   TIMESTAMPTZ(6);

-- Partial indexes — only meaningful when an id is set, keeps the index
-- compact when most associates haven't been synced yet.
CREATE INDEX "Associate_qboEmployeeId_idx" ON "Associate"("qboEmployeeId") WHERE "qboEmployeeId" IS NOT NULL;
CREATE INDEX "Associate_qboVendorId_idx"   ON "Associate"("qboVendorId")   WHERE "qboVendorId" IS NOT NULL;
