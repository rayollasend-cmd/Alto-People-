-- E-Verify directorate.
--
-- Identity fields the federal E-Verify form asks for that the product didn't
-- store, so a verifier hand-typed them into the portal on every case:
--   * middleInitial   — Form I-9 Section 1.
--   * otherLastNames  — prior surnames, collected by E-Verify as a repeatable
--                       list. A text array matches that shape without a join
--                       table for what is usually zero to two values.
--
-- Plus the missing half of the E-Verify case record: eVerifyCaseNumber /
-- Status / ClosedAt already existed, but nothing recorded when the case was
-- OPENED. The federal deadline is 3 business days from the first day worked,
-- so the queue can't flag overdue cases without it.
--
-- All nullable / defaulted, no backfill: existing rows legitimately have none
-- of this, and inventing values on identity fields would be worse than blank.

-- AlterTable
ALTER TABLE "Associate" ADD COLUMN     "middleInitial" VARCHAR(1);
ALTER TABLE "Associate" ADD COLUMN     "otherLastNames" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "I9Verification" ADD COLUMN     "eVerifyCaseOpenedAt" TIMESTAMPTZ(6);
