-- I-9 re-verification (Supplement B) and the Section 2 examined date
-- (compliance: current workforce + cleared to work, owner 2026-11-03).
--
-- I9Verification.section2ExaminedOn: the day HR examined the Section 2
-- documents, typed on a manual or paper Section 2. New and empty — nothing
-- existing changes; older Section 2s keep reading section2CompletedAt.
--
-- I9Reverification: one row per Supplement B entry. kind REVERIFICATION is
-- the document examined when a time-limited work authorization ran out;
-- kind REHIRE is a rehire within 3 years of the original I-9 that reuses it
-- (rehiredOn), with a re-verified document when the authorization had ended
-- (documentTitle is null otherwise). The number is encrypted at rest (the
-- last four kept for the list), with the expiry it replaced and the new one.
-- Recording a document also moves I9Verification.workAuthExpiresAt in the
-- same transaction (routes/compliance.ts). New and empty; tenant-keyed and
-- under the wall (20270128190100_tenancy_rls); a person's rows go with them
-- (ON DELETE CASCADE).

ALTER TABLE "I9Verification" ADD COLUMN IF NOT EXISTS "section2ExaminedOn" DATE;

CREATE TABLE "I9Reverification" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "associateId" UUID NOT NULL,
  "i9VerificationId" UUID NOT NULL,
  "kind" VARCHAR(16) NOT NULL DEFAULT 'REVERIFICATION',
  "rehiredOn" DATE,
  "documentTitle" VARCHAR(160),
  "documentNumberEnc" BYTEA,
  "documentNumberLast4" VARCHAR(4),
  "issuingAuthority" VARCHAR(160),
  "previousExpiresAt" DATE,
  "newExpiresAt" DATE,
  "reviewedById" UUID,
  "reviewedOn" DATE NOT NULL,
  "notes" VARCHAR(1000),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "I9Reverification_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "I9Reverification_associateId_fkey" FOREIGN KEY ("associateId") REFERENCES "Associate"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "I9Reverification_i9VerificationId_fkey" FOREIGN KEY ("i9VerificationId") REFERENCES "I9Verification"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "I9Reverification_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "I9Reverification_associateId_createdAt_idx" ON "I9Reverification"("associateId", "createdAt");
CREATE INDEX "I9Reverification_i9VerificationId_idx" ON "I9Reverification"("i9VerificationId");
CREATE INDEX "I9Reverification_tenantId_idx" ON "I9Reverification"("tenantId");

-- Under the wall (20270128190100_tenancy_rls).
SELECT alto_tenant_rls_policies('I9Reverification');
ALTER TABLE "I9Reverification" ENABLE ROW LEVEL SECURITY;
