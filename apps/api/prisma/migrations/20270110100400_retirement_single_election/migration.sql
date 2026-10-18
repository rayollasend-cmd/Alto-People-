-- One deferral election per person: the benefits enrollment. A 401(k) rate
-- (auto-enrollment, escalation, an HR change, a recordkeeper's deferral change)
-- is written to the person's enrollment in the plan's 401(k) benefits plan, and
-- payroll deducts from enrollments only (lib/retirementDeferrals limits apply once).
ALTER TABLE "BenefitsEnrollment" ADD COLUMN "electedPercent" DECIMAL(5,2);
ALTER TABLE "BenefitsEnrollment" ADD COLUMN "rothPercent" DECIMAL(5,2);
ALTER TABLE "BenefitsEnrollment" ADD COLUMN "retirementPlanId" UUID;
CREATE INDEX "BenefitsEnrollment_retirementPlanId_idx" ON "BenefitsEnrollment"("retirementPlanId");
ALTER TABLE "RetirementPlan" ADD COLUMN "benefitsPlanId" UUID;
-- Rates no longer live on the plan-membership row.
ALTER TABLE "RetirementElection" DROP COLUMN "preTaxPercent";
ALTER TABLE "RetirementElection" DROP COLUMN "rothPercent";
