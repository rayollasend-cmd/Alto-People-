-- Phase: Employee number.
-- Promotes the kiosk PIN concept into a globally-unique 4-digit employee
-- number that's visible to the associate on their profile. Adds the
-- encrypted-plaintext column so we can decrypt and show it back, and
-- tightens uniqueness to global (one number per company-wide associate)
-- instead of per-client.

ALTER TABLE "KioskPin" ADD COLUMN "pinEncrypted" BYTEA;

DROP INDEX IF EXISTS "KioskPin_clientId_associateId_key";
DROP INDEX IF EXISTS "KioskPin_clientId_pinHmac_key";

CREATE UNIQUE INDEX "KioskPin_associateId_key" ON "KioskPin"("associateId");
CREATE UNIQUE INDEX "KioskPin_pinHmac_key" ON "KioskPin"("pinHmac");
