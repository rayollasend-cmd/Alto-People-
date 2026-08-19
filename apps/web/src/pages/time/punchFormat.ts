import {
  browserTimeZone,
  fmtDateTz,
  fmtDateTime,
  fmtTime,
  fmtTimeTz,
  tzAbbrev,
  zonedDayKey,
} from '@/lib/format';

/**
 * Punch time on the SITE's wall clock, not the reviewer's browser clock.
 *
 * The queue used to render fmtTime/fmtDateTime (browser-local, unlabelled)
 * while the Fieldglass timesheet rendered a hardcoded America/New_York —
 * the same punch showed two different times on the two screens, which users
 * reported as "the clock-in times don't match". Entries now carry their
 * Location.timezone; when it differs from the viewer's zone the time gets
 * an abbreviation (9:00 AM CDT) so the number explains itself. Entries with
 * no location (legacy rows) fall back to browser-local, exactly as before.
 */
export function fmtPunchTime(iso: string, tz: string | null | undefined): string {
  if (!tz) return fmtTime(iso);
  const base = fmtTimeTz(iso, tz);
  return tz !== browserTimeZone() ? `${base} ${tzAbbrev(tz, iso)}` : base;
}

export function fmtPunchDateTime(iso: string, tz: string | null | undefined): string {
  if (!tz) return fmtDateTime(iso);
  return `${fmtDateTz(iso, tz)}, ${fmtPunchTime(iso, tz)}`;
}

/**
 * Worked-time duration as DECIMAL hours — "7.50h", the payroll and
 * Fieldglass convention. This used to render "7h 30m" while the
 * Fieldglass sheet and payroll exports showed 7.50, and users read the
 * two as different numbers. One convention now: every computed duration
 * on a time surface is decimal hours to two places.
 */
export function formatHM(mins: number): string {
  return `${(mins / 60).toFixed(2)}h`;
}

/**
 * Whole calendar days between two instants AS SEEN at the site (browser
 * zone when the entry has no location). Powers the "+1" marker on
 * overnight clock-outs — a 4:00 PM → 12:30 AM shift used to render its
 * "Out" cell as a bare "12:30 AM", which reads as the same day.
 */
export function punchDayOffset(
  fromIso: string,
  toIso: string,
  tz: string | null | undefined,
): number {
  const a = zonedDayKey(fromIso, tz ?? undefined);
  const b = zonedDayKey(toIso, tz ?? undefined);
  if (a === b) return 0;
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}
