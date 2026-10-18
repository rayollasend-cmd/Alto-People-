-- A garnishment payee's bank details change only after a second person approves (lib/garnishmentDesk).
ALTER TYPE "ApprovalRequestKind" ADD VALUE IF NOT EXISTS 'GARNISHMENT_PAYEE_BANK';
