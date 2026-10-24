import { useCallback } from 'react';
import type { Tone } from '../palette';
import { EChart } from './EChart';
import { esc, tooltipBase, withAlpha, type EChartColors } from './colors';
import type { EChartsCoreOption } from './engine';

/**
 * A year at a glance: one cell per day, darker for more — call-outs,
 * no-shows, late arrivals. Five steps: zero is the empty cell, then four
 * strengths of the tone's colour, cut at even fractions of the busiest day.
 */
export interface CalendarDay {
  /** YYYY-MM-DD, already in the company's (or the store's) calendar. */
  date: string;
  value: number;
}

export interface CalendarHeatmapProps {
  days: CalendarDay[];
  /** First and last day drawn, YYYY-MM-DD inclusive. */
  from: string;
  to: string;
  /** What the cells count, for the tooltip: "call-outs". */
  unit: string;
  /** The singular, for a day of exactly one: "call-out". Defaults to `unit`. */
  unitOne?: string;
  tone?: Tone;
  /** First day of the week, 0 = Sunday … 6 = Saturday (the store week starts Saturday). */
  firstDay?: number;
  format?: (n: number) => string;
  height?: number;
}

const plain = (n: number) => n.toLocaleString();

function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/** Every day from `from` to `to`, zero where `days` has nothing. */
export function fillDays(days: CalendarDay[], from: string, to: string): Array<[string, number]> {
  const byDay = new Map(days.map((d) => [d.date, d.value]));
  const out: Array<[string, number]> = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push([d, byDay.get(d) ?? 0]);
  return out;
}

/** The four non-zero steps' upper bounds: 1,2,3,4+ for a quiet year; even quarters of the busiest day otherwise. */
export function steps(max: number): [number, number, number] {
  if (max <= 4) return [1, 2, 3];
  const q = (f: number) => Math.max(1, Math.ceil(max * f));
  const a = q(0.25);
  const b = Math.max(a + 1, q(0.5));
  const c = Math.max(b + 1, q(0.75));
  return [a, b, c];
}

const toneOf = (tone: Tone, c: EChartColors) =>
  tone === 'bad' ? c.bad : tone === 'warn' ? c.warn : tone === 'good' ? c.good : tone === 'neutral' ? c.muted : c.series[0]!;

function longDate(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

export function calendarOption(
  days: CalendarDay[],
  range: { from: string; to: string },
  c: EChartColors,
  opts: { unit: string; unitOne?: string; tone?: Tone; firstDay?: number; format?: (n: number) => string },
): EChartsCoreOption {
  const data = fillDays(days, range.from, range.to);
  const max = data.reduce((m, [, v]) => Math.max(m, v), 0);
  const [a, b, d] = steps(max);
  const hue = toneOf(opts.tone ?? 'primary', c);
  const fmt = opts.format ?? plain;
  const range4 = (lo: number, hi: number) => (hi === lo ? fmt(lo) : `${fmt(lo)}–${fmt(hi)}`);
  return {
    textStyle: { fontFamily: c.font },
    tooltip: {
      ...tooltipBase(c),
      trigger: 'item',
      formatter: (p: { data: [string, number] }) =>
        `${esc(longDate(p.data[0]))}<br/><b>${esc(fmt(p.data[1]))}</b> ${esc(p.data[1] === 1 ? (opts.unitOne ?? opts.unit) : opts.unit)}`,
    },
    visualMap: {
      type: 'piecewise',
      orient: 'horizontal',
      right: 4,
      bottom: 0,
      itemWidth: 11,
      itemHeight: 11,
      itemGap: 3,
      itemSymbol: 'rect',
      selectedMode: false,
      showLabel: false,
      text: ['More', 'Less'],
      textGap: 6,
      textStyle: { color: c.muted, fontSize: 11, fontFamily: c.font },
      // gte/lte, not min/max: ECharts reads a lone `min` as exclusive, so
      // `{ min: 10 }` left a day of exactly 10 matching no step — undrawn.
      pieces: [
        { gte: 0, lte: 0, color: withAlpha(c.grid, 0.9), label: fmt(0) },
        { gte: 1, lte: a, color: withAlpha(hue, 0.3), label: range4(1, a) },
        { gte: a + 1, lte: b, color: withAlpha(hue, 0.5), label: range4(a + 1, b) },
        { gte: b + 1, lte: d, color: withAlpha(hue, 0.75), label: range4(b + 1, d) },
        { gte: d + 1, color: hue, label: `${fmt(d + 1)}+` },
      ],
    },
    calendar: {
      range: [range.from, range.to],
      top: 22,
      left: 30,
      right: 6,
      bottom: 26,
      cellSize: ['auto', 'auto'],
      orient: 'horizontal',
      splitLine: { show: false },
      itemStyle: { color: 'transparent', borderColor: c.surface, borderWidth: 3 },
      yearLabel: { show: false },
      monthLabel: { color: c.muted, fontSize: 11, fontFamily: c.font, nameMap: 'EN' },
      dayLabel: { firstDay: opts.firstDay ?? 0, color: c.muted, fontSize: 10, fontFamily: c.font, nameMap: ['S', 'M', 'T', 'W', 'T', 'F', 'S'] },
    },
    series: [
      {
        type: 'heatmap',
        coordinateSystem: 'calendar',
        data,
        itemStyle: { borderColor: c.surface, borderWidth: 2, borderRadius: 2 },
        emphasis: { itemStyle: { borderColor: c.ink, borderWidth: 1 } },
      },
    ],
  };
}

export function CalendarHeatmap({ days, from, to, unit, unitOne, tone, firstDay, format, height }: CalendarHeatmapProps) {
  const build = useCallback(
    (c: EChartColors) => calendarOption(days, { from, to }, c, { unit, unitOne, tone, firstDay, format }),
    [days, from, to, unit, unitOne, tone, firstDay, format],
  );
  return <EChart build={build} height={height ?? 190} />;
}
