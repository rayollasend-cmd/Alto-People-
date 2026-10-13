// Saturday-morning reliability summary — the week's four numbers, in one
// email, to the people accountable for the platform.
//
// The org week closed Friday midnight, so Saturday morning every ACTIVE
// user whose role holds view:product-analytics gets last week's errors
// against the ten-a-week budget, p95 for the busiest routes, kiosk punch
// success, ride completion and restarts — and the digest writes the same
// numbers to ReliabilityWeek, so the "four weeks under budget" streak is
// a row count rather than a memory.
//
// Send-at-most-once per org week per recipient, enforced by the digest's
// own IN_APP notification row (category below, createdAt >= this week's
// start) — the executive digest's pattern. The sweep runs on an interval
// and only fires on the org week's first day (Saturday, Florida-local)
// after SEND_AFTER_HOUR local time.

import type { PrismaClient, Role } from '@prisma/client';
import { platformJob } from './tenantJobs.js';
import { RELIABILITY_ERROR_BUDGET, ROLE_CAPABILITIES } from '@alto-people/shared';
import { prisma as defaultPrisma } from '../db.js';
import { startOfWeekUTC } from './timeAnomalies.js';
import { DEFAULT_TIMEZONE } from './timezone.js';
import { notifyUser } from './notify.js';
import { computeWeekFacts, consecutiveWeeksUnderBudget, reliabilityWeeks, type WeekFacts } from './reliability.js';

export const RELIABILITY_DIGEST_CATEGORY = 'reliability_digest';
const SEND_AFTER_HOUR = 8;
const SWEEP_SECONDS = 15 * 60;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function localParts(now: Date, timeZone: string): { weekday: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: 'numeric',
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { weekday: get('weekday'), hour: Number(get('hour')) || 0 };
}

/** The roles whose holders read the dashboard — the digest goes to the same people. */
export const RELIABILITY_DIGEST_ROLES: Role[] = (Object.keys(ROLE_CAPABILITIES) as Role[]).filter((r) =>
  ROLE_CAPABILITIES[r].has('view:product-analytics'),
);

export interface ReliabilityDigestResult {
  sent: number;
  skipped?: 'not_saturday' | 'too_early' | 'no_recipients' | 'already_sent';
  /** The closed week the digest described. */
  weekStart?: string;
}

const pctOf = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : 'n/a');
const fmtDay = (d: Date) =>
  new Intl.DateTimeFormat('en-US', { timeZone: DEFAULT_TIMEZONE, month: 'short', day: 'numeric' }).format(d);

/** The email, in sentences first and figures after. Exported for the test. */
export function reliabilityDigestBody(
  facts: WeekFacts,
  sentryErrors: number | null,
  streak: number | null,
): string {
  const weekLabel = `${fmtDay(facts.weekStart)} to ${fmtDay(new Date(facts.weekEnd.getTime() - ONE_DAY_MS))}`;
  const lines: string[] = [];
  if (sentryErrors === null) {
    lines.push(
      `Week of ${weekLabel}: Sentry is not connected, so the error budget cannot be judged. ` +
        `The API answered ${facts.requests.toLocaleString('en-US')} requests and returned ${facts.serverErrors} server errors. ` +
        `Set SENTRY_AUTH_TOKEN, SENTRY_ORG and SENTRY_PROJECTS on the API to count errors against the budget of ${RELIABILITY_ERROR_BUDGET} a week.`,
    );
  } else {
    const verdict = sentryErrors <= RELIABILITY_ERROR_BUDGET ? 'within budget' : 'OVER budget';
    const streakLine =
      streak === null ? '' : streak >= 1 ? ` That makes ${streak} week${streak === 1 ? '' : 's'} in a row under budget.` : ' The streak resets.';
    lines.push(
      `Week of ${weekLabel}: ${sentryErrors} error${sentryErrors === 1 ? '' : 's'} in Sentry against a budget of ${RELIABILITY_ERROR_BUDGET} — ${verdict}.${streakLine}`,
    );
  }
  lines.push('');
  lines.push(`Kiosk punches: ${pctOf(facts.punchAccepted, facts.punchTotal)} accepted (${facts.punchAccepted} of ${facts.punchTotal}).`);
  lines.push(
    `Rides: ${pctOf(facts.rideCompleted, facts.rideTotal)} completed (${facts.rideCompleted} of ${facts.rideTotal}` +
      `${facts.rideNoShow > 0 ? `, ${facts.rideNoShow} no-show` : ''}${facts.rideUnresolved > 0 ? `, ${facts.rideUnresolved} never closed` : ''}).`,
  );
  lines.push(`API restarts: ${facts.restarts}. Server errors (5xx): ${facts.serverErrors} of ${facts.requests.toLocaleString('en-US')} requests.`);
  lines.push('');
  lines.push('p95 for the busiest routes:');
  for (const r of facts.busiest) {
    lines.push(`  ${r.method} ${r.route} — ${r.p95Ms === null ? 'no histogram yet' : `${r.p95Ms} ms`} (${r.requests.toLocaleString('en-US')} calls)`);
  }
  if (facts.busiest.length === 0) lines.push('  (no traffic recorded)');
  return lines.join('\n');
}

