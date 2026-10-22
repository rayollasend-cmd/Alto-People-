-- Finance walk 13: a mass pay change goes to one second-person approval.
ALTER TYPE "ApprovalRequestKind" ADD VALUE IF NOT EXISTS 'PAY_RATE_BATCH';
