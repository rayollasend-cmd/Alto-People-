/**
 * The payroll-tax calendar: business days (weekends and federal legal
 * holidays roll a due date forward, as the IRS and the states apply them),
 * deposit due dates by schedule, and quarters.
 *
 *   NEXT_DAY     the next business day after the payday ($100k rule, or a
 *                state that wants every payday's tax at once)
 *   SEMIWEEKLY   Wed–Fri paydays → the following Wednesday; Sat–Tue → the
 *                following Friday (Pub 15 §11)
 *   MONTHLY      `dueDay` of the following month (the IRS and most states
 *                use the 15th; some use the 20th or 25th — set per account)
 *   QUARTERLY    the last day of the month after the quarter
 *   ANNUAL       January 31 of the next year
 *
 * Every date here is a UTC calendar date (no time of day).
 */

export type DepositFrequency = 'NEXT_DAY' | 'SEMIWEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';
export const DEPOSIT_FREQUENCIES: readonly DepositFrequency[] = ['NEXT_DAY', 'SEMIWEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUAL'];

const DAY = 86_400_000;
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));
const ymd = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);

/** The nth weekday (0=Sun…6=Sat) of a month; n = -1 for the last. */
function nthWeekday(year: number, month: number, weekday: number, n: number): Date {
  if (n > 0) {
    const first = utc(year, month, 1);
    const offset = (weekday - first.getUTCDay() + 7) % 7;
    return utc(year, month, 1 + offset + (n - 1) * 7);
  }
  const last = utc(year, month + 1, 0);
  const back = (last.getUTCDay() - weekday + 7) % 7;
  return utc(year, month, last.getUTCDate() - back);
}

const holidayCache = new Map<number, Set<string>>();

/** Federal legal holidays for a year, as observed (a Sunday holiday moves to Monday). */
export function federalHolidays(year: number): Set<string> {
  const cached = holidayCache.get(year);
  if (cached) return cached;
  const fixed = [utc(year, 0, 1), utc(year, 5, 19), utc(year, 6, 4), utc(year, 10, 11), utc(year, 11, 25)];
  const observed = fixed.map((d) => (d.getUTCDay() === 0 ? addDays(d, 1) : d));
  const floating = [
    nthWeekday(year, 0, 1, 3), // Martin Luther King Jr. Day
    nthWeekday(year, 1, 1, 3), // Washington's Birthday
    nthWeekday(year, 4, 1, -1), // Memorial Day
    nthWeekday(year, 8, 1, 1), // Labor Day
    nthWeekday(year, 9, 1, 2), // Columbus Day
    nthWeekday(year, 10, 4, 4), // Thanksgiving
  ];
  const set = new Set([...observed, ...floating].map(ymd));
  holidayCache.set(year, set);
  return set;
}

export function isBusinessDay(d: Date): boolean {
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !federalHolidays(d.getUTCFullYear()).has(ymd(d));
}

/** The date itself when it is a business day, else the next one. */
export function rollToBusinessDay(d: Date): Date {
  let c = utc(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  while (!isBusinessDay(c)) c = addDays(c, 1);
  return c;
}

export function quarterOf(d: Date): { year: number; quarter: 1 | 2 | 3 | 4 } {
  return { year: d.getUTCFullYear(), quarter: (Math.floor(d.getUTCMonth() / 3) + 1) as 1 | 2 | 3 | 4 };
}

export function quarterLabel(d: Date): string {
  const q = quarterOf(d);
  return `${q.year}-Q${q.quarter}`;
}

/** "2026-Q4" → its first and last day; "2026" → the calendar year. */
export function periodBounds(label: string): { start: Date; end: Date; endExclusive: Date; annual: boolean } {
  const q = /^(\d{4})-Q([1-4])$/.exec(label);
  if (q) {
    const year = Number(q[1]);
    const first = (Number(q[2]) - 1) * 3;
    return { start: utc(year, first, 1), end: utc(year, first + 3, 0), endExclusive: utc(year, first + 3, 1), annual: false };
  }
  const y = /^(\d{4})$/.exec(label);
  if (y) {
    const year = Number(y[1]);
    return { start: utc(year, 0, 1), end: utc(year, 11, 31), endExclusive: utc(year + 1, 0, 1), annual: true };
  }
  throw new Error(`Not a quarter or a year: ${label}`);
}

/** Quarterly returns and deposits: the last day of the month after the quarter (business day). */
export function quarterlyDueDate(periodLabel: string): Date {
  const { endExclusive } = periodBounds(periodLabel);
  return rollToBusinessDay(utc(endExclusive.getUTCFullYear(), endExclusive.getUTCMonth() + 1, 0));
}

/** Annual returns: January 31 of the next year (business day). */
export function annualDueDate(year: number): Date {
  return rollToBusinessDay(utc(year + 1, 0, 31));
}

/** When a liability arising on `payday` is due under a schedule. */
export function depositDue(payday: Date, frequency: DepositFrequency, dueDay = 15): Date {
  const p = utc(payday.getUTCFullYear(), payday.getUTCMonth(), payday.getUTCDate());
  switch (frequency) {
    case 'NEXT_DAY':
      return rollToBusinessDay(addDays(p, 1));
    case 'SEMIWEEKLY': {
      const dow = p.getUTCDay();
      if (dow >= 3 && dow <= 5) return rollToBusinessDay(addDays(p, ((3 - dow + 7) % 7) || 7));
      return rollToBusinessDay(addDays(p, ((5 - dow + 7) % 7) || 7));
    }
    case 'MONTHLY': {
      const day = Math.min(Math.max(dueDay, 1), 28);
      return rollToBusinessDay(utc(p.getUTCFullYear(), p.getUTCMonth() + 1, day));
    }
    case 'QUARTERLY':
      return quarterlyDueDate(quarterLabel(p));
    case 'ANNUAL':
      return annualDueDate(p.getUTCFullYear());
  }
}

export function isDepositFrequency(v: unknown): v is DepositFrequency {
  return typeof v === 'string' && (DEPOSIT_FREQUENCIES as readonly string[]).includes(v);
}
