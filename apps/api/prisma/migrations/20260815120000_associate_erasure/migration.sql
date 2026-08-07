-- Privacy erasure (admin-initiated) — additive only. Two new columns on
-- "Associate" stamp when an erasure ran and which admin ran it. Identity
-- fields are anonymized in place by application code (lib/erasure.ts);
-- payroll/tax rows are never deleted (IRS 4-year / FLSA 3-year retention).

ALTER TABLE "Associate" ADD COLUMN "erasedAt" TIMESTAMPTZ(6);
ALTER TABLE "Associate" ADD COLUMN "erasedById" UUID;

ALTER TABLE "Associate"
  ADD CONSTRAINT "Associate_erasedById_fkey"
  FOREIGN KEY ("erasedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
