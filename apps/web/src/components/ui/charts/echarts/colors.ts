import { tokenColor } from '@/lib/tokenColor';

/**
 * The kit's palette (../palette) as concrete colours. ECharts computes with
 * its colours — gradients, hover tints, a visual map's ramp — so it needs
 * `rgb(r, g, b)`, not `rgb(var(--color-chart-1))`. Resolved from <html> at
 * draw time and again whenever the theme flips (EChart watches data-theme).
 */
export interface EChartColors {
  /** chart-1…5 in the validated order; a sixth category folds into `other`. */
  series: readonly string[];
  other: string;
  good: string;
  warn: string;
  bad: string;
  info: string;
  /** Primary text. */
  ink: string;
  /** Labels, axis text. */
  muted: string;
  /** Hairlines, empty cells. */
  grid: string;
  /** The card the figure sits on. */
  surface: string;
  font: string;
}

const FONT = '"Geist Variable", Geist, Inter, system-ui, -apple-system, sans-serif';

export function resolveChartColors(): EChartColors {
  return {
    series: [tokenColor('chart-1'), tokenColor('chart-2'), tokenColor('chart-3'), tokenColor('chart-4'), tokenColor('chart-5')],
    other: tokenColor('chart-other'),
    good: tokenColor('success'),
    warn: tokenColor('warning'),
    bad: tokenColor('alert'),
    info: tokenColor('steel'),
    ink: tokenColor('fg'),
    muted: tokenColor('silver'),
    grid: tokenColor('navy-secondary'),
    surface: tokenColor('navy'),
    font: FONT,
  };
}

/** `rgb(r, g, b)` → `rgba(r, g, b, a)`. */
export function withAlpha(color: string, alpha: number): string {
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color);
  return m ? `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${alpha})` : color;
}

/** `a` moved toward `b` by `t` (0 = a, 1 = b), both `rgb(r, g, b)`. */
export function mix(a: string, b: string, t: number): string {
  const pa = /(\d+),\s*(\d+),\s*(\d+)/.exec(a);
  const pb = /(\d+),\s*(\d+),\s*(\d+)/.exec(b);
  if (!pa || !pb) return a;
  const ch = (i: number) => Math.round(Number(pa[i]) + (Number(pb[i]) - Number(pa[i])) * t);
  return `rgb(${ch(1)}, ${ch(2)}, ${ch(3)})`;
}

/** The tooltip every ECharts figure wears — the same card as ChartTooltipContent. */
export function tooltipBase(c: EChartColors) {
  return {
    backgroundColor: c.surface,
    borderColor: c.grid,
    borderWidth: 1,
    padding: [6, 10],
    textStyle: { color: c.ink, fontSize: 12, fontFamily: c.font },
    extraCssText: 'border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.25);',
    confine: true,
  } as const;
}

/** Text inside a figure is escaped by hand: ECharts tooltips are HTML. */
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}