export async function runReliabilityDigestSweep(
  prisma: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<ReliabilityDigestResult> {
  const { weekday, hour } = localParts(now, DEFAULT_TIMEZONE);
  if (weekday !== 'Sat') return { sent: 0, skipped: 'not_saturday' };
  if (hour < SEND_AFTER_HOUR) return { sent: 0, skipped: 'too_early' };

  const recipients = await prisma.user.findMany({
    where: { role: { in: RELIABILITY_DIGEST_ROLES }, status: 'ACTIVE', deletedAt: null },
    select: { id: true },
  });
  if (recipients.length === 0) return { sent: 0, skipped: 'no_recipients' };

  const thisWeekStart = startOfWeekUTC(now);
  const alreadySent = await prisma.notification.findMany({
    where: {
      recipientUserId: { in: recipients.map((r) => r.id) },
      category: RELIABILITY_DIGEST_CATEGORY,
      createdAt: { gte: thisWeekStart },
    },
    select: { recipientUserId: true },
  });
  const sentSet = new Set(alreadySent.map((n) => n.recipientUserId));
  const pending = recipients.filter((r) => !sentSet.has(r.id));
  if (pending.length === 0) return { sent: 0, skipped: 'already_sent' };

  // The closed week: the one before the week that just started.
  const closedStart = startOfWeekUTC(new Date(thisWeekStart.getTime() - 7 * ONE_DAY_MS + 12 * 3_600_000));
  const [facts, weeks] = await Promise.all([computeWeekFacts(prisma, closedStart, now), reliabilityWeeks(prisma, now)]);
  const closed = weeks.find((w) => w.weekStart === closedStart.toISOString()) ?? null;
  const sentryErrors = closed?.sentryErrors ?? null;
  const streak = consecutiveWeeksUnderBudget(weeks);

  await prisma.reliabilityWeek.upsert({
    where: { weekStart: closedStart },
    create: {
      weekStart: closedStart,
      sentryErrors,
      serverErrors: facts.serverErrors,
      requests: facts.requests,
      p95TopRoutes: facts.busiest.map((r) => ({ method: r.method, route: r.route, requests: r.requests, p95Ms: r.p95Ms })),
      punchTotal: facts.punchTotal,
      punchAccepted: facts.punchAccepted,
      rideTotal: facts.rideTotal,
      rideCompleted: facts.rideCompleted,
      restarts: facts.restarts,
      underBudget: sentryErrors !== null && sentryErrors <= RELIABILITY_ERROR_BUDGET,
    },
    update: {
      sentryErrors,
      serverErrors: facts.serverErrors,
      requests: facts.requests,
      p95TopRoutes: facts.busiest.map((r) => ({ method: r.method, route: r.route, requests: r.requests, p95Ms: r.p95Ms })),
      punchTotal: facts.punchTotal,
      punchAccepted: facts.punchAccepted,
      rideTotal: facts.rideTotal,
      rideCompleted: facts.rideCompleted,
      restarts: facts.restarts,
      underBudget: sentryErrors !== null && sentryErrors <= RELIABILITY_ERROR_BUDGET,
    },
  });

  const body = reliabilityDigestBody(facts, sentryErrors, streak);
  const subject =
    sentryErrors === null
      ? 'Weekly reliability: Sentry not connected'
      : `Weekly reliability: ${sentryErrors} error${sentryErrors === 1 ? '' : 's'}, ${sentryErrors <= RELIABILITY_ERROR_BUDGET ? 'within' : 'over'} budget`;
  for (const r of pending) {
    await notifyUser(r.id, {
      subject,
      body,
      category: RELIABILITY_DIGEST_CATEGORY,
      linkUrl: '/reliability',
    });
  }
  return { sent: pending.length, weekStart: closedStart.toISOString() };
}

let timer: NodeJS.Timeout | null = null;

export function startReliabilityDigestCron(): void {
  if (timer) return;
  void platformJob('reliabilityDigest', runReliabilityDigestSweep)().catch((err) => {
    console.error('[alto-people/api] reliability digest sweep failed:', err);
  });
  timer = setInterval(() => {
    void platformJob('reliabilityDigest', runReliabilityDigestSweep)().catch((err) => {
      console.error('[alto-people/api] reliability digest sweep failed:', err);
    });
  }, SWEEP_SECONDS * 1000);
  timer.unref();
  console.log(
    `[alto-people/api] reliability digest cron armed (every ${SWEEP_SECONDS}s, sends Saturdays after ${SEND_AFTER_HOUR}:00 ${DEFAULT_TIMEZONE})`,
  );
}

export function stopReliabilityDigestCron(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
