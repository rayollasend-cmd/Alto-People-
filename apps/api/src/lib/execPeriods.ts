/**
 * The executive portal's frame (2026-10-27): which days a period covers and
 * what it is read against. Every /executive endpoint and the board pack take
 * their window from here, so "Q4 to date vs plan" means the same days on the
 * scorecard, the drill-downs and the PDF.
 *
 *   week     the last complete company week (Sat→Fri, company time zone)
 *   month    the calendar month to now
 *   quarter  the calendar quarter to now
 *   year     the calendar year to now
 *
 *   prior    the same length immediately before (a to-date period is read
 *            against the previous period's same number of days — October 1–27
 *            against September 1–27, never against all of September)
 *   year     the same span one year earlier
 *   plan     the quarter's targets (ExecTarget), prorated for money
 */
import { EXEC_COMPARE_KEYS, EXEC_PERIOD_KEYS, type ExecComparison, type ExecCompareKey, type ExecPeriod, type ExecPeriodKey } from '@alto-people/shared';
import { companyWorkweek, startOfWeekUTC } from './timeAnomalies.js';
import { localDateKey, zonedWallTimeToUtcInstant } from './timezone.js';
import { fmtDay } from './humanDates.js';

const DAY_MS = 86_400_000;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export interface ExecWindow {
  period: ExecPeriod;
  comparison: ExecComparison;
  /** The period as instants, [from, to). */
  from: Date;
  to: Date;
  /** The comparison span as instants, [from, to); null for the plan. */
  compareFrom: Date | null;
  compareTo: Date | null;
  /** The company time zone the calendar is read in. */
  timezone: string;
}

/** `?period=&compare=` with the defaults — the quarter to date against the prior quarter's same days (the web's clean URL); an unknown value falls back rather than failing. */
export function parseExecQuery(q: Record<string, unknown>): { period: ExecPeriodKey; compare: ExecCompareKey } {
  const p = typeof q.period === 'string' && (EXEC_PERIOD_KEYS as readonly string[]).includes(q.period) ? (q.period as ExecPeriodKey) : 'quarter';
  const c = typeof q.compare === 'string' && (EXEC_COMPARE_KEYS as readonly string[]).includes(q.compare) ? (q.compare as ExecCompareKey) : 'prior';
  return { period: p, compare: c };
}

/** The quarter containing `at` in the company calendar: its key ("2026-Q4") and bounds. */
export function quarterOf(at: Date, timezone: string = companyWorkweek().timezone): { key: string; start: Date; end: Date } {
  const [y, m] = localDateKey(at, timezone).split('-').map(Number) as [number, number];
  const q = Math.floor((m - 1) / 3);
  const start = zonedWallTimeToUtcInstant(y, q * 3 + 1, 1, 0, timezone);
  const end = q === 3 ? zonedWallTimeToUtcInstant(y + 1, 1, 1, 0, timezone) : zonedWallTimeToUtcInstant(y, q * 3 + 4, 1, 0, timezone);
  return { key: `${y}-Q${q + 1}`, start, end };
}

/** Every quarter key a span touches, in order. */
export function quartersBetween(from: Date, to: Date, timezone: string = companyWorkweek().timezone): Array<{ key: string; start: Date; end: Date }> {
  const out: Array<{ key: string; start: Date; end: Date }> = [];
  let at = from;
  while (at < to) {
    const q = quarterOf(at, timezone);
    out.push(q);
    at = q.end;
  }
  return out;
}

/**
 * The plan for a span: each quarter's target spread evenly over its days and
 * summed over the days the span covers. Quarters with no target count as
 * missing — the result is null unless every touched quarter has one.
 */
export function prorateTarget(targets: Map<string, number | null>, from: Date, to: Date, timezone: string = companyWorkweek().timezone): number | null {
  let sum = 0;
  for (const q of quartersBetween(from, to, timezone)) {
    const t = targets.get(q.key);
    if (t === null || t === undefined) return null;
    const overlap = Math.max(0, Math.min(to.getTime(), q.end.getTime()) - Math.max(from.getTime(), q.start.getTime()));
    sum += t * (overlap / (q.end.getTime() - q.start.getTime()));
  }
  return sum;
}

const ymdOf = (d: Date, tz: string) => localDateKey(d, tz);
const lastDayOf = (to: Date, tz: string) => localDateKey(new Date(to.getTime() - 1), tz);
const shiftYear = (d: Date, years: number, tz: string): Date => {
  const [y, m, day] = localDateKey(d, tz).split('-').map(Number) as [number, number, number];
  const minutes = Math.round((d.getTime() - zonedWallTimeToUtcInstant(y, m, day, 0, tz).getTime()) / 60_000);
  // 29 February falls back to the 28th.
  const target = new Date(Date.UTC(y + years, m - 1, day));
  const safeDay = target.getUTCMonth() === m - 1 ? day : 28;
  return zonedWallTimeToUtcInstant(y + years, m, safeDay, minutes, tz);
};

/**
 * Resolve the window. `planSet` says whether the plan comparison has
 * anything to read (the caller knows the targets); availability of history
 * for prior/year is the caller's to mark once it has looked.
 */
