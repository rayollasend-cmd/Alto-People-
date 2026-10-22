import type { Shift } from '@alto-people/shared';
import { zonedDayKey, zonedMinutesOfDay, zonedWallTimeToUtc } from '@/lib/format';
import { paidShiftMinutes } from './calendarDates';

/**
 * Pure helpers behind the week grids' drag feedback and coverage strip
 * (role walk, ops 8 and 12). No React, no clock: the views hand in the
 * shifts and fit data they already hold, and tests hand in fixtures.
 */

export const WEEK_OT_MINUTES = 40 * 60;

export interface AvailabilityFitEntry {
  /** Day-of-week numbers (0=Sun) with ANY weekly availability window. */
  dows: Set<number>;
  /** Local "YYYY-MM-DD" day keys vetoed by approved PTO / exceptions. */
  blocked: Set<string>;
}

export type DropFit = 'blocked' | 'outside' | 'ot' | null;

/**
 * What dropping `shift` on an associate's day cell would do to them:
 * red for an approved time-off day, amber for a day outside their weekly
 * availability, amber "+OT" when the shift's paid minutes would carry the
 * week past 40h. An unassigned-row target never has a fit.
 *
 * Minutes already scheduled for the person this week are passed in; when
 * the shift is already theirs (a same-row move) its own minutes are not
 * counted twice.
 */
export function dropFitFor(
  cell: { associateId: string | null; dayKey: string; dow: number },
  shift: Shift,
  fit: AvailabilityFitEntry | undefined,
  weeklyMinutes: number,
): DropFit {
  if (!cell.associateId) return null;
  if (fit?.blocked.has(cell.dayKey)) return 'blocked';
  if (fit && fit.dows.size > 0 && !fit.dows.has(cell.dow)) return 'outside';
  const own = shift.assignedAssociateId === cell.associateId ? paidShiftMinutes(shift) : 0;
  const after = weeklyMinutes - own + paidShiftMinutes(shift);
  return after > WEEK_OT_MINUTES ? 'ot' : null;
}

/** Whether a drag's activator event (or a tracked key) asked for a copy. */
export function isCopyDrag(activatorEvent: Event | null | undefined, altHeld: boolean): boolean {
  if (altHeld) return true;
  const e = activatorEvent as { altKey?: boolean } | null | undefined;
  return !!e?.altKey;
}

/**
 * The same wall-clock shift on another day: a 9a–5p chip copied to Thursday
 * is 9a–5p on Thursday in the store's zone, DST or not.
 */
export function shiftTimesOnDay(
  shift: Shift,
  dayKey: string,
  displayTimeZone: string | null,
): { startsAt: string; endsAt: string } {
  const start = new Date(shift.startsAt);
  const durationMs = new Date(shift.endsAt).getTime() - start.getTime();
  const minutes = zonedMinutesOfDay(start, displayTimeZone);
  const [yy, mm, dd] = dayKey.split('-').map(Number);
  const target = zonedWallTimeToUtc(yy, mm, dd, Math.floor(minutes / 60), minutes % 60, displayTimeZone);
  return { startsAt: target.toISOString(), endsAt: new Date(target.getTime() + durationMs).toISOString() };
}

export interface HourlyCoverage {
  /** 24 entries: non-cancelled shifts on the floor at the top of each hour. */
  scheduled: number[];
  /** 24 entries: of those, the ones nobody holds yet. */
  open: number[];
}

/**
 * Headcount at the top of every hour, per visible day, in the grid's zone.
 * A shift that runs past midnight counts toward the next day's early hours
 * too, so a 10p–6a closer shows up where it works.
 */
export function hourlyCoverage(
  shifts: readonly Shift[],
  dayKeys: readonly string[],
  displayTimeZone: string | null,
): Map<string, HourlyCoverage> {
  const out = new Map<string, HourlyCoverage>();
  for (const k of dayKeys) out.set(k, { scheduled: Array(24).fill(0), open: Array(24).fill(0) });
  const index = new Map(dayKeys.map((k, i) => [k, i] as const));
  for (const s of shifts) {
    if (s.status === 'CANCELLED') continue;
    const key = zonedDayKey(s.startsAt, displayTimeZone);
    const startMin = zonedMinutesOfDay(s.startsAt, displayTimeZone);
    const duration = Math.max(0, Math.round((new Date(s.endsAt).getTime() - new Date(s.startsAt).getTime()) / 60_000));
    const endMin = startMin + duration;
    const open = !s.assignedAssociateId;
    const mark = (dayKey: string, from: number, to: number) => {
      const row = out.get(dayKey);
      if (!row) return;
      for (let h = Math.floor(from / 60); h < Math.min(24, Math.ceil(to / 60)); h++) {
        row.scheduled[h] += 1;
        if (open) row.open[h] += 1;
      }
    };
    mark(key, startMin, Math.min(endMin, 1440));
    if (endMin > 1440) {
      const i = index.get(key);
      const next = i !== undefined ? dayKeys[i + 1] : undefined;
      if (next) mark(next, 0, endMin - 1440);
    }
  }
  return out;
}

/** The day column is history once its last minute passed in the grid's zone. */
export function dayIsPast(dayKey: string, displayTimeZone: string | null, now: Date = new Date()): boolean {
  return zonedDayKey(now, displayTimeZone) > dayKey;
}
