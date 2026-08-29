// Associate earnings motivation — the paycheck made visible:
//   · GET /time/me/earnings: this org week (Sat→Fri) as money — earned
//     so far (approved + completed + live on-the-clock minutes), what
//     the rest of the schedule is worth, and today's shift as a number.
//   · Clock-out moment: "You just added ~$112 to your week" pushed to
//     the associate's OWN phone/bell — deliberately not the shared kiosk
//     screen, where a dollar figure would leak their pay rate to the
//     next person in line.
// All figures are ESTIMATES: gross, before taxes, at the associate's
// hourly comp record (else the org default rate). Payroll remains the
// source of truth.

import type { PrismaClient } from '@prisma/client';
import { paidMinutesForRange } from '@alto-people/shared';
import { env } from '../config/env.js';
import { notifyAssociate } from './notify.js';
import { endOfWeekUTC, netWorkedMinutes, startOfWeekUTC } from './timeAnomalies.js';

const round2 = (n: number) => Math.round(n * 100) / 100;

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

export interface AssociateEarnings {
  weekStart: string;
  weekEnd: string;
  hourlyRate: number;
  rateSource: 'comp' | 'default';
  /** Net worked this week so far, incl. live on-the-clock minutes. */
  earnedSoFar: number;
  workedHours: number;
  /** earnedSoFar + the rest of this week's assigned schedule. */
  projectedWeek: number;
  remainingHours: number;
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

  const [entries, shifts] = await Promise.all([
    prisma.timeEntry.findMany({
      where: {
        associateId,
        status: { in: ['APPROVED', 'COMPLETED', 'ACTIVE'] },
        clockInAt: { gte: weekStart, lt: weekEnd },
      },
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
  ]);

  let workedMin = 0;
  let onClock = false;
  for (const e of entries) {
    if (e.clockOutAt) {
      workedMin += netWorkedMinutes(
        { clockInAt: e.clockInAt, clockOutAt: e.clockOutAt },
        e.breaks,
      );
    } else if (e.status === 'ACTIVE') {
      // Live: money accrues while they stand on the floor (capped at 16h
      // so a forgotten clock-out can't paint a fantasy number).
      onClock = true;
      workedMin += Math.min(16 * 60, Math.max(0, Math.round((now.getTime() - e.clockInAt.getTime()) / 60_000)));
    }
  }

  // The rest of the schedule: future shifts fully; an in-progress
  // shift only from now to its end (the walked part is already in
  // workedMin via the live entry).
  let remainingMin = 0;
  for (const s of shifts) {
    const from = s.startsAt > now ? s.startsAt : now;
    // Paid minutes (unpaid-break rule) — never promise money for the
    // meal hour: a 9h overnight projects 8 paid hours.
    remainingMin += paidMinutesForRange(from, s.endsAt);
  }

  const next = shifts.find(
    (s) => s.endsAt > now && s.startsAt.getTime() < now.getTime() + 24 * 3600_000,
  );
  const todayShift = next
    ? {
        startsAt: next.startsAt.toISOString(),
        endsAt: next.endsAt.toISOString(),
        estAmount: round2(
          (paidMinutesForRange(
            new Date(
              Math.max(
                next.startsAt.getTime(),
                onClock ? now.getTime() : next.startsAt.getTime(),
              ),
            ),
            next.endsAt,
          ) /
            60) *
            rate,
        ),
        inProgress: next.startsAt <= now,
      }
    : null;

  const earnedSoFar = round2((workedMin / 60) * rate);
  return {
    weekStart: weekStart.toISOString(),
    weekEnd: weekEnd.toISOString(),
    hourlyRate: rate,
    rateSource: source,
    earnedSoFar,
    workedHours: round2(workedMin / 60),
    projectedWeek: round2(earnedSoFar + (remainingMin / 60) * rate),
    remainingHours: round2(remainingMin / 60),
    todayShift,
  };
}

/**
 * The clock-out moment — fire-and-forget from the kiosk punch handler.
 * Lands on the associate's own bell/push, never the shared kiosk screen.
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
  const amount = round2((mins / 60) * rate);
  const hours = (mins / 60).toFixed(2);
  // Awaited: the kiosk call site fire-and-forgets THIS helper, so
  // awaiting the insert here costs the punch nothing — and callers that
  // do await (tests) see the row.
  await notifyAssociate(entry.associateId, {
    subject: `You just added ~$${amount.toFixed(2)} to your week 💪`,
    body: `${hours}h worked today at ~$${rate.toFixed(2)}/hr. Estimated and before taxes — your paycheck is the official number. Great shift!`,
    category: 'earnings',
    linkUrl: '/',
  });
}
