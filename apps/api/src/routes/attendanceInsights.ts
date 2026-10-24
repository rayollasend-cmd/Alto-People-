import { Router } from 'express';
import { AttendanceCalendarQuerySchema, AttendanceHeatmapQuerySchema, AttendanceTrendsQuerySchema, LateNowQuerySchema } from '@alto-people/shared';
import { HttpError } from '../middleware/error.js';
import { requireAnyCapability, requireCapability } from '../middleware/auth.js';
import { attendanceCalendar, attendanceHeatmap, attendanceTrends, lateNow, teamHours } from '../lib/attendanceInsights.js';

/**
 * Attendance insights — the trend lines, the heatmap and the "not in yet"
 * list on the Workforce and Supervisor homes, the year-at-a-glance calendar
 * (Workforce home, call-outs desk), and the team-hours chart on the Manager
 * home (lib/attendanceInsights.ts; contract in
 * packages/shared/src/attendanceInsights.ts).
 *
 * The floor reads are for whoever runs time or the schedule, or watches
 * the live board; every one is clamped to the caller's tenant and reach in
 * the lib. Team hours are a line manager's own reports.
 */

export const attendanceInsightsRouter = Router();

const FLOOR = requireAnyCapability('manage:time', 'manage:scheduling', 'view:time-live');

function parse<T>(schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: { flatten: () => unknown } } }, v: unknown): T {
  const r = schema.safeParse(v);
  if (!r.success) throw new HttpError(400, 'invalid_query', 'Invalid query', r.error.flatten());
  return r.data;
}

attendanceInsightsRouter.get('/trends', FLOOR, async (req, res, next) => {
  try {
    res.json(await attendanceTrends(req.user!, parse(AttendanceTrendsQuerySchema, req.query)));
  } catch (err) {
    next(err);
  }
});

attendanceInsightsRouter.get('/heatmap', FLOOR, async (req, res, next) => {
  try {
    res.json(await attendanceHeatmap(req.user!, parse(AttendanceHeatmapQuerySchema, req.query)));
  } catch (err) {
    next(err);
  }
});

attendanceInsightsRouter.get('/calendar', FLOOR, async (req, res, next) => {
  try {
    res.json(await attendanceCalendar(req.user!, parse(AttendanceCalendarQuerySchema, req.query)));
  } catch (err) {
    next(err);
  }
});

attendanceInsightsRouter.get('/late-now', FLOOR, async (req, res, next) => {
  try {
    res.json(await lateNow(req.user!, parse(LateNowQuerySchema, req.query)));
  } catch (err) {
    next(err);
  }
});

attendanceInsightsRouter.get('/team-hours', requireCapability('view:my-team'), async (req, res, next) => {
  try {
    res.json(await teamHours(req.user!));
  } catch (err) {
    next(err);
  }
});
