/**
 * The one definition of receivables aging (finance walk 3, 2026-10-21).
 *
 * Every screen that ages what clients owe — the finance home, Books, the
 * executive view, the invoice PDF — reads this file, so "oldest 43d" on one
 * card and "oldest 72d" on the next can't happen again:
 *
 *   dueOn        the statement's due date; a statement with none falls due
 *                the day it was finalized (older rows), else its period end
 *   daysPastDue  whole days from dueOn to the as-of date; negative = not yet due
 *   bucket       current (not yet due) · 1–30 · 31–60 · 61–90 · over 90, by
 *                days PAST DUE — never days since finalized
 */

import { orgDateKey } from '../timeAnomalies.js';

export const AGING_BUCKETS = ['current', 'days1to30', 'days31to60', 'days61to90', 'over90'] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];
export type AgingBuckets = Record<AgingBucket, number>;

const DAY = 86_400_000;
const ymd = (d: Date | string) => (typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10));
const midnight = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00.000Z`).getTime();

export function bucketFor(daysPastDue: number): AgingBucket {
  if (daysPastDue <= 0) return 'current';
  if (daysPastDue <= 30) return 'days1to30';
  if (daysPastDue <= 60) return 'days31to60';
  if (daysPastDue <= 90) return 'days61to90';
  return 'over90';
}

/** The day a statement falls due: dueAt, else the day it was finalized, else its period end. */
export function dueOnFor(s: { dueAt?: Date | string | null; finalizedAt?: Date | string | null; periodEnd?: Date | string | null }): string | null {
  if (s.dueAt) return ymd(s.dueAt);
  // dueAt and periodEnd are calendar dates; finalizedAt is a moment, so its
  // day is the company's calendar day it happened on.
  if (s.finalizedAt) return orgDateKey(typeof s.finalizedAt === 'string' ? new Date(s.finalizedAt) : s.finalizedAt);
  if (s.periodEnd) return ymd(s.periodEnd);
  return null;
}

/** Whole days past due as of `asOf` (a date or YYYY-MM-DD); negative while not yet due. */
export function daysPastDue(dueOn: string | null, asOf: Date | string = new Date()): number {
  if (!dueOn) return 0;
  // "Today" is the company's calendar day, not UTC's: every receivable figure
  // (finance home, Books, the client list, the executive view) ages the same,
  // including after 5 PM Pacific when UTC has already moved on.
  const today = typeof asOf === 'string' ? asOf.slice(0, 10) : orgDateKey(asOf);
  return Math.floor((midnight(today) - midnight(dueOn)) / DAY);
}

export const zeroBuckets = (): AgingBuckets => ({ current: 0, days1to30: 0, days31to60: 0, days61to90: 0, over90: 0 });

export interface AgedStatement<T> {
  row: T;
  dueOn: string | null;
  daysPastDue: number;
  bucket: AgingBucket;
}

/** Age a set of open statements: each one's days past due and bucket, plus the bucket totals. */
export function ageStatements<T extends { dueAt?: Date | string | null; finalizedAt?: Date | string | null; periodEnd?: Date | string | null; amount: number }>(
  rows: T[],
  asOf: Date | string = new Date(),
): { statements: Array<AgedStatement<T>>; buckets: AgingBuckets; total: number; oldestDaysPastDue: number | null } {
  const buckets = zeroBuckets();
  let total = 0;
  let oldest: number | null = null;
  const statements = rows.map((row) => {
    const dueOn = dueOnFor(row);
    const days = daysPastDue(dueOn, asOf);
    const bucket = bucketFor(days);
    buckets[bucket] += row.amount;
    total += row.amount;
    if (oldest === null || days > oldest) oldest = days;
    return { row, dueOn, daysPastDue: days, bucket };
  });
  return { statements, buckets, total, oldestDaysPastDue: oldest };
}
