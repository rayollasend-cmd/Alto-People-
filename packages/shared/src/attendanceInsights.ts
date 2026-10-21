import { z } from 'zod';

/**
 * Attendance insights — the trends, the heatmap and the "not in yet" list
 * behind the Workforce, Supervisor and Manager homes.
 *
 * The API contract shared by apps/api/src/routes/attendanceInsights.ts
 * (lib/attendanceInsights.ts) and apps/web/src/lib/attendanceInsightsApi.ts.
 * Every read is clamped to the caller's tenant and reach (their client,
 * their sites, their direct reports) on the server.
 *
 *   GET /attendance/trends?weeks=8&siteId?                     → AttendanceTrendsResponse
 *   GET /attendance/heatmap?metric=late|overtime|callouts&from&to&siteId?
 *                                                              → AttendanceHeatmapResponse
 *   GET /attendance/late-now?siteId?                           → LateNowResponse
 *   GET /attendance/team-hours                                 → TeamHoursResponse
 *
 * Weeks are the company workweek (Saturday through Friday on the company's
 * clock). A late arrival is a LATE attendance event (punched in more than
 * seven minutes after the shift's start); a no-call no-show and an excused
 * event are counted as the attendance policy records them; a call-out is a
 * worker saying they can't make a shift (the call-out log, or a missed
 * shift a time-off request covered). Overtime is each person's weekly hours
 * past 40, net of unpaid meal breaks.
 */

export const ATTENDANCE_OVERTIME_THRESHOLD_HOURS = 40;
/** The fill rate a store is graded against — the reference line on the charts. */
export const ATTENDANCE_FILL_TARGET_PCT = 95;
/** Minutes after start before a missing punch counts as late (the attendance policy's line). */
export const LATE_GRACE_MINUTES = 7;
/** Minutes after start, with no punch and no word, before cover should be found. */
export const NO_SHOW_RISK_MINUTES = 30;

const YmdSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** A real calendar day — 2026-13-45 and 2026-02-31 are refused, not rolled over. */
const RealYmdSchema = YmdSchema.refine((s) => {
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m! - 1 && dt.getUTCDate() === d;
}, 'Not a real date');

/* ---- Trends ------------------------------------------------------------- */

export const AttendanceTrendsQuerySchema = z.object({
  weeks: z.coerce.number().int().min(2).max(26).default(8),
  siteId: z.string().uuid().optional(),
});
export type AttendanceTrendsQuery = z.infer<typeof AttendanceTrendsQuerySchema>;

export const AttendanceWeekSchema = z.object({
  /** The workweek's first day (Saturday), YYYY-MM-DD. */
  weekStart: YmdSchema,
  /** True for the week still running — its figures are to date. */
  inProgress: z.boolean(),
  /** For the week in progress, only shifts that have already started — "so far" means so far. */
  scheduledShifts: z.number().int().nonnegative(),
  filledShifts: z.number().int().nonnegative(),
  /** filled / scheduled, whole percent; null when nothing was scheduled. */
  fillRatePct: z.number().nullable(),
  noCallNoShows: z.number().int().nonnegative(),
  /** Confirmed call-outs (the desk's count) plus missed shifts a time-off request covered. */
  callOuts: z.number().int().nonnegative(),
  lates: z.number().int().nonnegative(),
  overtimeHours: z.number().nonnegative(),
});
export type AttendanceWeek = z.infer<typeof AttendanceWeekSchema>;

export const AttendanceTrendsResponseSchema = z.object({
  generatedAt: z.string(),
  siteId: z.string().uuid().nullable(),
  fillTargetPct: z.number(),
  /** Oldest first; the last week is the one in progress. */
  weeks: z.array(AttendanceWeekSchema),
});
export type AttendanceTrendsResponse = z.infer<typeof AttendanceTrendsResponseSchema>;

/* ---- Heatmap ------------------------------------------------------------ */

export const ATTENDANCE_HEATMAP_METRICS = ['late', 'overtime', 'callouts'] as const;
export type AttendanceHeatmapMetric = (typeof ATTENDANCE_HEATMAP_METRICS)[number];

export const AttendanceHeatmapQuerySchema = z.object({
  metric: z.enum(ATTENDANCE_HEATMAP_METRICS).default('late'),
  from: RealYmdSchema.optional(),
  to: RealYmdSchema.optional(),
  siteId: z.string().uuid().optional(),
});
export type AttendanceHeatmapQuery = z.infer<typeof AttendanceHeatmapQuerySchema>;

export const AttendanceHeatmapRowSchema = z.object({
  /** A site id, an hour ("06"), or "none" for events with no site. */
  key: z.string(),
  label: z.string(),
  /** One value per day in `days` order. */
  values: z.array(z.number()),
  total: z.number(),
});
export type AttendanceHeatmapRow = z.infer<typeof AttendanceHeatmapRowSchema>;

