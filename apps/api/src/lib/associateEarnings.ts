// Associate earnings motivation — the paycheck made visible:
//   · GET /time/me/earnings: this org week (Sat→Fri) as money — earned
//     so far (approved + completed + live on-the-clock minutes), what
//     the rest of the schedule is worth, today's shift as a number, a
//     per-day breakdown, last week as the pace to beat, and what the
//     week's eligible open shifts are worth.
//   · Clock-out moment: "You just added ~$112 to your week" pushed to
//     the associate's OWN phone/bell — deliberately not the shared kiosk
//     screen, where a dollar figure would leak their pay rate to the
//     next person in line.
// OVERTIME-AWARE: past 40h this week (all clients combined) every number
// here pays 1.5× — the same convention as payroll's splitWeeklyOvertime
// and the live floor board. A widget that shows an associate on 45 hours
// LESS than their paycheck isn't motivation, it's a bug.
// All figures are ESTIMATES: gross, before taxes, at the associate's
// hourly comp record (else the org default rate). Payroll remains the
// source of truth.

import type { PrismaClient } from '@prisma/client';
import { paidMinutesForRange } from '@alto-people/shared';
import { env } from '../config/env.js';
import { notifyAssociate } from './notify.js';
import { listEligibleOpenShifts } from '../routes/qualifications.js';
import { endOfWeekUTC, netWorkedMinutes, startOfWeekUTC } from './timeAnomalies.js';

const round2 = (n: number) => Math.round(n * 100) / 100;

const OT_THRESHOLD_MIN = 40 * 60;
const OT_MULTIPLIER = 1.5;
const DAY_MS = 24 * 3600_000;

/** Pay for `minutes` of work starting at cumulative week-minute `cumStart`,
 *  splitting straight-time / 1.5× at the 40-hour line. Chronological blocks
 *  fed through this sum to exactly the FLSA weekly total. */
function payForBlock(cumStartMin: number, minutes: number, rate: number): number {
  const regular = Math.max(0, Math.min(minutes, OT_THRESHOLD_MIN - cumStartMin));
  const overtime = minutes - regular;
  return (regular / 60) * rate + (overtime / 60) * rate * OT_MULTIPLIER;
}

async function hourlyRateFor(
  prisma: PrismaClient,
  associateId: string,
): Promise<{ rate: number; source: 'comp' | 'default' }> {
  const comp = await prisma.compensationRecord.findFirst({
    where: { associateId, payType: 'HOURLY', effectiveTo: null },
    orderBy: { effectiveFrom: 'desc' },
    select: { amount: true },
  });
  if (comp) return { rate: Number(comp.amount), source: 'comp' };
  return { rate: env.DEFAULT_ASSOCIATE_PAY_RATE, source: 'default' };
}

export interface EarningsDay {
  /** YYYY-MM-DD (UTC week bucket, Sat→Fri). */
  date: string;
  workedMinutes: number;
  workedAmount: number;
  scheduledMinutes: number;
  scheduledAmount: number;
}

export interface AssociateEarnings {
  weekStart: string;
  weekEnd: string;
  hourlyRate: number;
  rateSource: 'comp' | 'default';
  /** Net worked this week so far, incl. live on-the-clock minutes. OT-aware. */
  earnedSoFar: number;
  workedHours: number;
  /** earnedSoFar + the rest of this week's assigned schedule. OT-aware. */
  projectedWeek: number;
  remainingHours: number;
  /** Clocked in right now — the client ticks the number live while true. */
  onClock: boolean;
  /** What the NEXT minute pays: the base rate, or 1.5× once past 40h. */
  currentRatePerHour: number;
  overtime: {
    thresholdHours: number;
    multiplier: number;
    /** Already past 40h — every remaining minute pays 1.5×. */
    unlocked: boolean;
    otHoursSoFar: number;
    /** worked + remaining schedule crosses 40h by this many hours. */
    projectedOtHours: number;
  };
  /** Last completed week's total (same rate, OT-aware) — the pace to beat. */
  lastWeekEarned: number;
  /** Sat→Fri, always 7 entries — the shape of the week as money. */
  days: EarningsDay[];
  /** Eligible OPEN shifts before week's end, priced on top of the
   *  projection (so they show 1.5× when they'd land in overtime). */
  openShifts: { count: number; estAmount: number };
  /** The next assigned shift within 24h (or the one in progress). */
  todayShift: {
    startsAt: string;
    endsAt: string;
    estAmount: number;
    inProgress: boolean;
  } | null;
}

