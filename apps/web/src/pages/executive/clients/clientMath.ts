import type { ExecClientRow, ExecStatus } from '@alto-people/shared';
import type { ScatterTone } from '@/components/ui/charts';

/**
 * The client portfolio's arithmetic (2026-10-27) — pure, so the words the
 * page prints are tested on their own: health bands, the concentration
 * index in a word, the bars folded past the largest few.
 */

/** The clients list's health words (API lib/execClients HEALTH_WORD), as tones. */
const HEALTH_WORD_TONE: Record<string, ScatterTone> = { good: 'good', watch: 'watch', 'at risk': 'bad' };

/**
 * A client's health as a tone. The signal is the clients list's word —
 * Good, Watch, At risk (the list has no 0–100 score, so the API sends
 * `health: null`); a score, should one ever come, falls back to the
 * briefing's cut (80 good, 60 watch). The page prints its own translated
 * word and never a number.
 */
export function healthTone(c: Pick<ExecClientRow, 'health' | 'healthLabel'>): ScatterTone {
  const word = c.healthLabel ? HEALTH_WORD_TONE[c.healthLabel.trim().toLowerCase()] : undefined;
  if (word) return word;
  if (c.health !== null && Number.isFinite(c.health)) return c.health >= 80 ? 'good' : c.health >= 60 ? 'watch' : 'bad';
  return 'none';
}

/** Health for sorting: at risk first ascending, then watch, then good; no word last. */
export const HEALTH_RANK: Record<ScatterTone, number | null> = { bad: 0, watch: 1, good: 2, none: null };

/** The same band as an executive status, for the dot and chip classes. */
export function healthStatus(c: Pick<ExecClientRow, 'health' | 'healthLabel'>): ExecStatus {
  return healthTone(c);
}

export type ConcentrationBand = 'high' | 'moderate' | 'low';

/**
 * How concentrated the book is. The Herfindahl–Hirschman index sums each
 * client's squared share (0–10,000): under 1,500 is diversified, 1,500–2,500
 * moderately concentrated, over 2,500 concentrated. One client past the
 * risk threshold makes it concentrated whatever the index says.
 */
export function concentrationBand(hhi: number, topSharePct: number, thresholdPct: number): ConcentrationBand {
  if (topSharePct >= thresholdPct || hhi > 2500) return 'high';
  return hhi >= 1500 ? 'moderate' : 'low';
}

export interface ShareRow {
  key: string;
  name: string;
  billed: number;
  sharePct: number;
  /** "3 other clients" — a folded row. */
  other?: number;
}

/** The largest clients by share, the rest folded into one "other" row once there are more than `keep` + 1. */
export function shareRows(clients: ReadonlyArray<Pick<ExecClientRow, 'clientId' | 'name' | 'billed' | 'sharePct'>>, keep = 7): ShareRow[] {
  const sorted = [...clients].filter((c) => c.billed > 0 || c.sharePct > 0).sort((a, b) => b.sharePct - a.sharePct || b.billed - a.billed);
  const rows: ShareRow[] = sorted.map((c) => ({ key: c.clientId, name: c.name, billed: c.billed, sharePct: c.sharePct }));
  if (rows.length <= keep + 1) return rows;
  const rest = rows.slice(keep);
  return [
    ...rows.slice(0, keep),
    { key: 'other', name: '', billed: rest.reduce((s, r) => s + r.billed, 0), sharePct: rest.reduce((s, r) => s + r.sharePct, 0), other: rest.length },
  ];
}

/** The portfolio's own margin rate: total margin over total billed, 0–100 — the matrix's horizontal line. */
export function portfolioMarginPct(clients: ReadonlyArray<Pick<ExecClientRow, 'billed' | 'margin'>>): number | null {
  const billed = clients.reduce((s, c) => s + c.billed, 0);
  if (billed <= 0) return null;
  return (clients.reduce((s, c) => s + c.margin, 0) / billed) * 100;
}

/** +42 · −8 · 0 — a net promoter score with its sign. */
export function fmtNps(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  const r = Math.round(n);
  return r > 0 ? `+${r}` : r < 0 ? `−${Math.abs(r)}` : '0';
}
