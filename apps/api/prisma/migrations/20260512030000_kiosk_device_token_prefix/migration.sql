-- KioskDevice lookup at /kiosk/punch currently scans every isActive=true
-- row and bcrypt-verifies each tokenHash against the inbound plaintext.
-- For a tenant with N kiosks, that's N bcrypt operations per punch —
-- ~5ms × N. At 100 kiosks, every punch eats ~500ms.
--
-- tokenPrefix is the first 16 chars of the plaintext token
-- (`altokiosk_` + 6 hex), stored on every new/rotated device. Lookup
-- becomes WHERE tokenPrefix = $1 AND isActive = true, then
-- bcrypt-verify only the (typically 1) match.
--
-- Legacy rows pre-dating this column are NULL and fall through to the
-- scan path; HR can rotate them to opt into the fast path.

ALTER TABLE "KioskDevice"
  ADD COLUMN "tokenPrefix" TEXT;

CREATE INDEX "KioskDevice_tokenPrefix_isActive_idx"
  ON "KioskDevice" ("tokenPrefix", "isActive");
