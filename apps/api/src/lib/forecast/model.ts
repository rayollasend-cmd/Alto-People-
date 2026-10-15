import type { ForecastDrivers, ForecastSignalKind } from '@alto-people/shared';

/**
 * Brief 3-4 — the forecast model, pure and explainable.
 *
 * Per site and org week (keys are YYYY-MM-DD week starts, any zone-free
 * calendar):
 *
 *   recent    = mean verified hours of the 8 weeks before the anchor
 *   trend     = (mean of the last 4 − mean of the 4 before) ÷ 4, per week,
 *               capped at ±20% of recent so a short spike cannot run away
 *   lastYear  = the same org week a year ago × (recent ÷ the same 8 weeks a
 *               year ago), so a site that grew is scaled up, not copied
 *   p50       = w × lastYear + (1 − w) × (recent + trend × lead) × holiday
 *               × signals, floored at zero
 *
 * w (the weight on last year) and the band's edges come from the back-test:
 * for every historical week with 16+ weeks of history, forecast it from the
 * history before it at a four-week lead, measure the percent error, pick
 * the w with the lowest mean absolute error, and take the 10th and 90th
 * percentiles of the signed errors as the band. No history older than a
 * year → w is forced to 0 and the default band (±15%) stands.
 */

export const RECENT_WEEKS = 8;
export const TREND_CAP = 0.2;
export const DEFAULT_BAND = { low: -0.15, high: 0.15 };
export const MIN_HISTORY_WEEKS = 16;
export const BACKTEST_LEAD_WEEKS = 4;
const LAST_YEAR_WEIGHTS = [0, 0.25, 0.5, 0.75, 1] as const;

export interface Weights {
  lastYearWeight: number;
  bandLow: number;
  bandHigh: number;
}
export const DEFAULT_WEIGHTS: Weights = { lastYearWeight: 0.5, bandLow: DEFAULT_BAND.low, bandHigh: DEFAULT_BAND.high };

/** Verified hours per week key, for one site. Missing weeks are missing, not zero. */
export type WeekSeries = ReadonlyMap<string, number>;

export interface SignalRow {
  weekStart: string;
  kind: ForecastSignalKind;
  factor: number;
  source: string | null;
}

export interface ForecastPoint {
  weekStart: string;
  p10: number;
  p50: number;
  p90: number;
  drivers: ForecastDrivers;
}

/* ------------------------------------------------------------ calendar */

const DAY_MS = 86_400_000;
export function addWeeks(weekKey: string, n: number): string {
  const [y, m, d] = weekKey.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + 7 * n)).toISOString().slice(0, 10);
}
export function weeksBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by!, bm! - 1, bd!) - Date.UTC(ay!, am! - 1, ad!)) / (7 * DAY_MS));
}
/** The org week a year earlier: 52 weeks back keeps the weekday; the calendar drifts a day a year, which the level ratio absorbs. */
export const lastYearWeek = (weekKey: string): string => addWeeks(weekKey, -52);

/* ------------------------------------------------------------ holidays */

/**
 * The weeks that move hospitality and retail demand on the Gulf Coast. A
 * factor applies to the week whose org week contains the day. Observed
 * dates by rule, not a table that goes stale.
 */
