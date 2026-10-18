import type { PayrollBankingProfile, Prisma, PrismaClient } from '@prisma/client';
import { getCurrentPeriod, getPeriodAfter, type ScheduleInput } from '../payrollSchedule.js';
import { tenantIdForWrite } from '../tenant.js';
import { loadTenantHolidays } from './funding.js';
import { achTimeline, currentHolidayOverrides, federalReserveHolidays, type AchSpeed } from './holidays.js';

/**
 * The payroll calendar for a year: every pay date each schedule produces,
 * where a weekend or holiday moved it, and when the money has to move —
 * the day the employee file goes to the bank and the funding deadline.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export interface CalendarRow {
  scheduleId: string;
  scheduleName: string;
  periodStart: string;
  periodEnd: string;
  nominalPayDate: string;
  payDate: string;
  shiftReason: string | null;
  creditSubmitDate: string;
  debitEffectiveDate: string;
  fundingDeadline: string;
}

export interface CalendarYear {
  year: number;
  achSpeed: AchSpeed;
  cutoffEt: string;
  holidays: Array<{ date: string; name: string; source: 'FEDERAL_RESERVE' | 'OVERRIDE'; closed: boolean }>;
  rows: CalendarRow[];
}

/** Pay dates (by their nominal date) in `year` for one schedule. */
export function payDatesInYear(schedule: ScheduleInput, year: number): ReturnType<typeof getCurrentPeriod>[] {
  const out: ReturnType<typeof getCurrentPeriod>[] = [];
  // Start a couple of months back: a December period can pay in January.
  let w = getCurrentPeriod(schedule, new Date(Date.UTC(year - 1, 10, 1)));
  for (let i = 0; i < 120; i++) {
    const nominal = w.nominalPayDate ?? w.payDate;
    if (nominal.slice(0, 4) > String(year)) break;
    if (nominal.slice(0, 4) === String(year)) out.push(w);
    w = getPeriodAfter(schedule, w);
  }
  return out;
}

export async function payrollCalendar(db: Db, profile: PayrollBankingProfile, year: number): Promise<CalendarYear> {
  await loadTenantHolidays(db);
  // Daily pay settles every day on its own rail; the calendar is for scheduled runs.
  const schedules = (await db.payrollSchedule.findMany({ where: { tenantId: tenantIdForWrite(), isActive: true, deletedAt: null }, orderBy: { name: 'asc' }, take: 50 })).filter((s) => (s.frequency as string) !== 'DAILY');
  const speed = profile.achSpeed as AchSpeed;
  const rows: CalendarRow[] = [];
  for (const s of schedules) {
    for (const w of payDatesInYear(s, year)) {
      const t = achTimeline(w.payDate, speed, profile.submitCutoffEt);
      rows.push({
        scheduleId: s.id,
        scheduleName: s.name,
        periodStart: w.periodStart,
        periodEnd: w.periodEnd,
        nominalPayDate: w.nominalPayDate ?? w.payDate,
        payDate: w.payDate,
        shiftReason: w.payDateShiftReason ?? null,
        creditSubmitDate: t.creditSubmitDate,
        debitEffectiveDate: t.debitEffectiveDate,
        fundingDeadline: t.fundingDeadline.toISOString(),
      });
    }
  }
  rows.sort((a, b) => a.payDate.localeCompare(b.payDate) || a.scheduleName.localeCompare(b.scheduleName));
  const overrides = currentHolidayOverrides().filter((o) => o.date.startsWith(String(year)));
  const fed = federalReserveHolidays(year).filter((h) => !overrides.some((o) => o.date === h.date));
  return {
    year,
    achSpeed: speed,
    cutoffEt: profile.submitCutoffEt,
    holidays: [
      ...fed.map((h) => ({ date: h.date, name: h.name, source: 'FEDERAL_RESERVE' as const, closed: true })),
      ...overrides.map((o) => ({ date: o.date, name: o.name, source: 'OVERRIDE' as const, closed: o.closed })),
    ].sort((a, b) => a.date.localeCompare(b.date)),
    rows,
  };
}
