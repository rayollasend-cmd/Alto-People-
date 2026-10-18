-- A tax payment sent through the embedded payroll provider moves the
-- customer's money: it waits on a second person (lib/payrollTaxLedger).
ALTER TYPE "ApprovalRequestKind" ADD VALUE IF NOT EXISTS 'TAX_PAYMENT';