export async function computeAssociateEarnings(
  prisma: PrismaClient,
  associateId: string,
  now: Date = new Date(),
): Promise<AssociateEarnings> {
  const weekStart = startOfWeekUTC(now);
  const weekEnd = endOfWeekUTC(now);
  const { rate, source } = await hourlyRateFor(prisma, associateId);

  const [entries, shifts, lastWeekEntries, openEligible] = await Promise.all([
    prisma.timeEntry.findMany({
      where: {
        associateId,
        status: { in: ['APPROVED', 'COMPLETED', 'ACTIVE'] },
        clockInAt: { gte: weekStart, lt: weekEnd },
      },
      // Chronological — the OT split walks the week in order.
      orderBy: { clockInAt: 'asc' },
      select: {
        clockInAt: true,
        clockOutAt: true,
        status: true,
        breaks: { select: { type: true, startedAt: true, endedAt: true } },
      },
      take: 100,
    }),
    prisma.shift.findMany({
      where: {
        assignedAssociateId: associateId,
        status: 'ASSIGNED',
        endsAt: { gt: now },
        startsAt: { lt: weekEnd },
      },
      orderBy: { startsAt: 'asc' },
      select: { startsAt: true, endsAt: true },
      take: 30,
    }),
    prisma.timeEntry.findMany({
      where: {
        associateId,
        status: { in: ['APPROVED', 'COMPLETED'] },
        clockInAt: {
          gte: new Date(weekStart.getTime() - 7 * DAY_MS),
          lt: weekStart,
        },
      },
      select: {
        clockInAt: true,
        clockOutAt: true,
        breaks: { select: { type: true, startedAt: true, endedAt: true } },
      },
      take: 100,
    }),
    listEligibleOpenShifts(associateId, { before: weekEnd }),
  ]);

  const days: EarningsDay[] = Array.from({ length: 7 }, (_, i) => ({
    date: new Date(weekStart.getTime() + i * DAY_MS).toISOString().slice(0, 10),
    workedMinutes: 0,
    workedAmount: 0,
    scheduledMinutes: 0,
    scheduledAmount: 0,
  }));
  const dayIndex = (d: Date) =>
    Math.max(0, Math.min(6, Math.floor((d.getTime() - weekStart.getTime()) / DAY_MS)));

  // Worked money, walked chronologically so the 40h line lands exactly
  // where it did on the floor.
  let cumMin = 0;
  let earnedSoFar = 0;
  let onClock = false;
  for (const e of entries) {
    let mins = 0;
    if (e.clockOutAt) {
      mins = netWorkedMinutes(
        { clockInAt: e.clockInAt, clockOutAt: e.clockOutAt },
        e.breaks,
      );
    } else if (e.status === 'ACTIVE') {
      // Live: money accrues while they stand on the floor (capped at 16h
      // so a forgotten clock-out can't paint a fantasy number).
      onClock = true;
      mins = Math.min(
        16 * 60,
        Math.max(0, Math.round((now.getTime() - e.clockInAt.getTime()) / 60_000)),
      );
    }
    if (mins <= 0) continue;
    const amount = payForBlock(cumMin, mins, rate);
    const d = days[dayIndex(e.clockInAt)];
    d.workedMinutes += mins;
    d.workedAmount = round2(d.workedAmount + amount);
    earnedSoFar += amount;
    cumMin += mins;
  }
  const workedMin = cumMin;

  // The rest of the schedule: future shifts fully; an in-progress shift
  // only from now to its end (the walked part is already counted above).
  // Continues the same cumulative clock, so hours landing past 40 project
  // at 1.5×.
  let remainingMin = 0;
  let remainingAmount = 0;
  for (const s of shifts) {
    const from = s.startsAt > now ? s.startsAt : now;
    // Paid minutes (unpaid-break rule) — never promise money for the
    // meal hour: a 9h overnight projects 8 paid hours.
    const mins = paidMinutesForRange(from, s.endsAt);
    if (mins <= 0) continue;
    const amount = payForBlock(cumMin, mins, rate);
    const d = days[dayIndex(from)];
    d.scheduledMinutes += mins;
    d.scheduledAmount = round2(d.scheduledAmount + amount);
    remainingMin += mins;
    remainingAmount += amount;
    cumMin += mins;
  }

  // Last week, same math from a zero clock — the pace to beat.
  let lastWeekMin = 0;
  for (const e of lastWeekEntries) {
    if (!e.clockOutAt) continue;
    lastWeekMin += netWorkedMinutes(
      { clockInAt: e.clockInAt, clockOutAt: e.clockOutAt },
      e.breaks,
    );
  }
  const lastWeekEarned = round2(payForBlock(0, lastWeekMin, rate));

  // Eligible open shifts, priced ON TOP of the projection: if picking one
  // up would land in overtime, it honestly shows the 1.5× value.
  let openMin = 0;
  let openAmount = 0;
  for (const s of openEligible) {
    const mins = paidMinutesForRange(s.startsAt, s.endsAt);
    if (mins <= 0) continue;
    openAmount += payForBlock(cumMin + openMin, mins, rate);
    openMin += mins;
  }

  const next = shifts.find(
    (s) => s.endsAt > now && s.startsAt.getTime() < now.getTime() + 24 * 3600_000,
  );
  const todayShift = next
    ? (() => {
        const from = new Date(
          Math.max(
            next.startsAt.getTime(),
            onClock ? now.getTime() : next.startsAt.getTime(),
          ),
        );
        return {
          startsAt: next.startsAt.toISOString(),
          endsAt: next.endsAt.toISOString(),
          // The next shift is first on the remaining clock, so its OT
          // split starts right where the worked week left off.
          estAmount: round2(
            payForBlock(workedMin, paidMinutesForRange(from, next.endsAt), rate),
          ),
          inProgress: next.startsAt <= now,
        };
      })()
    : null;

  const otHoursSoFar = Math.max(0, workedMin - OT_THRESHOLD_MIN) / 60;
  const projectedOtHours =
    Math.max(0, workedMin + remainingMin - OT_THRESHOLD_MIN) / 60;

  return {
    weekStart: weekStart.toISOString(),
    weekEnd: weekEnd.toISOString(),
    hourlyRate: rate,
    rateSource: source,
    earnedSoFar: round2(earnedSoFar),
    workedHours: round2(workedMin / 60),
    projectedWeek: round2(earnedSoFar + remainingAmount),
    remainingHours: round2(remainingMin / 60),
    onClock,
    currentRatePerHour: round2(
      workedMin >= OT_THRESHOLD_MIN ? rate * OT_MULTIPLIER : rate,
    ),
    overtime: {
      thresholdHours: OT_THRESHOLD_MIN / 60,
      multiplier: OT_MULTIPLIER,
      unlocked: workedMin >= OT_THRESHOLD_MIN,
      otHoursSoFar: round2(otHoursSoFar),
      projectedOtHours: round2(projectedOtHours),
    },
    lastWeekEarned,
    days,
    openShifts: {
      count: openEligible.length,
      estAmount: round2(openAmount),
    },
    todayShift,
  };
}

