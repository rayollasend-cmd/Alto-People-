import { Prisma } from '@prisma/client';
import { weeklySplit } from './laborRules/hours.js';
import { roundCents } from './roundCents.js';

// Federal income tax withholding is lib/payrollTax.ts computeFederalIncomeTax
// (IRS Pub 15-T Worksheet 1A, percentage method, the W-4's steps), reached
// through the tax engine (lib/taxEngine). The flat-bracket placeholder that
// once sat here (computeFederalWithholding, 18/14/16%) was called by no pay
// path — only its own unit test — and is gone so nothing can reach for it.

/** Dollars to the cent, half away from zero — integer-cent rounding (lib/roundCents; deep audit CODE-27). */
export function round2(n: number): number {
  return roundCents(n);
}

/** Convert milliseconds → fractional hours, rounded to 2 decimals. */
export function msToHours(ms: number): number {
  return round2(ms / (1000 * 60 * 60));
}

/** An entry as the pay math sees it — clock times plus (optionally) its
 *  breaks, so pay is computed net-of-breaks exactly like the time-review
 *  screen, the exports, and the external-payroll sheet. */
export interface PayableEntry {
  status: string;
  clockInAt: Date;
  clockOutAt: Date | null;
  breaks?: Array<{ startedAt: Date; endedAt: Date | null }>;
  /** Brief 1A-2: the site's zone decides which week an hour belongs to (a Central site's Friday night is still Friday). */
  location?: { timezone: string } | null;
}

/**
 * Paid milliseconds for one closed entry: clock span minus break time.
 * Breaks are clamped to non-negative and an open-ended break (crash mid-
 * break) ends at clock-out — mirrors netWorkedMinutes in timeAnomalies.
 */
export function payableMs(e: PayableEntry): number {
  if (!e.clockOutAt) return 0;
  const end = e.clockOutAt.getTime();
  let ms = end - e.clockInAt.getTime();
  for (const b of e.breaks ?? []) {
    const bEnd = b.endedAt ? b.endedAt.getTime() : end;
    ms -= Math.max(0, bEnd - b.startedAt.getTime());
  }
  return Math.max(0, ms);
}

/**
 * Aggregate APPROVED time entries for one associate within a period.
 * Returns total hours worked, NET of breaks. Excludes ACTIVE/COMPLETED/
 * REJECTED. Callers must load `breaks` on each entry — an entry without
 * them is treated as break-free (its full clock span pays).
 */
export function sumApprovedHours(entries: PayableEntry[]): number {
  let totalMs = 0;
  for (const e of entries) {
    if (e.status !== 'APPROVED') continue;
    totalMs += payableMs(e);
  }
  return msToHours(totalMs);
}

/** Pick the best hourly rate for an associate from their period shifts. */
export function pickHourlyRate(
  shifts: Array<{ hourlyRate: Prisma.Decimal | null }>,
  defaultRate: number
): number {
  // Use the highest rate among ASSIGNED/COMPLETED shifts in the period —
  // a defensible choice for an MVP. Real payroll uses contracted rate.
  let best = defaultRate;
  for (const s of shifts) {
    if (s.hourlyRate === null) continue;
    const r = Number(s.hourlyRate);
    if (r > best) best = r;
  }
  return round2(best);
}

/**
 * The federal weekly overtime split pay has always used: hours past 40 in a
 * company workweek (the site's zone decides which week an hour falls in)
 * at 1.5×, each week on its own. APPROVED, closed entries only.
 *
 * One implementation: the labor-rules engine's weeklySplit
 * (lib/laborRules/hours). Pay itself goes through splitHours there, which
 * adds the live jurisdictions' daily, seventh-day and double-time rules;
 * this stays for the callers that want exactly the FLSA weekly figure.
 */
export function splitWeeklyOvertime(
  entries: PayableEntry[]
): { regularHours: number; overtimeHours: number } {
  const { regularHours, overtimeHours } = weeklySplit(
    entries
      .filter((e) => e.status === 'APPROVED')
      .map((e) => ({ clockInAt: e.clockInAt, clockOutAt: e.clockOutAt, breaks: e.breaks, site: e.location ? { id: '', state: null, city: null, timezone: e.location.timezone } : null })),
  );
  return { regularHours, overtimeHours };
}

