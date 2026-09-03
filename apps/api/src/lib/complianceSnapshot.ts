import { env } from '../config/env.js';
import { prisma } from '../db.js';
import {
  buildActionsTile,
  buildScorecardBundle,
  computeWeightedScore,
} from '../routes/complianceScorecard.js';

/**
 * Daily compliance-score snapshot — the scorecard's memory.
 *
 * The scorecard computes live posture; without snapshots the org can never
 * answer "are we getting better?" or hand a board a trend line. One row per
 * day per scope (org-wide + each ACTIVE client) records the weighted score,
 * critical/warn action counts, headcount, fully-compliant count, and every
 * tile's severity. The /compliance-scorecard/history endpoint and the board
 * PDF read these rows; executive threshold alerts compare against them.
 *
 * Cadence: the interval only decides how often we CHECK whether today's row
 * exists — writes happen at most once per day per scope because the day
 * row itself is the claim (findFirst → skip). Re-running after a partial
 * failure fills in only the missing scopes.
 */
export async function runComplianceSnapshot(
  now: Date = new Date(),
): Promise<{ written: number; skipped: number }> {
  // Store the day as a UTC date — the same convention the @db.Date column
  // enforces. A "day" here is an audit bucket, not a payroll boundary.
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  const clients = await prisma.client.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true },
  });
  const scopes: Array<string | null> = [null, ...clients.map((c) => c.id)];

  let written = 0;
  let skipped = 0;
  for (const clientId of scopes) {
    // The (day, clientId) row is the idempotency claim. NULL clientIds are
    // not deduped by the unique index (Postgres treats NULLs as distinct),
    // so the check is done here rather than leaned on the constraint.
    const existing = await prisma.complianceScoreSnapshot.findFirst({
      where: { day, clientId },
      select: { id: true },
    });
    if (existing) {
      skipped++;
      continue;
    }

    const bundle = await buildScorecardBundle(clientId);
    const actions = await buildActionsTile(clientId, bundle);

    await prisma.complianceScoreSnapshot.create({
      data: {
        day,
        clientId,
        score: computeWeightedScore(bundle),
        criticalCount: actions.criticalCount,
        warnCount: actions.warnCount,
        activeAssociateCount: bundle.onboarding.activeAssociateCount,
        fullyCompliantCount: bundle.onboarding.fullyCompliantCount,
        tileSeverities: {
          onboarding: bundle.onboarding.severity,
          expirations: bundle.expirations.severity,
          shifts: bundle.shifts.severity,
          billing: bundle.billing.severity,
          training: bundle.training.severity,
        },
      },
    });
    written++;
  }
  return { written, skipped };
}

let timer: NodeJS.Timeout | null = null;

export function startComplianceSnapshotCron(): void {
  if (timer) return;
  const seconds = env.COMPLIANCE_SNAPSHOT_INTERVAL_SECONDS;
  if (seconds <= 0) return;
  const tick = () => {
    void runComplianceSnapshot().catch((err) => {
      console.error('[alto-people/api] compliance snapshot failed:', err);
    });
  };
  tick();
  timer = setInterval(tick, seconds * 1000);
  timer.unref();
  console.log(
    `[alto-people/api] compliance snapshot cron armed (every ${seconds}s, one row/day/scope)`,
  );
}

export function stopComplianceSnapshotCron(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
