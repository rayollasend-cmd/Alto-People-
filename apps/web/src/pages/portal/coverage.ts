import { zonedDayKey, zonedMinutesOfDay } from '@/lib/format';

/**
 * Headcount at the top of each hour of one day, in the store's zone: how
 * many assigned shifts (and how many unfilled slots) cover that hour.
 * Shared by the home page's coverage curve and the schedule heatmap so
 * the two never disagree about an hour.
 */

export interface CoverageShift {
  startsAt: string;
  endsAt: string;
  timezone: string;
  state: 'open' | 'on-floor' | 'done' | 'confirmed' | 'unconfirmed';
}

export interface HourPoint {
  hour: number;
  label: string;
  scheduled: number;
  open: number;
}

export function hourLabel(h: number): string {
  if (h === 0) return '12a';
  if (h < 12) return `${h}a`;
  if (h === 12) return '12p';
  return `${h - 12}p`;
}

export function coverageByHour(
  shifts: CoverageShift[],
  dayKey: string,
  tz: string | null,
): HourPoint[] {
  const points: HourPoint[] = Array.from({ length: 24 }, (_, h) => ({
    hour: h,
    label: hourLabel(h),
    scheduled: 0,
    open: 0,
  }));
  for (const r of shifts) {
    const zone = tz ?? r.timezone;
    const startMin = zonedDayKey(r.startsAt, zone) === dayKey ? zonedMinutesOfDay(r.startsAt, zone) : 0;
    const endMin = zonedDayKey(r.endsAt, zone) === dayKey ? zonedMinutesOfDay(r.endsAt, zone) : 1440;
    for (const p of points) {
      const m = p.hour * 60;
      if (m >= startMin && m < endMin) {
        if (r.state === 'open') p.open += 1;
        else p.scheduled += 1;
      }
    }
  }
  return points;
}