export const AttendanceHeatmapResponseSchema = z.object({
  metric: z.enum(ATTENDANCE_HEATMAP_METRICS),
  /** Inclusive range, YYYY-MM-DD. */
  from: YmdSchema,
  to: YmdSchema,
  siteId: z.string().uuid().nullable(),
  /** Rows are sites, or the hours of the day when one site is chosen. */
  by: z.enum(['site', 'hour']),
  /** 'count' for lates and call-outs, 'hours' for overtime. */
  unit: z.enum(['count', 'hours']),
  /** Day-of-week labels in workweek order (Sat … Fri by default). */
  days: z.array(z.string()),
  rows: z.array(AttendanceHeatmapRowSchema),
  max: z.number(),
  total: z.number(),
});
export type AttendanceHeatmapResponse = z.infer<typeof AttendanceHeatmapResponseSchema>;

/* ---- Not in yet --------------------------------------------------------- */

export const LateNowQuerySchema = z.object({
  siteId: z.string().uuid().optional(),
});

export const LATE_NOW_STATUSES = ['due', 'late', 'no-show-risk', 'called-out', 'on-leave'] as const;
export type LateNowStatus = (typeof LATE_NOW_STATUSES)[number];

export const LateNowPersonSchema = z.object({
  shiftId: z.string().uuid(),
  associateId: z.string().uuid(),
  name: z.string(),
  position: z.string(),
  /** The shift's client — /floor/crew-text texts one client's shifts at a time. */
  clientId: z.string().uuid().nullable(),
  siteId: z.string().uuid().nullable(),
  siteName: z.string().nullable(),
  startsAt: z.string(),
  endsAt: z.string(),
  timezone: z.string(),
  minutesLate: z.number().int().nonnegative(),
  /**
   * due: started, inside the grace minutes · late: past them ·
   * no-show-risk: past NO_SHOW_RISK_MINUTES with no word — find cover ·
   * called-out: they said they can't make it — find cover ·
   * on-leave: approved time off covers the day, yet the shift is still theirs — find cover.
   */
  status: z.enum(LATE_NOW_STATUSES),
  /**
   * How they said so, for a called-out row: a confirmed call-out, a call-out
   * still waiting on their YES (read as "can't make it", not confirmed), or a
   * NO to the attendance reminder. Null otherwise.
   */
  calledOutHow: z.enum(['confirmed', 'unconfirmed', 'reminder-no']).nullable(),
  /** True when the caller can text this person from here (a phone, a client to text through, and the right). */
  textable: z.boolean(),
  hasPhone: z.boolean(),
  /** Only for callers who may reach the crew (never a store account or a watch-only lead). */
  phone: z.string().nullable(),
});
export type LateNowPerson = z.infer<typeof LateNowPersonSchema>;

export const LateNowResponseSchema = z.object({
  generatedAt: z.string(),
  graceMinutes: z.number(),
  noShowRiskMinutes: z.number(),
  /**
   * True when the caller can text through /floor/crew-text at all. Each
   * person's `textable` says whether they can be reached from here; texts go
   * one client at a time (a shift with no client can't be texted this way).
   */
  canText: z.boolean(),
  /** Most late first. */
  people: z.array(LateNowPersonSchema),
});
export type LateNowResponse = z.infer<typeof LateNowResponseSchema>;

/* ---- Hours per person this week (the line manager's team) --------------- */

export const TeamHoursPersonSchema = z.object({
  associateId: z.string().uuid(),
  name: z.string(),
  /** Net hours punched this workweek so far (an open punch counts to now). */
  workedHours: z.number().nonnegative(),
  /**
   * Hours on assigned shifts still ahead this workweek — the rest of a shift
   * under way included — net of the meal break the site's state requires
   * (or a usual 30 minutes on a shift of six hours or more), so it adds to
   * worked hours on the same basis.
   */
  scheduledHours: z.number().nonnegative(),
  /** worked + scheduled — where the week is heading. */
  projectedHours: z.number().nonnegative(),
  onClock: z.boolean(),
});
export type TeamHoursPerson = z.infer<typeof TeamHoursPersonSchema>;

export const TeamHoursResponseSchema = z.object({
  weekStart: YmdSchema,
  /** Exclusive end, YYYY-MM-DD (the next Saturday). */
  weekEnd: YmdSchema,
  thresholdHours: z.number(),
  /** Most projected hours first. */
  people: z.array(TeamHoursPersonSchema),
});
export type TeamHoursResponse = z.infer<typeof TeamHoursResponseSchema>;
