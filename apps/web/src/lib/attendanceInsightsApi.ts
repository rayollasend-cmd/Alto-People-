import type {
  AttendanceHeatmapMetric,
  AttendanceHeatmapResponse,
  AttendanceTrendsResponse,
  LateNowResponse,
  TeamHoursResponse,
} from '@alto-people/shared';
import { apiFetch } from './api';

/**
 * Attendance insights (routes/attendanceInsights.ts on the API; contract in
 * packages/shared/src/attendanceInsights.ts): weekly trends, the heatmap,
 * who isn't in yet, and a manager's team hours. All clamped to the caller's
 * reach on the server.
 */

export type {
  AttendanceHeatmapMetric,
  AttendanceHeatmapResponse,
  AttendanceTrendsResponse,
  AttendanceWeek,
  LateNowPerson,
  LateNowResponse,
  TeamHoursPerson,
  TeamHoursResponse,
} from '@alto-people/shared';

const qs = (o: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const getAttendanceTrends = (o: { weeks?: number; siteId?: string } = {}) =>
  apiFetch<AttendanceTrendsResponse>(`/attendance/trends${qs({ weeks: o.weeks ?? 8, siteId: o.siteId })}`);

export const getAttendanceHeatmap = (o: { metric: AttendanceHeatmapMetric; from?: string; to?: string; siteId?: string }) =>
  apiFetch<AttendanceHeatmapResponse>(`/attendance/heatmap${qs(o)}`);

export const getLateNow = (o: { siteId?: string } = {}) => apiFetch<LateNowResponse>(`/attendance/late-now${qs(o)}`);

export const getTeamHours = () => apiFetch<TeamHoursResponse>('/attendance/team-hours');
