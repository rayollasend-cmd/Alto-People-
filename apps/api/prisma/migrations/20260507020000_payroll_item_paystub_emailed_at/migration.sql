-- Wave 8 — paystub email delivery audit column.
-- Set the first time email-on-disburse fires successfully; lets the
-- disburse hook stay idempotent if a webhook ever delivers the SUCCESS
-- event twice. NULL on existing rows = "never emailed" (will stay NULL
-- unless HR manually triggers the resend route).

ALTER TABLE "PayrollItem"
ADD COLUMN "paystubEmailedAt" TIMESTAMPTZ(6);
