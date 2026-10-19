-- Every deduction on every paycheck, itemized: what it was (medical,
-- dental, a 401(k) deferral, a child-support order …), whose money
-- (employee, employer or both), and which wage bases it lowered at the
-- moment the check was cut. The paystub lists these lines; the W-2, the
-- 941 and every state return rebuild their wage bases from them instead
-- of from the two lump columns on PayrollItem.
--
--   exemptFrom  the bases this deduction reduced, as written when the check
--               was computed: FIT, SS, MEDICARE, FUTA, and per state
--               "SIT:PA", "SUI:CA", "PGM:CA_SDI", "LOCAL". A snapshot: a
--               later rule change never rewrites a paid check.

CREATE TABLE "PayrollItemDeduction" (
  "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"       UUID DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  "payrollItemId"  UUID NOT NULL,
  "code"           VARCHAR(40) NOT NULL,
  "category"       VARCHAR(12) NOT NULL,
  "label"          VARCHAR(160) NOT NULL,
  "employeeAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "employerAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "sourceType"     VARCHAR(40),
  "sourceId"       UUID,
  "exemptFrom"     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "w2Box12Code"    VARCHAR(4),
  "w2Box14Label"   VARCHAR(40),
  "w2Box10"        BOOLEAN NOT NULL DEFAULT false,
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "PayrollItemDeduction_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PayrollItemDeduction_payrollItemId_fkey" FOREIGN KEY ("payrollItemId") REFERENCES "PayrollItem"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PayrollItemDeduction_category_check" CHECK ("category" IN ('PRE_TAX', 'POST_TAX', 'EMPLOYER'))
);
CREATE INDEX "PayrollItemDeduction_payrollItemId_idx" ON "PayrollItemDeduction"("payrollItemId");
CREATE INDEX "PayrollItemDeduction_tenantId_code_idx" ON "PayrollItemDeduction"("tenantId", "code");
CREATE INDEX "PayrollItemDeduction_sourceType_sourceId_idx" ON "PayrollItemDeduction"("sourceType", "sourceId");
