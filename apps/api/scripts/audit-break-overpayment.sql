-- Break-time overpayment audit (2026-08 payroll P0 remediation).
--
-- Until PR #289, the payroll aggregator paid raw clock-in→clock-out and
-- never subtracted breaks, while the review screen / exports reported
-- net-of-breaks. Every run DISBURSED before that fix may therefore have
-- overpaid hourly associates whose entries carried breaks.
--
-- This query re-derives, for each DISBURSED payroll item, the break hours
-- that fell inside the run's period for that associate, and prices them at
-- the item's stored hourly rate. Rows with estimated_overpayment > 0 are
-- candidates for recovery via the amendment flow (whose net math was also
-- fixed in PR #291 — amend AFTER deploying that fix).
--
-- Caveats, deliberately conservative:
--   * Salaried items (hourlyRate = 0 / SALARY source) price at 0 here.
--   * Only APPROVED entries with a clock-out count, matching the pay math.
--   * An open-ended break (endedAt IS NULL) is clamped at the entry's
--     clock-out, same as the fixed payableMs().
--   * OT interaction is ignored: if the associate was in overtime, the
--     excess hours actually paid at 1.5x, so the true overpayment for
--     those hours is HIGHER than estimated here.
--
-- Read-only. Run with: psql "$DATABASE_URL" -f audit-break-overpayment.sql

WITH break_minutes AS (
  SELECT
    te."associateId",
    te."clientId",
    te."clockInAt",
    SUM(
      GREATEST(
        0,
        EXTRACT(
          EPOCH FROM (
            LEAST(COALESCE(b."endedAt", te."clockOutAt"), te."clockOutAt")
            - b."startedAt"
          )
        ) / 60.0
      )
    ) AS break_min
  FROM "TimeEntry" te
  JOIN "BreakEntry" b ON b."timeEntryId" = te.id
  WHERE te.status = 'APPROVED'
    AND te."clockOutAt" IS NOT NULL
  GROUP BY te.id, te."associateId", te."clientId", te."clockInAt"
)
SELECT
  pr.id                                   AS payroll_run_id,
  pr."periodStart"::date                  AS period_start,
  pr."periodEnd"::date                    AS period_end,
  pr."disbursedAt"::date                  AS disbursed_on,
  a."firstName" || ' ' || a."lastName"    AS associate,
  pi."hourlyRate"                         AS hourly_rate,
  ROUND(SUM(bm.break_min) / 60.0, 2)      AS unpaid_break_hours_in_period,
  ROUND(SUM(bm.break_min) / 60.0 * pi."hourlyRate", 2)
                                          AS estimated_overpayment
FROM "PayrollRun" pr
JOIN "PayrollItem" pi ON pi."payrollRunId" = pr.id
JOIN "Associate" a ON a.id = pi."associateId"
JOIN break_minutes bm
  ON bm."associateId" = pi."associateId"
  AND bm."clockInAt" >= pr."periodStart"
  AND bm."clockInAt" < pr."periodEnd" + INTERVAL '1 day'
  AND (pr."clientId" IS NULL OR bm."clientId" = pr."clientId")
WHERE pr.status = 'DISBURSED'
  AND pi.status = 'DISBURSED'
  AND pi."hourlyRate" > 0
  -- Only runs disbursed BEFORE the fix deployed. Adjust if needed:
  AND pr."disbursedAt" < TIMESTAMPTZ '2026-08-07 10:00:00+00'
GROUP BY pr.id, pr."periodStart", pr."periodEnd", pr."disbursedAt",
         a."firstName", a."lastName", pi."hourlyRate"
HAVING SUM(bm.break_min) > 0
ORDER BY estimated_overpayment DESC;

-- Grand total:
-- Wrap the SELECT above in `SELECT SUM(estimated_overpayment) FROM (...) t;`
