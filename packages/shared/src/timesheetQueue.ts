/**
 * The timesheet approval queue's link — one builder for every count that
 * says "N timesheets to approve" (the Inbox, the Approvals tile, ⌘K, the
 * sidebar badge). The count and the queue read the same predicate: finished
 * punches (COMPLETED) in a date window. The link carries that window, so
 * the queue opens on the rows the count counted — three roles used to land
 * on "Nothing to review" under a tile that said 6, because the count had no
 * window and the queue opened on the current pay period while the pending
 * rows sat in an older, already-paid one.
 */

/** How far back a pending count looks. */
export const TIMESHEET_QUEUE_WINDOW_DAYS = 90;

export interface TimesheetQueueLink {
  /** Local day key, YYYY-MM-DD, of the oldest pending entry (or the window start). */
  from: string;
  /** Local day key, YYYY-MM-DD, of the window end (today). */
  to: string;
}

/** `/time-attendance?tab=queue&status=COMPLETED&from=…&to=…` */
export function timesheetQueuePath(link: TimesheetQueueLink): string {
  const q = new URLSearchParams({ tab: 'queue', status: 'COMPLETED', from: link.from, to: link.to });
  return `/time-attendance?${q.toString()}`;
}

export interface PendingPeriodCount {
  /** Pay period bounds as local day keys. */
  start: string;
  end: string;
  count: number;
}

/**
 * The period the queue should open on: the oldest one with pending rows.
 * Unapproved time in a paid period is the most urgent — it is owed. Null
 * when nothing is pending.
 */
export function oldestPendingPeriod<T extends PendingPeriodCount>(byPeriod: readonly T[]): T | null {
  const pending = byPeriod.filter((p) => p.count > 0);
  if (pending.length === 0) return null;
  return pending.reduce((a, b) => (b.start < a.start ? b : a));
}
