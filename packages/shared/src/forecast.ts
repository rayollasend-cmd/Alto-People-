import { z } from 'zod';

/**
 * Brief 3-4 — labor-demand forecasting.
 *
 * The forecast is a transparent model, not a black box: per site and org
 * week, the same week last year (scaled to the site's current level) blended
 * with the last eight weeks and their trend, a small holiday table, and the
 * client signals a person typed in (a truck schedule, occupancy, an event)
 * as multiplicative factors. The band is the residual spread of the back-test
 * at that lead. Every number carries its drivers so the page can say why.
 */

export const FORECAST_HORIZON_WEEKS = 26;
export const FORECAST_METHOD = 'seasonal-naive-trend/1';

export const FORECAST_SIGNAL_KINDS = ['TRUCKS', 'OCCUPANCY', 'EVENT', 'OTHER'] as const;
export type ForecastSignalKind = (typeof FORECAST_SIGNAL_KINDS)[number];
export const FORECAST_SIGNAL_LABELS: Record<ForecastSignalKind, string> = {
  TRUCKS: 'Truck schedule',
  OCCUPANCY: 'Occupancy',
  EVENT: 'Event',
  OTHER: 'Other',
};

const WeekKey = /* @__PURE__ */ (() => z.string().regex(/^\d{4}-\d{2}-\d{2}$/))();

export const ForecastSignalInputSchema = /* @__PURE__ */ (() => z.object({
  locationId: z.string().uuid(),
  /** Org week start, YYYY-MM-DD. */
  weekStart: WeekKey,
  kind: z.enum(FORECAST_SIGNAL_KINDS),
  /** Multiplier on the week's demand: 1.2 = a fifth more hours, 0.8 = a fifth fewer. */
  factor: z.number().min(0.1).max(5),
  source: z.string().trim().max(120).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
}))();
export type ForecastSignalInput = z.infer<typeof ForecastSignalInputSchema>;

export const ForecastPlanInputSchema = /* @__PURE__ */ (() => z
  .object({
    name: z.string().trim().min(2).max(120),
    clientId: z.string().uuid().nullable().optional(),
    seasonStart: WeekKey,
    seasonEnd: WeekKey,
    targetHoursPerWeek: z.number().int().min(8).max(80).default(40),
    shiftHours: z.number().int().min(4).max(12).default(8),
    reservePct: z.number().int().min(0).max(100).default(10),
  })
  .refine((v) => v.seasonEnd >= v.seasonStart, { message: 'seasonEnd must be on or after seasonStart', path: ['seasonEnd'] }))();
export type ForecastPlanInput = z.infer<typeof ForecastPlanInputSchema>;

/** What went into one site-week's number, so the page can say why. */
export interface ForecastDrivers {
  /** Hours the same org week last year, scaled to the site's current level; null when there is no last year. */
  lastYearScaled: number | null;
  /** Mean verified hours of the last eight weeks before the anchor. */
  recentMean: number;
  /** Hours per week the last eight weeks are rising (+) or falling (−). */
  trendPerWeek: number;
  /** The holiday table's factor for the week (1 = none). */
  holidayFactor: number;
  holidayName: string | null;
  /** The product of the signals a person entered for the week (1 = none). */
  signalFactor: number;
  signals: Array<{ kind: ForecastSignalKind; factor: number; source: string | null }>;
  /** Weight on last year (the rest is on the recent weeks). */
  lastYearWeight: number;
  leadWeeks: number;
}

export interface ForecastWeek {
  weekStart: string;
  p10: number;
  p50: number;
  p90: number;
  /** Verified hours that week, when the week is in the past (the chart's actual line). */
  actualHours: number | null;
  drivers: ForecastDrivers;
}

export interface ForecastSiteSummary {
  locationId: string;
  siteName: string;
  clientName: string | null;
  timezone: string;
  /** p50 hours over the next four weeks. */
  next4WeeksHours: number;
  /** Mean absolute percent error of the back-test at a four-week lead; null before the first back-test. */
  mapePct: number | null;
  /** Weeks of verified history behind the forecast. */
  historyWeeks: number;
}

export interface ForecastAccuracyRow {
  weekStart: string;
  leadWeeks: number;
  forecastP50: number;
  actualHours: number;
  absPctError: number;
}

export interface ForecastResponse {
  run: {
    id: string;
    method: string;
    generatedAt: string;
    anchorWeek: string;
    horizonWeeks: number;
    trigger: string;
    weights: { lastYearWeight: number; bandLow: number; bandHigh: number };
  } | null;
  site: ForecastSiteSummary | null;
  /** Past 26 weeks of actuals followed by the horizon; a point without a run has only actualHours. */
  weeks: ForecastWeek[];
  accuracy: ForecastAccuracyRow[];
  signals: Array<{ id: string; weekStart: string; kind: ForecastSignalKind; factor: number; source: string | null; note: string | null }>;
}

export interface ForecastSitesResponse {
  run: ForecastResponse['run'];
  sites: ForecastSiteSummary[];
}
