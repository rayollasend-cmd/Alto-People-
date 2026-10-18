-- California's Wage Theft Protection notice (Labor Code §2810.5) names the
-- employer's workers' compensation carrier: name, address, phone and policy.
ALTER TABLE "EmployerOrganization"
  ADD COLUMN "wcCarrierName"    VARCHAR(255),
  ADD COLUMN "wcCarrierAddress" VARCHAR(500),
  ADD COLUMN "wcCarrierPhone"   VARCHAR(32),
  ADD COLUMN "wcPolicyNumber"   VARCHAR(64);
