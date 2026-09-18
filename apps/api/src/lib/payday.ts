/**
 * Next-payday math shared by the Finance cockpit and the Workforce
 * command center — both portals count down to the same sacred date.
 */
import type { PayrollFrequency } from '@prisma/client';
import { getNextPayday } from './payrollSchedule.js';

/**
 * Next pay date for a schedule — lib/payrollSchedule's getNextPayday, the
 * one payday calculation (the anchor is the FIRST day of a pay period; pay
 * lands payDateOffsetDays after the period's last day). This used to treat
 * the anchor as a period END, so the Finance/Workforce countdown and the
 * payroll wizard named different Fridays for the same schedule. Payday
 * itself counts (it's "today" until the day is over).
 */
export function nextPayDate(
  s: { frequency: string; anchorDate: Date; payDateOffsetDays: number },
  now: Date,
): Date | null {
  if (!['WEEKLY', 'BIWEEKLY', 'SEMIMONTHLY', 'MONTHLY'].includes(s.frequency)) return null;
  const w = getNextPayday(
    { frequency: s.frequency as PayrollFrequency, anchorDate: s.anchorDate, payDateOffsetDays: s.payDateOffsetDays },
    now,
  );
  return new Date(`${w.payDate}T12:00:00.000Z`);
}

/** Soonest upcoming payday across the active schedules, or null. */
export async function soonestPayday(
  prisma: {
    payrollSchedule: {
      findMany: (args: {
        where: { isActive: boolean; deletedAt: null };
        select: {
          name: true;
          frequency: true;
          anchorDate: true;
          payDateOffsetDays: true;
        };
      }) => Promise<
        Array<{
          name: string;
          frequency: string;
          anchorDate: Date;
          payDateOffsetDays: number;
        }>
      >;
    };
  },
  now: Date,
): Promise<{ date: string; schedule: string } | null> {
  const schedules = await prisma.payrollSchedule.findMany({
    where: { isActive: true, deletedAt: null },
    select: {
      name: true,
      frequency: true,
      anchorDate: true,
      payDateOffsetDays: true,
    },
  });
  let payday: { date: string; schedule: string } | null = null;
  for (const s of schedules) {
    const d = nextPayDate(s, now);
    if (d && (!payday || d < new Date(payday.date))) {
      payday = { date: d.toISOString(), schedule: s.name };
    }
  }
  return payday;
}
