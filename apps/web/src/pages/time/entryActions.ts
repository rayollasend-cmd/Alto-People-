import type { TimeEntry } from '@alto-people/shared';

/**
 * What a reviewer can do with a punch waiting for review — ONE set, read by
 * every review surface (the Time & attendance queue and the Approvals hub's
 * timesheets panel), so the same flagged entry never offers "Approve at
 * sched. end" on one page and "Fix time" on the other (deep audit FLOOR-22).
 *
 *   fix                  open the entry editor (a flagged punch wants the
 *                        right time, not a yes or no)
 *   approveAtShiftEnd    a forgotten clock-out: approve with the clock-out
 *                        set to the scheduled end, in one call — offered
 *                        only when that changes something
 *   approve / reject     the decision
 *
 * The caller's own entry gets no decision: someone else approves it.
 */
export type EntryAction = 'fix' | 'approveAtShiftEnd' | 'approve' | 'reject';

type ReviewEntry = Pick<TimeEntry, 'status' | 'anomalies' | 'clockOutAt'> & {
  shiftEndsAt?: string | null;
};

/** Within a minute counts as the same instant (punches are stored to the second). */
const SAME_MINUTE_MS = 60_000;

/**
 * "Approve at shift end" is the forgotten clock-out's one-tap correction. It
 * is offered only when the clock-out is not already the shift end — the
 * auto clock-out sweep closes a forgotten punch AT the scheduled end, and
 * then the shortcut would do exactly what Approve does.
 */
export function approveAtShiftEndUseful(e: ReviewEntry): boolean {
  if (e.status !== 'COMPLETED' && e.status !== 'REJECTED') return false;
  if (!e.shiftEndsAt) return false;
  if (!(e.anomalies ?? []).includes('FORGOT_CLOCKOUT')) return false;
  if (!e.clockOutAt) return true;
  return Math.abs(Date.parse(e.clockOutAt) - Date.parse(e.shiftEndsAt)) >= SAME_MINUTE_MS;
}

/**
 * The actions, in the order they're drawn, for an entry the viewer reviews.
 * Their own entry gets none — the surface says "someone else approves it".
 */
export function reviewActions(e: ReviewEntry, opts: { own: boolean }): EntryAction[] {
  if (opts.own) return [];
  const out: EntryAction[] = ['fix'];
  if (approveAtShiftEndUseful(e)) out.push('approveAtShiftEnd');
  if (e.status === 'COMPLETED' || e.status === 'REJECTED') out.push('approve');
  if (e.status === 'COMPLETED' || e.status === 'APPROVED') out.push('reject');
  return out;
}

/** A punch the reviewer should look at before deciding: it carries a flag. */
export function isFlagged(e: Pick<TimeEntry, 'anomalies'>): boolean {
  return (e.anomalies?.length ?? 0) > 0;
}
