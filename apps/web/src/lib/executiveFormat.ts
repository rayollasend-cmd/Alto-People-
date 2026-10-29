import type { ExecKpi, ExecStatus, ExecUnit } from '@alto-people/shared';
import { fmtTime, fmtTimeTz, tzAbbrev } from '@/lib/format';

/**
 * How the executive portal writes a number (2026-10-27). Board figures are
 * read, not reconciled: money to three significant figures ($22.6k, $181k,
 * $1.24M), percentages to one decimal, counts whole, days whole. The exact
 * figure is the drill-down's job (and the tooltip's — `fmtExecExact`).
 */

const DASH = '—';

/** $22.6k · $181k · $1.24M · $640 — three significant figures, the app's lowercase k. */
export function fmtExecMoney(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  const sign = value < 0 ? '−' : '';
  const abs = Math.abs(value);
  const sig3 = (n: number) => (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2));
  if (abs >= 1_000_000_000) return `${sign}$${sig3(abs / 1_000_000_000)}B`;
  if (abs >= 1_000_000) return `${sign}$${sig3(abs / 1_000_000)}M`;
  if (abs >= 1_000) return `${sign}$${sig3(abs / 1_000)}k`;
  return `${sign}$${Math.round(abs).toLocaleString('en-US')}`;
}

export function fmtExecValue(value: number | null | undefined, unit: ExecUnit): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  if (unit === 'money') return fmtExecMoney(value);
  if (unit === 'pct') return `${value.toFixed(1)}%`;
  if (unit === 'days') return `${Math.round(value)} ${Math.round(value) === 1 ? 'day' : 'days'}`;
  return Math.round(value).toLocaleString('en-US');
}

/** The exact figure, for a title attribute: $22,649.28 · 20.79% · 36. */
export function fmtExecExact(value: number | null | undefined, unit: ExecUnit): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  if (unit === 'money') return value.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  if (unit === 'pct') return `${value.toFixed(2)}%`;
  return value.toLocaleString('en-US');
}

/**
 * The change, signed, in the KPI's own terms: +$1.2k · −3.4 pts · +2 · −5 days.
 * Percentages move in points; the relative change goes beside money and counts.
 */
export function fmtExecDelta(kpi: Pick<ExecKpi, 'delta' | 'deltaPct' | 'unit'>): string | null {
  const { delta, deltaPct, unit } = kpi;
  if (delta === null || !Number.isFinite(delta)) return null;
  const sign = delta > 0 ? '+' : delta < 0 ? '−' : '±';
  const abs = Math.abs(delta);
  if (unit === 'pct') return `${sign}${abs.toFixed(1)} pts`;
  if (unit === 'days') return `${sign}${Math.round(abs)} ${Math.round(abs) === 1 ? 'day' : 'days'}`;
  const main = unit === 'money' ? fmtExecMoney(abs) : Math.round(abs).toLocaleString('en-US');
  const rel = deltaPct !== null && Number.isFinite(deltaPct) && Math.abs(deltaPct) >= 0.001 ? ` (${sign}${(Math.abs(deltaPct) * 100).toFixed(1)}%)` : '';
  return `${sign}${main}${rel}`;
}

/** Whether a change is good news, bad news, or no news, given which way is better. */
export function deltaTone(kpi: Pick<ExecKpi, 'delta' | 'betterWhen'>): 'good' | 'bad' | 'neutral' {
  if (kpi.delta === null || kpi.delta === 0) return 'neutral';
  const up = kpi.delta > 0;
  return up === (kpi.betterWhen === 'up') ? 'good' : 'bad';
}

/** The status dot's classes — scale steps (scripts/palette.mjs), never a raw hue. */
export const STATUS_DOT: Record<ExecStatus, string> = {
  good: 'bg-positive-700',
  watch: 'bg-caution-700',
  bad: 'bg-negative-700',
  none: 'bg-neutral-500',
};

export const STATUS_TEXT: Record<ExecStatus, string> = {
  good: 'text-positive-800',
  watch: 'text-caution-800',
  bad: 'text-negative-800',
  none: 'text-ink-muted',
};

/**
 * "2:19 AM EDT" — when the figures were read, on the COMPANY's clock with
 * its zone. The periods beside it are company days (an Eastern company is on
 * Thursday at 11:30 PM Pacific), so a browser-clock "11:19 PM" beside
 * "Oct 1 – 29" mixed two calendars. Without a zone from the API it falls
 * back to the display clock, unlabelled, as before.
 */
export function fmtExecAsOf(asOf: string, timezone?: unknown): string {
  if (typeof timezone !== 'string' || !timezone) return fmtTime(asOf);
  try {
    return `${fmtTimeTz(asOf, timezone)} ${tzAbbrev(timezone, asOf)}`;
  } catch {
    // An unknown zone name must not take the page down: the display clock, unlabelled.
    return fmtTime(asOf);
  }
}
