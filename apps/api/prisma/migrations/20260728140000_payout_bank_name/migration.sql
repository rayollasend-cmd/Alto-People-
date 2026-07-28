-- Bank name on the payout method.
--
-- The external payroll sheet (the handoff file for an outside payroll
-- provider) needs an institution name per employee, and nothing in the
-- product could derive one: there is no ABA routing directory, and the
-- routing number alone doesn't name the bank. Collected at direct-deposit
-- setup instead.
--
-- Nullable with no backfill: every existing row and every Branch-card
-- method legitimately has no bank name, and guessing one would be worse
-- than leaving the cell blank on a file that gets sent to a bank.

-- AlterTable
ALTER TABLE "PayoutMethod" ADD COLUMN     "bankName" TEXT;
