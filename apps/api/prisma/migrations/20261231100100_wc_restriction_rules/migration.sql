-- Structured work restrictions on a workers' comp claim (max hours per
-- shift, lift limit, positions that fit), so modified-duty offers can be
-- matched to open shifts that respect them.
ALTER TABLE "WcClaim" ADD COLUMN "restrictionRules" JSONB;
