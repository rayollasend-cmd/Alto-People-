import type { ShiftStatus } from '@alto-people/shared';
import { workweekStart } from '@/lib/workweek';

/**
 * The schedule list's status chips and the window each one opens on
 * (F500 G2, 2026-10-22). The list is the daily planning surface, so it
 * opens on what is ahead: today and the next two weeks, soonest first.
 * "Open" means one thing everywhere — still fillable (isOpenShift), the
 * same shifts the KPI line counts — and the shifts that ended while still
 * open are their own chip, "Went unfilled", looking back.
 */

export type ListStatus = ShiftStatus | 'ALL' | 'UNFILLED';

export const LIST_STATUSES: readonly ListStatus[] = ['OPEN', 'UNFILLED', 'ASSIGNED', 'DRAFT', 'COMPLETED', 'CANCELLED', 'ALL'];

/** Chips that look back: their window ends today and the newest row comes first. */
export const HISTORY_STATUSES: ReadonlySet<ListStatus> = new Set<ListStatus>(['UNFILLED', 'COMPLETED']);

/** Local YYYY-MM-DD. */
export function ymdLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function plusDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() + n);
  return x;
}

/** Days the default forward window spans, today included. */
export const LIST_DAYS_AHEAD = 14;

/**
 * The window a chip opens on when no range is in the URL: the next two
 * weeks for the planning chips; the last 30 days for the history chips;
 * both sides for Cancelled (a cancellation can be ahead or behind).
 */
export function listRangeDefault(status: ListStatus, now: Date = new Date()): { from: string; to: string } {
  const today = plusDays(now, 0);
  const ahead = ymdLocal(plusDays(today, LIST_DAYS_AHEAD - 1));
  const back = ymdLocal(plusDays(today, -30));
  if (HISTORY_STATUSES.has(status)) return { from: back, to: ymdLocal(today) };
  if (status === 'CANCELLED') return { from: back, to: ahead };
  return { from: ymdLocal(today), to: ahead };
}

/** What the list asks the API for, per chip. */
export function listStatusQuery(status: ListStatus): { status?: ShiftStatus; ended?: boolean } {
  if (status === 'ALL') return {};
  if (status === 'OPEN') return { status: 'OPEN', ended: false };
  if (status === 'UNFILLED') return { status: 'OPEN', ended: true };
  return { status };
}

/**
 * The chip a returning manager lands on: their last forward-looking pick
 * (Open, Assigned, Draft, All); a history chip left open last time is not
 * where the planning page should reopen, so it reads as Open.
 */
export function restoredListStatus(stored: string | null | undefined): ListStatus {
  return stored === 'ASSIGNED' || stored === 'DRAFT' || stored === 'ALL' ? stored : 'OPEN';
}

/** The workweek so far — what "N unfilled" on the KPI line counts (this week, up to today). */
export function unfilledThisWeekRange(now: Date = new Date()): { from: string; to: string } {
  return { from: ymdLocal(workweekStart(now)), to: ymdLocal(now) };
}
