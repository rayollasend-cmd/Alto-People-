/**
 * The labor-cost report's date range, as pure functions (tested in
 * __tests__/pages/scheduling/laborCostRange.test.ts).
 *
 * The report opens on the CURRENT PAY PERIOD TO DATE — the window payroll
 * will pay — not on "today", which before the first punch of the day is an
 * empty page. Three presets: this period (to date), last period, the last
 * 30 days. Anything else the reader types is a custom range. All days are
 * YYYY-MM-DD calendar days in the reader's zone; `to` is inclusive.
 *
 * In the URL (?from=&to=) only when off the default, so the clean URL is
 * "this period" and a shared link to last period stays last period.
 */

/** A pay period from the API: YYYY-MM-DD, `end` inclusive. */
export interface PeriodWindow {
  start: string;
  end: string;
}

export type RangePreset = 'period' | 'last' | '30d';

export interface ResolvedRange {
  from: string;
  /** Inclusive. */
  to: string;
  /** The preset these dates match, or 'custom'. */
  preset: RangePreset | 'custom';
  /** The preset the clean URL means: 'period', or '30d' when there is no pay schedule. */
  defaultPreset: RangePreset;
}

/** The API refuses longer reports. */
export const MAX_RANGE_DAYS = 92;

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export function isYmd(s: string | null | undefined): s is string {
  if (!s || !YMD.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** A calendar day `days` after `ymd` (negative = before). */
export function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + days));
  return dt.toISOString().slice(0, 10);
}

/** The reader's local calendar day. */
export function localYmd(d: Date = new Date()): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Days from `from` to `to`, both included (0 when inverted). */
export function daysInRange(from: string, to: string): number {
  if (to < from) return 0;
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/** Every calendar day from `from` to `to`, inclusive. */
export function everyDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length <= MAX_RANGE_DAYS + 1; d = addDaysYmd(d, 1)) out.push(d);
  return out;
}

/** The period `today` falls in (the API's own `current` flag is decided on its UTC date). */
export function currentPeriod(periods: readonly PeriodWindow[], today: string): PeriodWindow | null {
  return periods.find((p) => p.start <= today && today <= p.end) ?? null;
}

/** The period that ended most recently before the current one began. */
export function previousPeriod(periods: readonly PeriodWindow[], today: string): PeriodWindow | null {
  const cur = currentPeriod(periods, today);
  const before = cur ? cur.start : addDaysYmd(today, 1);
  return [...periods].filter((p) => p.end < before).sort((a, b) => (a.end < b.end ? 1 : -1))[0] ?? null;
}

/** The dates a preset means today, or null when it can't be computed (no pay schedule). */
export function presetRange(
  preset: RangePreset,
  today: string,
  periods: readonly PeriodWindow[],
): { from: string; to: string } | null {
  if (preset === '30d') return { from: addDaysYmd(today, -29), to: today };
  if (preset === 'period') {
    const cur = currentPeriod(periods, today);
    return cur ? { from: cur.start, to: today } : null;
  }
  const prev = previousPeriod(periods, today);
  return prev ? { from: prev.start, to: prev.end } : null;
}

/**
 * What the report shows, from the URL's ?from=&to= (either may be absent or
 * unreadable) and the pay periods. A clean URL is the default preset; a
 * from/to pair that matches a preset lights that preset.
 */
export function resolveRange(
  params: { from?: string | null; to?: string | null },
  today: string,
  periods: readonly PeriodWindow[],
): ResolvedRange {
  const defaultPreset: RangePreset = presetRange('period', today, periods) ? 'period' : '30d';
  const fallback = presetRange(defaultPreset, today, periods)!;
  const from = isYmd(params.from) ? params.from : null;
  const to = isYmd(params.to) ? params.to : null;
  if (!from && !to) return { ...fallback, preset: defaultPreset, defaultPreset };
  const f = from ?? to!;
  const t = to ?? from!;
  const range = f <= t ? { from: f, to: t } : { from: t, to: f };
  const match = (['period', 'last', '30d'] as const).find((p) => {
    const r = presetRange(p, today, periods);
    return r !== null && r.from === range.from && r.to === range.to;
  });
  return { ...range, preset: match ?? 'custom', defaultPreset };
}
