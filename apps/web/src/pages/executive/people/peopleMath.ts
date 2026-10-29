import type { ExecKpi, ExecPeople, ExecStatus } from '@alto-people/shared';

/**
 * The arithmetic behind the chairman's workforce page, kept pure so it is
 * tested on its own: how many points a series really has, turnover judged
 * against its plan (lower is better), the attendance grid's values.
 */

/** How many real readings a series has — a chart with fewer than four is a number and a sentence instead. */
export function pointsIn(values: Array<number | null | undefined>): number {
  return values.filter((v) => typeof v === 'number' && Number.isFinite(v)).length;
}

export const MIN_CHART_POINTS = 4;

/**
 * Turnover against its plan. The plan is a ceiling: at or under it is on
 * plan, within 5% over it is to watch, past that is off plan. With no plan
 * there is nothing to judge by.
 */
export function turnoverStatus(valuePct: number | null, targetPct: number | null): ExecStatus {
  if (valuePct === null || targetPct === null || !Number.isFinite(valuePct) || !Number.isFinite(targetPct)) return 'none';
  if (valuePct <= targetPct) return 'good';
  if (valuePct <= targetPct * 1.05) return 'watch';
  return 'bad';
}

/** The scorecard's own turnover measure when the API sent one, so the two agree. */
export function turnoverKpi(data: Pick<ExecPeople, 'kpis'>): ExecKpi | null {
  return data.kpis.find((k) => k.id === 'turnover') ?? null;
}

/** sites × weeks of events per 100 shifts (null where the site ran no shifts that week). */
export function attendanceGrid(att: ExecPeople['attendance']): { values: Array<Array<number | null>>; events: Array<Array<number>> } {
  const at = new Map(att.cells.map((c) => [`${c.siteId}|${c.week}`, c]));
  return {
    values: att.sites.map((s) => att.weeks.map((w) => at.get(`${s.id}|${w}`)?.perHundredShifts ?? null)),
    events: att.sites.map((s) => att.weeks.map((w) => at.get(`${s.id}|${w}`)?.events ?? 0)),
  };
}

/** The average of the readings, or null with none. */
export function mean(values: Array<number | null | undefined>): number | null {
  const v = values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
