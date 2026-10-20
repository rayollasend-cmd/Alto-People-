-- Payroll on the company's own bank account: no funding pull, the ACH file is
-- the money (balanced or unbalanced), and a paycheck reads paid only when a
-- person marks the file uploaded to the bank.
ALTER TABLE "PayrollBankingProfile"
  ADD COLUMN "settlement" VARCHAR(12) NOT NULL DEFAULT 'PREFUND',
  ADD COLUMN "fileFormat" VARCHAR(10) NOT NULL DEFAULT 'UNBALANCED';
