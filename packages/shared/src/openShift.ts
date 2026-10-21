/**
 * One definition of an "open shift", for every count that says so.
 *
 * Open means published and unfilled (status OPEN) AND not over yet. A shift
 * that ended unfilled is history — it went unfilled — and counting it as
 * open put "1 open shift" on the schedule while the supervisor's home, which
 * looked forward, said every shift was covered. Drafts are a manager's
 * scratch pad, never open; cancelled shifts are gone.
 */
export interface OpenShiftLike {
  status: string;
  endsAt: string | Date;
}

export function isOpenShift(shift: OpenShiftLike, now: Date = new Date()): boolean {
  if (shift.status !== 'OPEN') return false;
  const end = typeof shift.endsAt === 'string' ? Date.parse(shift.endsAt) : shift.endsAt.getTime();
  return Number.isFinite(end) && end > now.getTime();
}

/** Ended while still OPEN: the shift went unfilled. */
export function wentUnfilled(shift: OpenShiftLike, now: Date = new Date()): boolean {
  if (shift.status !== 'OPEN') return false;
  const end = typeof shift.endsAt === 'string' ? Date.parse(shift.endsAt) : shift.endsAt.getTime();
  return Number.isFinite(end) && end <= now.getTime();
}
