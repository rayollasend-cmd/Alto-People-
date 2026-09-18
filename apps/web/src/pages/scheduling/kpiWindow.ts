import { startOfWeekMonday } from './WeekCalendarView';

/**
 * What the Scheduling page's KPI strip counts, and what it's called.
 *
 * The week grid's columns are STORE days, so on the week view the strip
 * asks for exactly the days on screen, cut on the store's calendar
 * server-side (a 10 PM Pacific Friday shift sits in Friday's column, and
 * in that week's count, for a viewer in any zone). Off the week grid it's
 * the store workweek (Sat→Fri) — the week the client portal and My floor
 * read. The label says which: "this week" for the current workweek, else
 * the days on screen.
 */

/** Local YYYY-MM-DD (the date the picker shows, not UTC's). */
function ymd(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "Sep 19 – 25", "Sep 27 – Oct 3", "Sep 19". */
export function fmtDayRange(start: Date, endInclusive: Date): string {
  const md = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
  if (ymd(start) === ymd(endInclusive)) return md.format(start);
  const sameMonth =
    start.getMonth() === endInclusive.getMonth() && start.getFullYear() === endInclusive.getFullYear();
  return `${md.format(start)} – ${sameMonth ? endInclusive.getDate() : md.format(endInclusive)}`;
}

export function kpiWindow(opts: {
  view: string;
  /** First day on the week grid (local midnight). */
  weekStart: Date;
  /** Days the grid spans. */
  weekDayCount: number;
  now?: Date;
}): { query: { week: 'this' } | { fromDay: string; toDay: string }; period: string } {
  if (opts.view !== 'week') return { query: { week: 'this' }, period: 'this week' };
  const last = new Date(opts.weekStart);
  last.setDate(last.getDate() + opts.weekDayCount - 1);
  const current =
    opts.weekDayCount === 7 && ymd(opts.weekStart) === ymd(startOfWeekMonday(opts.now ?? new Date()));
  return {
    query: { fromDay: ymd(opts.weekStart), toDay: ymd(last) },
    period: current ? 'this week' : fmtDayRange(opts.weekStart, last),
  };
}
