import { useMemo, type ReactNode } from 'react';
import type { TimeEntry } from '@alto-people/shared';
import { fmtDateTz, fmtWeekdayTz, zonedDayKey } from '@/lib/format';
import { cn } from '@/lib/cn';
import { formatHM } from './punchFormat';

/**
 * Shared week/day timesheet shell — the presentation both the admin's
 * individual-timesheet focus mode and the associate's own history use, so
 * one person's hours read identically on both sides of the approval.
 *
 * A flat entry list makes two clock-ins on the same day look like a data
 * error and hides weekly overtime. This groups entries by site-local day
 * inside Sunday-based weeks with day/week subtotals, tags multi-shift days
 * ("2 shifts"), spells out the gap between same-day entries ("back in 42m
 * later"), and flags a second entry that starts before the previous one
 * ended as an overlap — the actual double-punch error.
 *
 * Row content stays view-specific (admin rows carry Approve/Reject, the
 * associate's expand into their shift timeline) via `renderEntry`.
 */

export interface TimesheetDayGroup {
  key: string;
  entries: TimeEntry[];
  netMin: number;
  breakMin: number;
}

interface TimesheetWeek {
  startMs: number;
  days: TimesheetDayGroup[];
  netMin: number;
}

/** "Mon, Jul 28" from a YYYY-MM-DD day key (parsed as local wall date). */
function dayKeyLabel(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return `${fmtWeekdayTz(date)}, ${fmtDateTz(date)}`;
}

/** Sunday-based week start (ms) for a YYYY-MM-DD day key. */
function weekStartOfDayKey(key: string): number {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() - date.getDay());
  return date.getTime();
}

export function TimesheetWeeks({
  entries,
  renderEntry,
  dayHeaderExtra,
}: {
  entries: TimeEntry[];
  /** The row for one entry — actions/expansion are the caller's business. */
  renderEntry: (entry: TimeEntry) => ReactNode;
  /** Optional leading day-header control (e.g. admin's select-day checkbox). */
  dayHeaderExtra?: (day: TimesheetDayGroup) => ReactNode;
}) {
  const weeks = useMemo<TimesheetWeek[]>(() => {
    // Chronological like a paper timesheet — newest-first is for triage,
    // not for reading one person's fortnight.
    const sorted = [...entries].sort(
      (a, b) => new Date(a.clockInAt).getTime() - new Date(b.clockInAt).getTime(),
    );
    const dayMap = new Map<string, TimesheetDayGroup>();
    for (const e of sorted) {
      const key = zonedDayKey(e.clockInAt, e.locationTimezone ?? undefined);
      let day = dayMap.get(key);
      if (!day) {
        day = { key, entries: [], netMin: 0, breakMin: 0 };
        dayMap.set(key, day);
      }
      day.entries.push(e);
      if (e.status !== 'REJECTED') {
        const net = e.netMinutes ?? e.minutesElapsed;
        day.netMin += net;
        day.breakMin += Math.max(0, e.minutesElapsed - net);
      }
    }
    const weekMap = new Map<number, TimesheetWeek>();
    for (const day of dayMap.values()) {
      const startMs = weekStartOfDayKey(day.key);
      let week = weekMap.get(startMs);
      if (!week) {
        week = { startMs, days: [], netMin: 0 };
        weekMap.set(startMs, week);
      }
      week.days.push(day);
      week.netMin += day.netMin;
    }
    return [...weekMap.values()].sort((a, b) => a.startMs - b.startMs);
  }, [entries]);

  return (
    <div className="space-y-5">
      {weeks.map((week) => {
        const otMin = Math.max(0, week.netMin - 40 * 60);
        return (
          <section key={week.startMs}>
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2 border-b border-navy-secondary pb-1.5">
              <h3 className="text-2xs uppercase tracking-widest text-silver">
                Week of {fmtDateTz(new Date(week.startMs))}
              </h3>
              <div className="flex items-center gap-2 text-xs tabular-nums">
                {otMin > 0 && (
                  <span className="rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-warning">
                    {formatHM(otMin)} OT
                  </span>
                )}
                <span className="text-silver">
                  week total{' '}
                  <span className="font-medium text-white">{formatHM(week.netMin)}</span>
                </span>
              </div>
            </div>
            <div className="space-y-3">
              {week.days.map((day) => (
                <div
                  key={day.key}
                  className="rounded-md border border-navy-secondary bg-navy/40"
                >
                  <div className="flex flex-wrap items-center gap-2 border-b border-navy-secondary px-3 py-2">
                    {dayHeaderExtra?.(day)}
                    <span className="text-sm font-medium text-white">
                      {dayKeyLabel(day.key)}
                    </span>
                    {day.entries.length > 1 && (
                      <span className="rounded-full border border-gold/40 bg-gold/10 px-2 py-0.5 text-2xs uppercase tracking-widest text-gold">
                        {day.entries.length} shifts
                      </span>
                    )}
                    <span className="ml-auto text-xs tabular-nums text-silver">
                      {day.breakMin > 0 && (
                        <span className="text-silver/70">
                          {formatHM(day.breakMin)} breaks ·{' '}
                        </span>
                      )}
                      <span className="font-medium text-white">
                        {formatHM(day.netMin)}
                      </span>
                    </span>
                  </div>
                  <ul>
                    {day.entries.map((e, i) => {
                      const prev = i > 0 ? day.entries[i - 1] : null;
                      // The between-shifts note is what makes a double
                      // clock-in readable at a glance: a second entry 40
                      // minutes after the first clock-out is a split shift;
                      // one that starts BEFORE the previous ended is
                      // double-booked minutes.
                      let gapNote: { text: string; overlap: boolean } | null = null;
                      if (prev?.clockOutAt) {
                        const gapMin = Math.round(
                          (new Date(e.clockInAt).getTime() -
                            new Date(prev.clockOutAt).getTime()) /
                            60_000,
                        );
                        gapNote =
                          gapMin >= 0
                            ? { text: `back in ${formatHM(gapMin)} later`, overlap: false }
                            : {
                                text: `overlaps previous entry by ${formatHM(Math.abs(gapMin))}`,
                                overlap: true,
                              };
                      }
                      return (
                        <li
                          key={e.id}
                          className="border-b border-navy-secondary/60 last:border-b-0"
                        >
                          {gapNote && (
                            <div
                              className={cn(
                                'flex items-center gap-2 px-3 pt-1.5 text-2xs',
                                gapNote.overlap ? 'text-alert' : 'text-silver/60',
                              )}
                            >
                              <span
                                className={cn(
                                  'h-px flex-none w-4',
                                  gapNote.overlap ? 'bg-alert/50' : 'bg-navy-secondary',
                                )}
                              />
                              {gapNote.text}
                            </div>
                          )}
                          {renderEntry(e)}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