interface Holiday {
  name: string;
  factor: number;
  /** YYYY-MM-DD of the holiday in a given year. */
  on: (year: number) => string;
}
const nthWeekday = (year: number, month: number, weekday: number, n: number): string => {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(year, month - 1, 1 + offset + 7 * (n - 1))).toISOString().slice(0, 10);
};
const lastWeekday = (year: number, month: number, weekday: number): string => {
  const last = new Date(Date.UTC(year, month, 0));
  const back = (last.getUTCDay() - weekday + 7) % 7;
  return new Date(Date.UTC(year, month - 1, last.getUTCDate() - back)).toISOString().slice(0, 10);
};
const fixed = (month: number, day: number) => (year: number) =>
  `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

export const HOLIDAYS: readonly Holiday[] = [
  { name: "New Year's week", factor: 1.08, on: fixed(1, 1) },
  { name: 'Martin Luther King Jr. Day', factor: 1.02, on: (y) => nthWeekday(y, 1, 1, 3) },
  { name: "Presidents' Day", factor: 1.02, on: (y) => nthWeekday(y, 2, 1, 3) },
  { name: 'Spring break', factor: 1.06, on: (y) => nthWeekday(y, 3, 6, 2) },
  { name: 'Memorial Day', factor: 1.08, on: (y) => lastWeekday(y, 5, 1) },
  { name: 'Independence Day', factor: 1.08, on: fixed(7, 4) },
  { name: 'Labor Day', factor: 1.08, on: (y) => nthWeekday(y, 9, 1, 1) },
  { name: 'Thanksgiving week', factor: 1.05, on: (y) => nthWeekday(y, 11, 4, 4) },
  { name: 'Christmas week', factor: 1.1, on: fixed(12, 25) },
];

/** The holiday whose day falls inside the org week starting `weekKey`, if any. */
export function holidayFor(weekKey: string): { name: string; factor: number } | null {
  const [y] = weekKey.split('-').map(Number);
  const end = addWeeks(weekKey, 1);
  for (const year of [y! - 1, y!, y! + 1]) {
    for (const h of HOLIDAYS) {
      const day = h.on(year);
      if (day >= weekKey && day < end) return { name: h.name, factor: h.factor };
    }
  }
  return null;
}

/* ------------------------------------------------------------ the model */

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** The weeks of `series` strictly before `anchor`, newest last, limited to `n`. */
function recentValues(series: WeekSeries, anchor: string, n: number): number[] {
  const out: number[] = [];
  for (let i = 1; i <= n; i++) {
    const v = series.get(addWeeks(anchor, -i));
    if (v !== undefined) out.unshift(v);
  }
  return out;
}

export interface ForecastOpts {
  /** The first week to forecast; history is read strictly before it. */
  anchor: string;
  horizonWeeks: number;
  weights: Weights;
  signals?: readonly SignalRow[];
}

/** Forecast `horizonWeeks` weeks from `anchor` for one site. */
export function forecastSite(series: WeekSeries, opts: ForecastOpts): ForecastPoint[] {
  const { anchor, horizonWeeks, weights } = opts;
  const recent = recentValues(series, anchor, RECENT_WEEKS);
  const recentMean = mean(recent);
  const lastFour = recent.slice(-4);
  const priorFour = recent.slice(-8, -4);
  let trend = priorFour.length === 4 && lastFour.length === 4 ? (mean(lastFour) - mean(priorFour)) / 4 : 0;
  const cap = TREND_CAP * recentMean;
  trend = Math.max(-cap, Math.min(cap, trend));

  // The same 8 weeks a year ago, for the level ratio.
  const lastYearRecent: number[] = [];
  for (let i = 1; i <= RECENT_WEEKS; i++) {
    const v = series.get(lastYearWeek(addWeeks(anchor, -i)));
    if (v !== undefined) lastYearRecent.push(v);
  }
  const levelRatio = lastYearRecent.length >= 4 && mean(lastYearRecent) > 0 ? recentMean / mean(lastYearRecent) : null;

  const signalsByWeek = new Map<string, SignalRow[]>();
  for (const s of opts.signals ?? []) {
    const list = signalsByWeek.get(s.weekStart) ?? [];
    list.push(s);
    signalsByWeek.set(s.weekStart, list);
  }

  const out: ForecastPoint[] = [];
  for (let lead = 1; lead <= horizonWeeks; lead++) {
    const weekStart = addWeeks(anchor, lead - 1);
    const ly = series.get(lastYearWeek(weekStart));
    const lastYearScaled = ly !== undefined && levelRatio !== null ? ly * levelRatio : null;
    const holiday = holidayFor(weekStart);
    const holidayFactor = holiday?.factor ?? 1;
    const weekSignals = signalsByWeek.get(weekStart) ?? [];
    const signalFactor = weekSignals.reduce((f, s) => f * s.factor, 1);
    const w = lastYearScaled === null ? 0 : weights.lastYearWeight;
    // Last year already lived through its holiday; the holiday factor lifts only the recent component.
    const recentPart = (recentMean + trend * lead) * holidayFactor;
    const base = w * (lastYearScaled ?? 0) + (1 - w) * recentPart;
    const p50 = Math.max(0, base * signalFactor);
    out.push({
      weekStart,
      p50: round(p50),
      p10: round(Math.max(0, p50 * (1 + weights.bandLow))),
      p90: round(p50 * (1 + weights.bandHigh)),
      drivers: {
        lastYearScaled: lastYearScaled === null ? null : round(lastYearScaled),
        recentMean: round(recentMean),
        trendPerWeek: round(trend),
        holidayFactor,
        holidayName: holiday?.name ?? null,
        signalFactor: round(signalFactor, 3),
        signals: weekSignals.map((s) => ({ kind: s.kind, factor: s.factor, source: s.source })),
        lastYearWeight: w,
        leadWeeks: lead,
      },
    });
  }
  return out;
}

const round = (n: number, places = 1): number => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

/* ------------------------------------------------------------ back-test */

export interface BacktestPoint {
  locationId: string;
  weekStart: string;
  leadWeeks: number;
  forecastP50: number;
  actualHours: number;
  /** Signed percent error, (forecast − actual) ÷ actual × 100. */
  pctError: number;
}

export interface BacktestResult {
  weights: Weights;
  /** Mean absolute percent error at the back-test lead, across every scored site-week. */
  mapePct: number | null;
  /** The same for weeks whose start falls in June, July or August. */
  summerMapePct: number | null;
  points: BacktestPoint[];
  scoredWeeks: number;
}

/**
 * Score every historical week (with enough history before it) at a
 * four-week lead, for each candidate weight on last year; keep the weight
 * with the lowest mean absolute percent error and take the band from the
 * 10th and 90th percentiles of its signed errors.
 */
export function backtest(sites: ReadonlyMap<string, WeekSeries>, opts: { lead?: number } = {}): BacktestResult {
  const lead = opts.lead ?? BACKTEST_LEAD_WEEKS;
  let best: { w: number; points: BacktestPoint[]; mape: number } | null = null;
  for (const w of LAST_YEAR_WEIGHTS) {
    const points: BacktestPoint[] = [];
    for (const [locationId, series] of sites) {
      const weeks = [...series.keys()].sort();
      if (weeks.length < MIN_HISTORY_WEEKS + lead) continue;
      for (let i = MIN_HISTORY_WEEKS + lead - 1; i < weeks.length; i++) {
        const target = weeks[i]!;
        const actual = series.get(target)!;
        if (actual <= 0) continue;
        const anchor = addWeeks(target, -(lead - 1));
        // The anchor's history must stop `lead` weeks before the target.
        const point = forecastSite(series, { anchor, horizonWeeks: lead, weights: { lastYearWeight: w, bandLow: 0, bandHigh: 0 } })[lead - 1];
        if (!point) continue;
        points.push({ locationId, weekStart: target, leadWeeks: lead, forecastP50: point.p50, actualHours: actual, pctError: ((point.p50 - actual) / actual) * 100 });
      }
    }
    if (!points.length) continue;
    const mape = mean(points.map((p) => Math.abs(p.pctError)));
    if (!best || mape < best.mape - 1e-9) best = { w, points, mape };
  }
  if (!best) return { weights: DEFAULT_WEIGHTS, mapePct: null, summerMapePct: null, points: [], scoredWeeks: 0 };
  const errors = best.points.map((p) => p.pctError / 100).sort((a, b) => a - b);
  const q = (p: number) => errors[Math.min(errors.length - 1, Math.max(0, Math.floor(p * (errors.length - 1))))]!;
  const summer = best.points.filter((p) => ['06', '07', '08'].includes(p.weekStart.slice(5, 7)));
  return {
    weights: {
      lastYearWeight: best.w,
      // The band is at least the default so a lucky stretch never reads as certainty.
      bandLow: Math.min(DEFAULT_BAND.low, round(q(0.1), 3)),
      bandHigh: Math.max(DEFAULT_BAND.high, round(q(0.9), 3)),
    },
    mapePct: round(best.mape),
    summerMapePct: summer.length ? round(mean(summer.map((p) => Math.abs(p.pctError)))) : null,
    points: best.points,
    scoredWeeks: best.points.length,
  };
}
