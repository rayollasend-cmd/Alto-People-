import { displayLocale } from '@/lib/format';

/** "Oct 10" for a workweek's first day (YYYY-MM-DD) — the calendar day it names, no zone shift. */
export function weekLabel(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return ymd;
  return d.toLocaleDateString(displayLocale(), { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** "Week of Oct 10" — the tooltip heading. */
export const weekOf = (ymd: string) => `Week of ${weekLabel(ymd)}`;
