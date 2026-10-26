// Saturday-morning reliability summary — the week's numbers, in one
// message, to the people accountable for the platform.
//
// The org week closed Friday midnight, so Saturday morning every ACTIVE
// user OF THE PLATFORM OPERATOR'S TENANT whose role holds
// view:product-analytics gets last week's errors against the ten-a-week
// budget, kiosk punch success and ride completion — and the digest writes
// the week's numbers (route p95s and restarts included) to
// ReliabilityWeek, so the "four weeks under budget" streak is a row count
// rather than a memory.
//
// The platform's health is the operator's business, never a customer
// tenant's: a customer's HR admin holds the same role, so the recipient
// list is fenced to the operator tenant. And the message itself stays in
// plain words — no environment variable names, route timings or restart
// counts in a bell; those live on the (operator-only) Reliability page.
//
// Send-at-most-once per org week per recipient, enforced by the digest's
// own IN_APP notification row (category below, createdAt >= this week's
// start) — the executive digest's pattern. The sweep runs on an interval
// and only fires on the org week's first day (Saturday, Florida-local)
// after SEND_AFTER_HOUR local time.

import type { PrismaClient, Role } from '@prisma/client';
import { platformJob } from './tenantJobs.js';
import { PLATFORM_OPERATOR_TENANT_ID, RELIABILITY_ERROR_BUDGET, ROLE_CAPABILITIES } from '@alto-people/shared';
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

/** The roles whose holders read the dashboard — the digest goes to the same people, in the operator's tenant. */
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
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/**
 * "Oct 17 – 23" inside a month, "Sep 27 – Oct 3" across one: the closed
 * org week, Saturday to Friday, in the company's zone.
 */
export function reliabilityWeekLabel(weekStart: Date, weekEnd: Date): string {
  const first = fmtDay(weekStart);
  const last = fmtDay(new Date(weekEnd.getTime() - ONE_DAY_MS));
  const [firstMonth] = first.split(' ');
  const [lastMonth, lastDay] = last.split(' ');
  return firstMonth === lastMonth ? `${first} – ${lastDay}` : `${first} – ${last}`;
}

/** The subject line: the verdict in a few words. Exported for the test. */
export function reliabilityDigestSubject(sentryErrors: number | null): string {
  if (sentryErrors === null) return 'Weekly reliability: error tracking is not connected';
  return `Weekly reliability: ${plural(sentryErrors, 'error')}, ${sentryErrors <= RELIABILITY_ERROR_BUDGET ? 'within' : 'over'} budget`;
}

/**
 * The message, in sentences. Plain words only: the speed of each route,
 * the restarts and the setup steps are on the Reliability page, which the
 * link opens. Exported for the test.
 */
export function reliabilityDigestBody(
  facts: WeekFacts,
  sentryErrors: number | null,
  streak: number | null,
): string {
  const weekLabel = reliabilityWeekLabel(facts.weekStart, facts.weekEnd);
  const lines: string[] = [];
  if (sentryErrors === null) {
    lines.push(
      `Week of ${weekLabel}: error tracking is not connected, so the week cannot be judged against the budget of ${RELIABILITY_ERROR_BUDGET} errors a week. ` +
        'Open Reliability to see what to set up.',
    );
  } else {
    const verdict = sentryErrors <= RELIABILITY_ERROR_BUDGET ? 'within budget' : 'over budget';
    const streakLine =
      streak === null ? '' : streak >= 1 ? ` That makes ${plural(streak, 'week')} in a row under budget.` : ' The streak starts again.';
    lines.push(
      `Week of ${weekLabel}: ${plural(sentryErrors, 'error')} against a budget of ${RELIABILITY_ERROR_BUDGET} a week — ${verdict}.${streakLine}`,
    );
  }
  lines.push('');
  lines.push(
    facts.requests > 0
      ? `Requests that failed on our side: ${facts.serverErrors.toLocaleString('en-US')} of ${facts.requests.toLocaleString('en-US')}.`
      : 'No traffic was recorded this week.',
  );
  lines.push(
    facts.punchTotal > 0
      ? `Kiosk punches: ${pctOf(facts.punchAccepted, facts.punchTotal)} accepted (${facts.punchAccepted.toLocaleString('en-US')} of ${facts.punchTotal.toLocaleString('en-US')}).`
      : 'Kiosk punches: none this week.',
  );
  if (facts.rideTotal > 0) {
    lines.push(
      `Rides: ${pctOf(facts.rideCompleted, facts.rideTotal)} completed (${facts.rideCompleted.toLocaleString('en-US')} of ${facts.rideTotal.toLocaleString('en-US')}` +
        `${facts.rideNoShow > 0 ? `, ${plural(facts.rideNoShow, 'no-show')}` : ''}` +
        `${facts.rideUnresolved > 0 ? `, ${facts.rideUnresolved.toLocaleString('en-US')} never closed` : ''}).`,
    );
  } else {
    lines.push('Rides: none this week.');
  }
  lines.push('');
  lines.push('The Reliability page has the details.');
  return lines.join('\n');
}

let strayDigestsCleared = false;

/**
 * Before the fence, the digest reached every tenant's HR admins. Their bells
 * lose those rows (once per process; best-effort): the platform's health was
 * never theirs to read. Exported for the test.
 */
export async function clearCustomerReliabilityDigests(prisma: PrismaClient = defaultPrisma): Promise<number> {
  const r = await prisma.notification.deleteMany({
    where: { category: RELIABILITY_DIGEST_CATEGORY, tenantId: { not: PLATFORM_OPERATOR_TENANT_ID } },
  });
  return r.count;
}

export async function runReliabilityDigestSweep(
  prisma: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<ReliabilityDigestResult> {
  if (!strayDigestsCleared) {
    strayDigestsCleared = true;
    await clearCustomerReliabilityDigests(prisma).catch(() => undefined);
  }
  const { weekday, hour } = localParts(now, DEFAULT_TIMEZONE);
  if (weekday !== 'Sat') return { sent: 0, skipped: 'not_saturday' };
  if (hour < SEND_AFTER_HOUR) return { sent: 0, skipped: 'too_early' };

  // The operator's own people only: a customer's HR admin holds the same
  // role, and the platform's health is not theirs to be paged about.
  const recipients = await prisma.user.findMany({
    where: { tenantId: PLATFORM_OPERATOR_TENANT_ID, role: { in: RELIABILITY_DIGEST_ROLES }, status: 'ACTIVE', deletedAt: null },
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
  const subject = reliabilityDigestSubject(sentryErrors);
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
