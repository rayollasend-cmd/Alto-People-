import type { ExecAgingBuckets, ExecFinanceWeek, ExecStatus } from '@alto-people/shared';

/**
 * The financials page's arithmetic (2026-10-27) — pure, so the sentences the
 * page prints are tested on their own: the thirteen weeks' direction, the
 * receivables buckets, days past due, profit against budget.
 */

/** 20.8% — one decimal, the executive portal's percent. */
export function pct1(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const r = n.toFixed(1);
  // A real minus sign, and never "−0.0%".
  return Number(r) < 0 ? `−${r.slice(1)}%` : `${r.replace(/^-/, '')}%`;
}

export const AGING_KEYS = ['current', 'days1to30', 'days31to60', 'days61to90', 'over90'] as const satisfies ReadonlyArray<keyof ExecAgingBuckets>;
export type AgingKey = (typeof AGING_KEYS)[number];

/**
 * Each bucket's fill: not yet due is healthy money (positive), then caution,
 * then negative, stronger the later it is — the palette's scale steps, which
 * hold their contrast in both themes. A bucket at zero is never drawn.
 */
export const AGING_FILL: Record<AgingKey, string> = {
  current: 'bg-positive-700',
  days1to30: 'bg-caution-600',
  days31to60: 'bg-caution-800',
  days61to90: 'bg-negative-600',
  over90: 'bg-negative-800',
};

export interface AgingSlice {
  key: AgingKey;
  amount: number;
  /** Share of the total, 0–100. */
  pct: number;
}

export function agingSlices(b: ExecAgingBuckets): AgingSlice[] {
  const total = AGING_KEYS.reduce((s, k) => s + Math.max(0, b[k] ?? 0), 0);
  return AGING_KEYS.map((key) => {
    const amount = Math.max(0, b[key] ?? 0);
    return { key, amount, pct: total > 0 ? (amount / total) * 100 : 0 };
  });
}

/** Everything past its due date. */
export function pastDue(b: ExecAgingBuckets): number {
  return AGING_KEYS.filter((k) => k !== 'current').reduce((s, k) => s + Math.max(0, b[k] ?? 0), 0);
}

const DAY_MS = 86_400_000;
const dayNumber = (ymd: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS : NaN;
};

/** Whole days a statement is past its due date on `today` (negative: days until it is due). */
export function daysPastDue(dueOn: string, today: string): number {
  return Math.round(dayNumber(today) - dayNumber(dueOn));
}

export interface WeeksTrend {
  /** Weeks in each half of the comparison (4, or fewer when the record is short). */
  n: number;
  recentAvg: number;
  priorAvg: number;
  /** Relative change of the recent average on the prior one (0.062 = +6.2%); null when the prior is 0. */
  change: number | null;
  marginFrom: number | null;
  marginTo: number | null;
}

/** The weeks that carry anything billed or spent. */
export function weeksWithData(weeks: ReadonlyArray<ExecFinanceWeek>): ExecFinanceWeek[] {
  return weeks.filter((w) => w.billed !== 0 || w.cost !== 0);
}

/**
 * The thirteen weeks in one comparison: the average billed over the last
 * `n` weeks against the `n` before (n = 4, or half the record when it is
 * shorter), and the margin rate from the start of that span to its end.
 */
export function weeksTrend(weeks: ReadonlyArray<ExecFinanceWeek>): WeeksTrend | null {
  const w = weeksWithData(weeks);
  const n = Math.min(4, Math.floor(w.length / 2));
  if (n < 1) return null;
  const recent = w.slice(-n);
  const prior = w.slice(-2 * n, -n);
  const avg = (xs: ExecFinanceWeek[]) => xs.reduce((s, x) => s + x.billed, 0) / xs.length;
  const recentAvg = avg(recent);
  const priorAvg = avg(prior);
  return {
    n,
    recentAvg,
    priorAvg,
    change: priorAvg !== 0 ? (recentAvg - priorAvg) / Math.abs(priorAvg) : null,
    marginFrom: prior[0]?.marginPct ?? null,
    marginTo: recent[recent.length - 1]?.marginPct ?? null,
  };
}

/** Profit against budget, judged like every other measure: on it, within 5% short, or off it. */
export function budgetStatus(actual: number, budget: number): ExecStatus {
  if (!Number.isFinite(actual) || !Number.isFinite(budget) || budget === 0) return 'none';
  if (actual >= budget) return 'good';
  return actual >= budget - Math.abs(budget) * 0.05 ? 'watch' : 'bad';
}
