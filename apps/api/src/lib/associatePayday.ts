import type { PayrollFrequency } from '@prisma/client';
import { prisma } from '../db.js';
import { getNextPayday, getPeriodAfter } from './payrollSchedule.js';
import { placedClientIds } from './openShiftEligibility.js';
import { DEFAULT_TIMEZONE } from './timezone.js';
import { dateKeyInZone } from './timeAnomalies.js';

/**
 * An associate's next payday and the period it pays for — their own pay
 * schedule, else their client's, else the org default; null when none is
 * set up. (Alto: biweekly Sat→Fri periods paid the Friday after.)
 *
 * "Next" is strictly after today: on a payday the associate is being paid
 * today, and the date they're waiting on is the following one (Fri Sep 18
 * pays Aug 29–Sep 11 → next payday Fri Oct 2 for Sep 12–25). And "today"
 * is the org's calendar day, not UTC's — from 8 PM Eastern the UTC date is
 * already tomorrow, which flipped the answer a few hours early.
 */
export interface ResolvedPaySchedule {
  name: string;
  frequency: PayrollFrequency;
  anchorDate: Date;
  payDateOffsetDays: number;
}

/** The pay schedule an associate is paid on — their own, else their
 *  client's, else the org default; null when none is set up. */
export async function payScheduleFor(associateId: string): Promise<ResolvedPaySchedule | null> {
  const live = { isActive: true, deletedAt: null } as const;
  const scheduleSelect = { name: true, frequency: true, anchorDate: true, payDateOffsetDays: true } as const;
  const own = await prisma.associate.findUnique({
    where: { id: associateId },
    select: { payrollSchedule: { select: { ...scheduleSelect, isActive: true, deletedAt: true } } },
  });
  if (own?.payrollSchedule && own.payrollSchedule.isActive && !own.payrollSchedule.deletedAt) {
    const { isActive: _a, deletedAt: _d, ...schedule } = own.payrollSchedule;
    return schedule;
  }
  const clientIds = await placedClientIds(associateId);
  return (
    (clientIds.length
      ? await prisma.payrollSchedule.findFirst({
          where: { ...live, clientId: { in: clientIds } },
          orderBy: { createdAt: 'asc' },
          select: scheduleSelect,
        })
      : null) ??
    (await prisma.payrollSchedule.findFirst({
      where: { ...live, clientId: null },
      orderBy: { createdAt: 'asc' },
      select: scheduleSelect,
    }))
  );
}

export async function nextPaydayFor(
  associateId: string,
  now: Date = new Date(),
): Promise<{
  payDate: string;
  periodStart: string;
  periodEnd: string;
  schedule: string;
  /** Today is a payday: the days it pays for (until midnight). */
  paidToday: { periodStart: string; periodEnd: string } | null;
} | null> {
  const schedule = await payScheduleFor(associateId);
  if (!schedule) return null;
  const today = dateKeyInZone(now, DEFAULT_TIMEZONE);
  let w = getNextPayday(schedule, new Date(`${today}T12:00:00.000Z`));
  const paidToday = w.payDate === today ? { periodStart: w.periodStart, periodEnd: w.periodEnd } : null;
  if (w.payDate <= today) w = getPeriodAfter(schedule, w);
  return { payDate: w.payDate, periodStart: w.periodStart, periodEnd: w.periodEnd, schedule: schedule.name, paidToday };
}