export function resolveExecWindow(periodKey: ExecPeriodKey, compareKey: ExecCompareKey, now: Date, opts: { planSet: boolean; quarterKey?: string }): ExecWindow {
  const tz = companyWorkweek().timezone;
  const [y, m] = localDateKey(now, tz).split('-').map(Number) as [number, number];
  let from: Date;
  let to: Date;
  let label: string;
  let complete = false;
  let elapsedPct = 100;
  let calendarEnd: Date;

  if (periodKey === 'week') {
    const thisWeek = startOfWeekUTC(now);
    from = startOfWeekUTC(new Date(thisWeek.getTime() - 36 * 3600_000));
    to = thisWeek;
    calendarEnd = to;
    complete = true;
    label = `Week of ${fmtDay(ymdOf(from, tz))}`;
  } else if (periodKey === 'month') {
    from = zonedWallTimeToUtcInstant(y, m, 1, 0, tz);
    calendarEnd = m === 12 ? zonedWallTimeToUtcInstant(y + 1, 1, 1, 0, tz) : zonedWallTimeToUtcInstant(y, m + 1, 1, 0, tz);
    to = now;
    label = `${MONTHS[m - 1]} to date`;
  } else if (periodKey === 'quarter') {
    const q = quarterOf(now, tz);
    from = q.start;
    calendarEnd = q.end;
    to = now;
    label = `Q${q.key.slice(-1)} to date`;
  } else {
    from = zonedWallTimeToUtcInstant(y, 1, 1, 0, tz);
    calendarEnd = zonedWallTimeToUtcInstant(y + 1, 1, 1, 0, tz);
    to = now;
    label = `${y} to date`;
  }
  if (!complete) {
    elapsedPct = Math.max(0, Math.min(100, Math.round(((to.getTime() - from.getTime()) / (calendarEnd.getTime() - from.getTime())) * 100)));
  }

  const period: ExecPeriod = {
    key: periodKey,
    label,
    start: ymdOf(from, tz),
    end: lastDayOf(to, tz),
    complete,
    elapsedPct,
    asOf: now.toISOString(),
  };

  let compareFrom: Date | null = null;
  let compareTo: Date | null = null;
  let compareLabel: string;
  let available = true;
  let reason: string | null = null;
  if (compareKey === 'plan') {
    const quarterKey = opts.quarterKey ?? quarterOf(now, tz).key;
    compareLabel = 'vs plan';
    available = opts.planSet;
    reason = opts.planSet ? null : `No plan is set for Q${quarterKey.slice(-1)} ${quarterKey.slice(0, 4)}.`;
  } else if (compareKey === 'year') {
    compareFrom = shiftYear(from, -1, tz);
    compareTo = shiftYear(to, -1, tz);
    compareLabel = `vs the same span of ${y - 1}`;
  } else if (periodKey === 'week') {
    compareTo = from;
    compareFrom = startOfWeekUTC(new Date(from.getTime() - 36 * 3600_000));
    compareLabel = `vs the week of ${fmtDay(ymdOf(compareFrom, tz))}`;
  } else {
    // The previous calendar period, the same number of days in.
    const length = to.getTime() - from.getTime();
    if (periodKey === 'month') {
      compareFrom = m === 1 ? zonedWallTimeToUtcInstant(y - 1, 12, 1, 0, tz) : zonedWallTimeToUtcInstant(y, m - 1, 1, 0, tz);
      compareLabel = `vs ${MONTHS[(m + 10) % 12]}, same days`;
    } else if (periodKey === 'quarter') {
      compareFrom = quarterOf(new Date(from.getTime() - DAY_MS), tz).start;
      compareLabel = `vs Q${quarterOf(compareFrom, tz).key.slice(-1)}, same days`;
    } else {
      compareFrom = zonedWallTimeToUtcInstant(y - 1, 1, 1, 0, tz);
      compareLabel = `vs ${y - 1}, same days`;
    }
    compareTo = new Date(Math.min(compareFrom.getTime() + length, from.getTime()));
  }

  const comparison: ExecComparison = {
    key: compareKey,
    label: compareLabel,
    start: compareFrom ? ymdOf(compareFrom, tz) : null,
    end: compareTo ? lastDayOf(compareTo, tz) : null,
    available,
    reason,
  };
  return { period, comparison, from, to, compareFrom, compareTo, timezone: tz };
}

/**
 * Judge a value: against the target when there is one (within 5% short is
 * "watch"), else against fixed thresholds the caller passes (good at or
 * better than `good`, watch to `watch`), else nothing.
 */
export function judge(
  value: number | null,
  betterWhen: 'up' | 'down',
  opts: { target?: number | null; good?: number; watch?: number },
): { status: 'good' | 'watch' | 'bad' | 'none'; label: string } {
  if (value === null) return { status: 'none', label: 'No data yet' };
  const better = (a: number, b: number) => (betterWhen === 'up' ? a >= b : a <= b);
  if (opts.target !== null && opts.target !== undefined) {
    const t = opts.target;
    if (better(value, t)) return { status: 'good', label: 'On plan' };
    const slack = Math.abs(t) * 0.05;
    const near = betterWhen === 'up' ? value >= t - slack : value <= t + slack;
    return near ? { status: 'watch', label: 'Just short of plan' } : { status: 'bad', label: 'Off plan' };
  }
  if (opts.good !== undefined && opts.watch !== undefined) {
    if (better(value, opts.good)) return { status: 'good', label: 'Healthy' };
    if (better(value, opts.watch)) return { status: 'watch', label: 'Watch' };
    return { status: 'bad', label: 'Needs attention' };
  }
  return { status: 'none', label: 'No plan set' };
}

/** The last `n` complete company weeks' starts, oldest first. */
export function lastCompleteWeeks(now: Date, n: number): Date[] {
  const starts: Date[] = [];
  let cursor = startOfWeekUTC(now);
  for (let i = 0; i < n; i++) {
    cursor = startOfWeekUTC(new Date(cursor.getTime() - 36 * 3600_000));
    starts.unshift(cursor);
  }
  return starts;
}
