import type { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { TIMESHEET_QUEUE_WINDOW_DAYS } from '@alto-people/shared';
import { scopeTimeEntries } from './scope.js';

/**
 * One predicate for "timesheets waiting for approval" — the sidebar badge,
 * the Inbox count, the Pending-review tile and the approval queue's own
 * list all read it. Three roles used to land on "Nothing to review" under
 * a tile that said 6: the count had no date window (all time) while the
 * queue opened on the current pay period, and the six pending rows sat in
 * an older, already-paid one. Now the count has a window, the link carries
 * it, and the queue lists exactly what was counted.
 *
 *   pending = finished punches (COMPLETED) the caller can see, clocked in
 *             inside the window. A window of the last 90 days, by default:
 *             COMPLETED is a state an entry can sit in forever, and older
 *             rows are history, not a queue.
 */

type SessionUser = NonNullable<Request['user']>;

export interface PendingTimeWindow {
  /** Inclusive lower bound on clockInAt. */
  from: Date;
  /** Exclusive upper bound on clockInAt. */
  to: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The last TIMESHEET_QUEUE_WINDOW_DAYS days, ending now (exclusive). */
export function pendingTimeWindow(now: Date = new Date()): PendingTimeWindow {
  return { from: new Date(now.getTime() - TIMESHEET_QUEUE_WINDOW_DAYS * DAY_MS), to: now };
}

/** COMPLETED entries in the caller's reach whose clock-in falls in the window. */
export function pendingTimeWhere(user: SessionUser, window: PendingTimeWindow = pendingTimeWindow()): Prisma.TimeEntryWhereInput {
  return {
    status: 'COMPLETED',
    clockInAt: { gte: window.from, lt: window.to },
    ...scopeTimeEntries(user),
  };
}
