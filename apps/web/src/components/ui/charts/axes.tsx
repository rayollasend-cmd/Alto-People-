import { displayLocale, displayTimeZone, zonedDayKey } from '@/lib/format';
import { PALETTE, TICK } from './palette';

/** Shared axis props so every kit chart's axes read the same. */

export function yAxisLabel(label: string | undefined) {
  return label ? { value: label, angle: -90, position: 'insideLeft' as const, offset: 12, style: { fill: TICK.fill, fontSize: 11, textAnchor: 'middle' as const } } : undefined;
}

export function xAxisLabel(label: string | undefined) {
  return label ? { value: label, position: 'insideBottom' as const, offset: -2, style: { fill: TICK.fill, fontSize: 11 } } : undefined;
}

export const AXIS = {
  tick: TICK,
  tickLine: false,
  axisLine: { stroke: PALETTE.grid },
} as const;

/**
 * The value axis sizes itself to its widest tick. Charts used to pin a
 * 34–36px axis and pull the plot left with a negative margin, which cut
 * every label wider than two characters: "100%" read "%", "24h" read "4h".
 * Pair with a left margin of 0.
 */
export const Y_AXIS_WIDTH = 'auto' as const;

/* ------------------------------------------------------------ date ticks */

/** How wide one point on a date axis is. */
export type DateGrain = 'day' | 'week' | 'month' | 'quarter' | 'year';

/**
 * A date axis value as a calendar day (local midnight), or null when it
 * isn't a date. Takes "YYYY-MM-DD", "YYYY-MM", "YYYY-Qn", a midnight-UTC
 * date-only instant, any other ISO instant (its day on the display zone),
 * a Date, or epoch milliseconds.
 */
export function parseAxisDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    // Epoch ms only — a bare year or an hour index is not a date.
    if (value < 100_000_000_000) return null;
    return parseAxisDate(new Date(value).toISOString());
  }
  if (typeof value !== 'string') return null;
  const v = value.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:$|T00:00:00(?:\.000)?Z$)/.exec(v);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = /^(\d{4})-(\d{2})$/.exec(v);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, 1);
  m = /^(\d{4})-?Q([1-4])$/i.exec(v);
  if (m) return new Date(Number(m[1]), (Number(m[2]) - 1) * 3, 1);
  if (/^\d{4}-\d{2}-\d{2}T/.test(v)) {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return null;
    const [y, mo, day] = zonedDayKey(d, displayTimeZone()).split('-').map(Number);
    return new Date(y!, mo! - 1, day!);
  }
  return null;
}

/**
 * One label for one date tick — the app's short date, never ISO:
 *   day / week → "Oct 3"      (week = the week's first day)
 *   month      → "Oct"        ("Oct ’25" with `year`)
 *   quarter    → "Q3 2026"
 *   year       → "2026"
 * A value that isn't a date passes through as text (an already-built label).
 */
export function fmtDateTick(value: unknown, grain: DateGrain = 'day', opts: { year?: boolean } = {}): string {
  const d = parseAxisDate(value);
  if (!d) return value === null || value === undefined ? '' : String(value);
  const loc = displayLocale();
  switch (grain) {
    case 'year':
      return String(d.getFullYear());
    case 'quarter':
      return `Q${Math.floor(d.getMonth() / 3) + 1} ${d.getFullYear()}`;
    case 'month': {
      const mon = d.toLocaleDateString(loc, { month: 'short' });
      return opts.year ? `${mon} ’${String(d.getFullYear()).slice(2)}` : mon;
    }
    default: {
      const day = d.toLocaleDateString(loc, { month: 'short', day: 'numeric' });
      return opts.year ? `${day}, ${d.getFullYear()}` : day;
    }
  }
}

/**
 * A recharts `tickFormatter` for a date axis — the one date-tick formatter
 * (axes read "09/23", "09-18", "8/31" and "Sep 26" on four pages). Pass the
 * axis values so a month axis that crosses a year can name it: the first
 * tick and every January carry the year ("Nov ’25 Dec Jan ’26 Feb …").
 */
export function dateTicks(grain: DateGrain = 'day', values?: ReadonlyArray<unknown>): (value: unknown) => string {
  const years = new Set((values ?? []).map((v) => parseAxisDate(v)?.getFullYear()).filter((y): y is number => y !== undefined));
  const crosses = years.size > 1;
  const first = values && values.length > 0 ? parseAxisDate(values[0]) : null;
  return (value) => {
    if (grain !== 'month' || !crosses) return fmtDateTick(value, grain);
    const d = parseAxisDate(value);
    const isFirst = d && first && d.getTime() === first.getTime();
    return fmtDateTick(value, grain, { year: Boolean(d && (isFirst || d.getMonth() === 0)) });
  };
}

/** The tooltip heading for a date point: "Oct 3, 2026", "Week of Oct 3, 2026", "Oct 2025", "Q3 2026". */
export function dateHeading(value: unknown, grain: DateGrain = 'day'): string {
  const d = parseAxisDate(value);
  if (!d) return value === null || value === undefined ? '' : String(value);
  if (grain === 'month') return d.toLocaleDateString(displayLocale(), { month: 'short', year: 'numeric' });
  if (grain === 'quarter' || grain === 'year') return fmtDateTick(d, grain);
  const day = fmtDateTick(d, 'day', { year: true });
  if (grain !== 'week') return day;
  return displayLocale() === 'es-US' ? `Semana del ${day}` : `Week of ${day}`;
}