/**
 * The clock-out moment — fire-and-forget from the kiosk punch handler.
 * Lands on the associate's own bell/push, never the shared kiosk screen.
 * OT-aware: if the week already crossed 40h, the added amount reflects
 * the 1.5× the paycheck will actually show.
 */
export async function notifyClockOutEarnings(
  prisma: PrismaClient,
  timeEntryId: string,
): Promise<void> {
  const entry = await prisma.timeEntry.findUnique({
    where: { id: timeEntryId },
    select: {
      associateId: true,
      clockInAt: true,
      clockOutAt: true,
      breaks: { select: { type: true, startedAt: true, endedAt: true } },
    },
  });
  if (!entry?.clockOutAt) return;
  const mins = netWorkedMinutes(
    { clockInAt: entry.clockInAt, clockOutAt: entry.clockOutAt },
    entry.breaks,
  );
  if (mins <= 0) return;
  const { rate } = await hourlyRateFor(prisma, entry.associateId);

  // Where in the week did this entry land? Sum the week's earlier entries
  // so the straight/1.5× split matches payroll's chronological walk.
  const weekStart = startOfWeekUTC(entry.clockOutAt);
  const priors = await prisma.timeEntry.findMany({
    where: {
      associateId: entry.associateId,
      status: { in: ['APPROVED', 'COMPLETED'] },
      clockInAt: { gte: weekStart, lt: entry.clockInAt },
      id: { not: timeEntryId },
    },
    select: {
      clockInAt: true,
      clockOutAt: true,
      breaks: { select: { type: true, startedAt: true, endedAt: true } },
    },
    take: 100,
  });
  let cumBefore = 0;
  for (const p of priors) {
    if (!p.clockOutAt) continue;
    cumBefore += netWorkedMinutes(
      { clockInAt: p.clockInAt, clockOutAt: p.clockOutAt },
      p.breaks,
    );
  }

  const amount = round2(payForBlock(cumBefore, mins, rate));
  const otMinutes = Math.max(0, cumBefore + mins - OT_THRESHOLD_MIN) - Math.max(0, cumBefore - OT_THRESHOLD_MIN);
  const hours = (mins / 60).toFixed(2);
  // Awaited: the kiosk call site fire-and-forgets THIS helper, so
  // awaiting the insert here costs the punch nothing — and callers that
  // do await (tests) see the row.
  await notifyAssociate(entry.associateId, {
    subject: `You just added ~$${amount.toFixed(2)} to your week 💪`,
    body:
      `${hours}h worked today at ~$${rate.toFixed(2)}/hr.` +
      (otMinutes > 0
        ? ` Includes ${(otMinutes / 60).toFixed(2)}h of overtime at 1.5×.`
        : '') +
      ' Estimated and before taxes — your paycheck is the official number. Great shift!',
    category: 'earnings',
    linkUrl: '/',
  });
}
