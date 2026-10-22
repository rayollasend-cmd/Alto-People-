/**
 * The one chart palette. Every figure in the app — dashboards, the portal,
 * finance, the books — draws from these, so a series looks the same
 * wherever it shows up and follows light/dark with the theme (each value
 * is a CSS variable, redefined under [data-theme='light'] in index.css).
 *
 * - `series` is the validated categorical order (chart-1…5: gold, blue,
 *   teal, violet, magenta). Checked as a set on navy and on white:
 *   lightness band, chroma floor, adjacent CVD ΔE ≥ 13, ≥ 3:1 contrast.
 *   Assign in this order and never cycle — a sixth series folds into
 *   "Other" (`PALETTE.other`) or the chart splits.
 * - `good` / `warn` / `bad` are reserved for state, never "series 4".
 * - Text never wears a series color: ticks and labels use `tick`.
 */

const token = (name: string, alpha?: number) =>
  alpha === undefined ? `rgb(var(--color-${name}))` : `rgb(var(--color-${name}) / ${alpha})`;

export const PALETTE = {
  series: [token('chart-1'), token('chart-2'), token('chart-3'), token('chart-4'), token('chart-5')] as const,
  primary: token('chart-1'),
  secondary: token('chart-2'),
  tertiary: token('chart-3'),
  /** The fold-in color for "Other" and for a comparison/background series —
   *  a solid token per theme, ≥ 3:1 on its surface (a translucent silver
   *  fell to 2.3:1 on white). */
  other: token('chart-other'),
  good: token('success'),
  warn: token('warning'),
  bad: token('alert'),
  info: token('steel'),
  /** Hairline grid, one step off the surface. */
  grid: token('navy-secondary'),
  axis: token('silver'),
  /** Reference / target lines. */
  ref: token('silver', 0.55),
  surface: token('navy'),
  /** Hover band behind a bar group. */
  cursor: token('navy-secondary', 0.35),
  muted: token('silver', 0.35),
} as const;

/**
 * One colour per staffing concept, in every chart (the portal's coverage
 * curve drew Scheduled in gold while its hours chart drew it in blue, with
 * gold meaning Delivered). Scheduled — and filled, which is scheduled
 * people — is the primary series; delivered/worked the second; unfilled
 * the alert state; the contract or target a reference line.
 */
export const CONCEPT = {
  scheduled: PALETTE.primary,
  delivered: PALETTE.secondary,
  unfilled: PALETTE.bad,
  target: PALETTE.ref,
} as const;

/** Category color by position — the fixed order, folding past the fifth. */
export function seriesColor(i: number): string {
  return PALETTE.series[i] ?? PALETTE.other;
}

/**
 * For older figures indexed past the fifth category: the five hues, then
 * "Other" — never a sixth hue, and never a repeat of one of the five (the
 * steel blue in slot 6 was slot 2's twin in light mode). Fold the sixth
 * category and beyond into one "Other" (see `foldToOther`).
 */
export const EXTENDED_SERIES = [...PALETTE.series, PALETTE.other, PALETTE.other, PALETTE.other] as const;

/**
 * Keeps the first `keep` items and sums the rest into one "Other" row, so a
 * categorical chart never runs out of distinct hues.
 */
export function foldToOther<T extends { name: string; value: number }>(items: T[], keep = 5, otherName = 'Other'): Array<T | { name: string; value: number; color: string }> {
  if (items.length <= keep + 1) return items;
  const rest = items.slice(keep).reduce((s, d) => s + d.value, 0);
  return [...items.slice(0, keep), { name: otherName, value: rest, color: PALETTE.other }];
}

/** Axis tick text: the muted text token, never a series color. */
export const TICK = { fill: token('silver', 0.75), fontSize: 11 } as const;

/** recharts `contentStyle` for the stock tooltip, matched to ChartTooltipContent. */
export const TOOLTIP_STYLE = {
  background: token('navy'),
  border: `1px solid ${token('navy-secondary')}`,
  borderRadius: 8,
  fontSize: 12,
  color: token('fg'),
  boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
} as const;

export const TOOLTIP_LABEL_STYLE = { color: token('silver'), marginBottom: 2 } as const;

/** recharts `itemStyle`: the stock tooltip colors each row in its series
 *  color (gold text at 3.2:1 on white) — rows read in the text color. */
export const TOOLTIP_ITEM_STYLE = { color: token('fg'), padding: '1px 0' } as const;

export type Tone = 'primary' | 'good' | 'warn' | 'bad' | 'neutral';

export function toneColor(tone: Tone): string {
  return tone === 'good' ? PALETTE.good : tone === 'warn' ? PALETTE.warn : tone === 'bad' ? PALETTE.bad : tone === 'neutral' ? PALETTE.axis : PALETTE.primary;
}
