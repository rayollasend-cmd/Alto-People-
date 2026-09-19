import type { PayrollFrequency } from '@prisma/client';
import { prisma } from '../db.js';
import { getNextPayday } from './payrollSchedule.js';
import { placedClientIds } from './openShiftEligibility.js';

/**
 * An associate's next payday and the period it pays for — their own pay
 * schedule, else their client's, else the org default; null when none is
 * set up. (Alto: biweekly Sat→Fri periods paid the Friday after.)
 */
export async function nextPaydayFor(
  associateId: string,
  now: Date = new Date(),
): Promise<{ payDate: string; periodStart: string; periodEnd: string; schedule: string } | null> {
  const live = { isActive: true, deletedAt: null } as const;
  const scheduleSelect = { name: true, frequency: true, anchorDate: true, payDateOffsetDays: true } as const;
  const own = await prisma.associate.findUnique({
    where: { id: associateId },
    select: { payrollSchedule: { select: { ...scheduleSelect, isActive: true, deletedAt: true } } },
  });
  let schedule: { name: string; frequency: PayrollFrequency; anchorDate: Date; payDateOffsetDays: number } | null =
    own?.payrollSchedule && own.payrollSchedule.isActive && !own.payrollSchedule.deletedAt ? own.payrollSchedule : null;
  if (!schedule) {
    const clientIds = await placedClientIds(associateId);
    schedule =
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
      }));
  }
  if (!schedule) return null;
  const w = getNextPayday(schedule, now);
  return { payDate: w.payDate, periodStart: w.periodStart, periodEnd: w.periodEnd, schedule: schedule.name };
}
