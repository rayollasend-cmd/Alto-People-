import type { ExecStatus } from '@alto-people/shared';

/**
 * Where the quarter lands at the current pace (2026-10-27): what has come
 * in so far, divided by the share of the quarter that has gone by. Judged
 * against the plan the way the scorecard judges — on or ahead is on plan,
 * within 5% short is to watch, further short is off plan.
 */
export interface PlanPace {
  /** QTD ÷ elapsed share; null before any of the quarter has gone by. */
  projected: number | null;
  target: number | null;
  /** projected ÷ target (1.0 = exactly on plan). */
  ratio: number | null;
  /** projected − target: negative is short of plan. */
  gap: number | null;
  status: ExecStatus;
}

export function planPace(actualQtd: number, elapsedPct: number, target: number | null | undefined): PlanPace {
  const t = target === undefined || target === null || !Number.isFinite(target) ? null : target;
  const projected = Number.isFinite(actualQtd) && elapsedPct > 0 ? actualQtd / (Math.min(100, elapsedPct) / 100) : null;
  if (projected === null || t === null || t <= 0) return { projected, target: t, ratio: null, gap: projected !== null && t !== null ? projected - t : null, status: 'none' };
  const ratio = projected / t;
  const status: ExecStatus = ratio >= 1 ? 'good' : ratio >= 0.95 ? 'watch' : 'bad';
  return { projected, target: t, ratio, gap: projected - t, status };
}

/** "2026-Q4" → { q: 4, year: 2026 }; null for anything else. */
export function parseQuarter(key: string): { q: number; year: number } | null {
  const m = /^(\d{4})-Q([1-4])$/.exec(key.trim());
  return m ? { year: Number(m[1]), q: Number(m[2]) } : null;
}

/**
 * A level measure against its plan (people working, fill rate): no pace to
 * carry forward — the reading now is the reading, judged the same way.
 */
export function levelVsPlan(actual: number | null | undefined, target: number | null | undefined): PlanPace {
  const a = actual === undefined || actual === null || !Number.isFinite(actual) ? null : actual;
  const t = target === undefined || target === null || !Number.isFinite(target) ? null : target;
  if (a === null || t === null || t <= 0) return { projected: a, target: t, ratio: null, gap: a !== null && t !== null ? a - t : null, status: 'none' };
  const ratio = a / t;
  return { projected: a, target: t, ratio, gap: a - t, status: ratio >= 1 ? 'good' : ratio >= 0.95 ? 'watch' : 'bad' };
}
