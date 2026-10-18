/**
 * Banking days.
 *
 * ACH settles only on days the Federal Reserve is open: weekdays that are
 * not one of its eleven holidays. The Fed's own observance rule — a
 * holiday on a Sunday is observed Monday; one on a Saturday is NOT moved
 * (the Fed is open the Friday before) — so "July 4 on a Saturday" leaves
 * Friday a banking day. A tenant can add a day its bank is closed (or mark
 * one open) through BankHolidayOverride; those are loaded into memory per
 * tenant, so the date math here stays synchronous and pure.
 *
 * A pay date that falls on a weekend or holiday moves to the business day
 * before it: people are paid early, never late.
 */

import { currentTenantId } from '../tenant.js';

const DAY = 86_400_000;

/** YYYY-MM-DD at UTC midnight. */
export function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}
export function parseYmd(s: string): Date {
  return new Date(`${s.slice(0, 10)}T00:00:00.000Z`);
}
function addDays(s: string, n: number): string {
  return ymd(new Date(parseYmd(s).getTime() + n * DAY));
}
function nthWeekday(year: number, month: number, weekday: number, n: number): string {
  const first = new Date(Date.UTC(year, month, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return ymd(new Date(Date.UTC(year, month, 1 + offset + (n - 1) * 7)));
}
function lastWeekday(year: number, month: number, weekday: number): string {
  const last = new Date(Date.UTC(year, month + 1, 0));
  const offset = (last.getUTCDay() - weekday + 7) % 7;
  return ymd(new Date(Date.UTC(year, month + 1, -offset)));
}
/** Fixed-date holidays: Sunday → Monday; Saturday stays (the Fed is open Friday). */
function observedFixed(year: number, month: number, day: number): string | null {
  const d = new Date(Date.UTC(year, month, day));
  if (d.getUTCDay() === 6) return null;
  if (d.getUTCDay() === 0) return ymd(new Date(d.getTime() + DAY));
  return ymd(d);
}

export interface Holiday {
  date: string;
  name: string;
}

const cache = new Map<number, Holiday[]>();

/** The Federal Reserve's holidays for a year, as observed. */
export function federalReserveHolidays(year: number): Holiday[] {
  const hit = cache.get(year);
  if (hit) return hit;
  const list: Array<Holiday | null> = [
    ((d) => (d ? { date: d, name: 'New Year’s Day' } : null))(observedFixed(year, 0, 1)),
    { date: nthWeekday(year, 0, 1, 3), name: 'Martin Luther King Jr. Day' },
    { date: nthWeekday(year, 1, 1, 3), name: 'Washington’s Birthday' },
    { date: lastWeekday(year, 4, 1), name: 'Memorial Day' },
    ((d) => (d ? { date: d, name: 'Juneteenth' } : null))(observedFixed(year, 5, 19)),
    ((d) => (d ? { date: d, name: 'Independence Day' } : null))(observedFixed(year, 6, 4)),
    { date: nthWeekday(year, 8, 1, 1), name: 'Labor Day' },
    { date: nthWeekday(year, 9, 1, 2), name: 'Columbus Day' },
    ((d) => (d ? { date: d, name: 'Veterans Day' } : null))(observedFixed(year, 10, 11)),
    { date: nthWeekday(year, 10, 4, 4), name: 'Thanksgiving Day' },
    ((d) => (d ? { date: d, name: 'Christmas Day' } : null))(observedFixed(year, 11, 25)),
  ];
  const out = list.filter((h): h is Holiday => !!h).sort((a, b) => a.date.localeCompare(b.date));
  cache.set(year, out);
  return out;
}

/* ----- tenant overrides (loaded by lib/banking/calendar.ts) ---------------- */

export interface HolidayOverride {
  date: string;
  name: string;
  closed: boolean;
}
// Per tenant (the request's async context), so two tenants computing at
// once never see each other's bank days.
const overridesByTenant = new Map<string, Map<string, HolidayOverride>>();
const overrideKey = () => currentTenantId() ?? '_';

/** Replace the overrides in force for the current tenant (the calendar loads them before computing). */
export function setHolidayOverrides(list: HolidayOverride[]): void {
  overridesByTenant.set(overrideKey(), new Map(list.map((o) => [o.date, o])));
}
export function currentHolidayOverrides(): HolidayOverride[] {
  return [...(overridesByTenant.get(overrideKey())?.values() ?? [])];
}

/** Why a day isn't a banking day, or null when it is. */
export function closedReason(date: string): string | null {
  const o = overridesByTenant.get(overrideKey())?.get(date);
  if (o) return o.closed ? o.name : null;
  const d = parseYmd(date);
  const dow = d.getUTCDay();
  if (dow === 0) return 'Sunday';
  if (dow === 6) return 'Saturday';
  const h = federalReserveHolidays(d.getUTCFullYear()).find((x) => x.date === date);
  return h ? h.name : null;
}

export function isBankingDay(date: string): boolean {
  return closedReason(date) === null;
}

/** The banking day `n` banking days before (negative) or after (positive) `date`. */
export function addBankingDays(date: string, n: number): string {
  let d = date;
  let left = Math.abs(n);
  const step = n < 0 ? -1 : 1;
  while (left > 0) {
    d = addDays(d, step);
    if (isBankingDay(d)) left -= 1;
  }
  return d;
}

/** `date` itself when it is a banking day, else the banking day before it. */
export function onOrBeforeBankingDay(date: string): string {
  let d = date;
  while (!isBankingDay(d)) d = addDays(d, -1);
  return d;
}

/** A pay date moved to the business day before a weekend or holiday, with why. */
export function adjustPayDate(nominal: string): { payDate: string; shifted: boolean; reason: string | null } {
  const reason = closedReason(nominal);
  if (!reason) return { payDate: nominal, shifted: false, reason: null };
  return { payDate: onOrBeforeBankingDay(nominal), shifted: true, reason };
}

/* ----- ACH timing ----------------------------------------------------------- */

export type AchSpeed = 'SAME_DAY' | 'NEXT_DAY' | 'TWO_DAY';

/**
 * Same-day ACH submission windows at the Federal Reserve (Eastern time) and
 * when each settles. Your bank's own deadlines are earlier — the profile's
 * submitCutoffEt is what we hold you to.
 */
export const SAME_DAY_WINDOWS: ReadonlyArray<{ submitBy: string; settles: string; label: string }> = [
  { submitBy: '10:30', settles: '13:00', label: 'First window' },
  { submitBy: '14:45', settles: '17:00', label: 'Second window' },
  { submitBy: '16:45', settles: '18:00', label: 'Third window' },
];

export interface AchTimeline {
  payDate: string;
  /** Credits settle in employees' accounts on the pay date. */
  creditEffectiveDate: string;
  /** The day the credit file must reach the bank. */
  creditSubmitDate: string;
  /** The employer's debit settles this day — a banking day before credits are released. */
  debitEffectiveDate: string;
  /** The debit (and so the run's approval) must reach the bank by the cutoff on this day. */
  debitSubmitDate: string;
  /** That cutoff as an instant (Eastern time). */
  fundingDeadline: Date;
}

/**
 * Working back from the pay date. Credits always settle on the pay date;
 * the employer's money must have settled at least one banking day before.
 *
 *   SAME_DAY  credits sent the morning of the pay date; debit settles the day before
 *   NEXT_DAY  credits sent the banking day before; debit settles two days before
 *   TWO_DAY   credits sent two banking days before; debit settles three days before
 *
 * A debit is sent as next-day ACH, so it reaches the bank the banking day
 * before it settles.
 */
export function achTimeline(payDate: string, speed: AchSpeed, cutoffEt = '16:00'): AchTimeline {
  const creditLead = speed === 'SAME_DAY' ? 0 : speed === 'NEXT_DAY' ? 1 : 2;
  const creditSubmitDate = creditLead === 0 ? payDate : addBankingDays(payDate, -creditLead);
  const debitEffectiveDate = addBankingDays(payDate, -(creditLead + 1));
  const debitSubmitDate = addBankingDays(debitEffectiveDate, -1);
  return {
    payDate,
    creditEffectiveDate: payDate,
    creditSubmitDate,
    debitEffectiveDate,
    debitSubmitDate,
    fundingDeadline: easternInstant(debitSubmitDate, cutoffEt),
  };
}

/** HH:MM on a date in America/New_York, as a UTC instant (DST-correct). */
export function easternInstant(date: string, hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  // Find the UTC offset New York has at noon that day, then apply it.
  const probe = new Date(`${date}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' }).formatToParts(probe);
  const nyHour = Number(parts.find((p) => p.type === 'hour')?.value ?? '8');
  const offsetHours = 12 - nyHour; // 4 in summer, 5 in winter
  return new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), h + offsetHours, m));
}
