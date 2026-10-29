import { wentUnfilled, type Shift } from '@alto-people/shared';
import { zonedDayKey } from '@/lib/format';
import { shiftDays } from '@/pages/portal/scope';
import { shiftTimesOnDay } from './weekGridFit';

/**
 * A shift that is over is history (FLOOR-18, deep audit 2026-10-29): the
 * action sheet offered Edit, Reassign, Unassign, Move to draft, Cancel
 * shift and Delete on a shift that ended yesterday, and never said when it
 * ended, where, or whether anyone worked it. One rule for the phone sheet,
 * the right-click menu and the hover card, so the three never disagree.
 */

export function shiftEnded(s: Pick<Shift, 'endsAt'>, now: Date = new Date()): boolean {
  const end = Date.parse(s.endsAt);
  return Number.isFinite(end) && end <= now.getTime();
}

export interface ShiftActionSet {
  edit: boolean;
  assign: boolean;
  unassign: boolean;
  publish: boolean;
  unpublish: boolean;
  duplicate: boolean;
  /** The same shift one week later — the one copy that makes sense of a shift that is over. */
  copyNextWeek: boolean;
  cancel: boolean;
  delete: boolean;
  /** Close out a shift that ended unfilled (it goes in the record as unfilled). */
  closeOut: boolean;
  /** Nothing in the set changes the shift — the surfaces read "Ended". */
  readOnly: boolean;
}

/** What a manager may do to a shift from its sheet, menu or hover card. */
export function shiftActions(
  s: Pick<Shift, 'status' | 'endsAt' | 'assignedAssociateId'>,
  canManage: boolean,
  now: Date = new Date(),
): ShiftActionSet {
  const none: ShiftActionSet = {
    edit: false,
    assign: false,
    unassign: false,
    publish: false,
    unpublish: false,
    duplicate: false,
    copyNextWeek: false,
    cancel: false,
    delete: false,
    closeOut: false,
    readOnly: true,
  };
  if (!canManage) return none;
  // Over and never filled: it closes out; next week's copy is fine.
  if (wentUnfilled(s, now)) return { ...none, closeOut: true, copyNextWeek: true };
  // Over: worked or not, the record stands. A copy one week on is the only
  // thing that doesn't rewrite what happened (a same-time duplicate would
  // be a new shift in the past).
  if (shiftEnded(s, now)) return { ...none, copyNextWeek: s.status !== 'CANCELLED' };
  const terminal = s.status === 'COMPLETED' || s.status === 'CANCELLED';
  return {
    edit: !terminal,
    assign: !terminal,
    unassign: !terminal && !!s.assignedAssociateId,
    publish: s.status === 'DRAFT',
    unpublish: s.status === 'OPEN' || s.status === 'ASSIGNED',
    duplicate: !terminal,
    copyNextWeek: !terminal,
    cancel: !terminal,
    delete: true,
    closeOut: false,
    readOnly: false,
  };
}

/** A punch as the ended-shift sheet needs it. */
export interface PunchLite {
  shiftId?: string | null;
  clockInAt: string;
  clockOutAt: string | null;
}

export type ShiftOutcome =
  | { kind: 'worked'; clockInAt: string; clockOutAt: string | null }
  | { kind: 'no-punch' }
  | { kind: 'unfilled' }
  | { kind: 'cancelled' };

/**
 * Whether an ended shift was worked: the holder's punch tied to the shift,
 * else one that overlaps its hours. No holder → unfilled; cancelled → so.
 */
export function shiftOutcome(
  s: Pick<Shift, 'id' | 'status' | 'startsAt' | 'endsAt' | 'assignedAssociateId'>,
  punches: readonly PunchLite[],
): ShiftOutcome {
  if (s.status === 'CANCELLED') return { kind: 'cancelled' };
  if (!s.assignedAssociateId) return { kind: 'unfilled' };
  const start = Date.parse(s.startsAt);
  const end = Date.parse(s.endsAt);
  const tied = punches.find((p) => p.shiftId === s.id);
  const overlapping =
    tied ??
    punches.find((p) => {
      const pin = Date.parse(p.clockInAt);
      const pout = p.clockOutAt ? Date.parse(p.clockOutAt) : pin;
      return pin < end && pout > start - 60 * 60_000;
    });
  return overlapping
    ? { kind: 'worked', clockInAt: overlapping.clockInAt, clockOutAt: overlapping.clockOutAt }
    : { kind: 'no-punch' };
}

/** The same shift seven days on, at its own store's wall clock (DST-safe). */
export function oneWeekLater(s: Shift): { startsAt: string; endsAt: string } {
  return shiftTimesOnDay(s, shiftDays(zonedDayKey(s.startsAt, s.timezone), 7), s.timezone);
}
