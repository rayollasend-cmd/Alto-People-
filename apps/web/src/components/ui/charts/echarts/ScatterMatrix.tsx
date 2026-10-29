import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { LegendKey } from '../ChartTooltip';
import { EChart } from './EChart';
import { esc, tooltipBase, withAlpha, type EChartColors } from './colors';
import type { EChartsCoreOption } from './engine';

/**
 * Two measures against each other, one bubble per thing (2026-10-27): the
 * chairman's client matrix — period billed across, margin rate up, bubble
 * area by people placed, colour by health. Dashed lines split the field
 * into quadrants at the portfolio's middle (or where the caller says) and
 * each corner names what it means in muted words ("High margin, small"),
 * so the picture reads without a legend lecture. Every bubble carries its
 * name where there is room for it; a tap on one opens it.
 *
 * Health is a status, so it wears the palette's status scale steps (the
 * 700 dots the rest of the app uses), resolved from the theme at draw time
 * — never a series hue. ECharts draws in SVG (./setup) with only the
 * scatter and its grid registered: the axes' bounds are set here, so the
 * quadrant lines and words are plain HTML laid over the same box (no
 * markLine), and names are placed here clear of each other (no label-layout
 * module) — the engine chunk stays inside its budget.
 */

export type ScatterTone = 'good' | 'watch' | 'bad' | 'none';

export interface ScatterPoint {
  id: string;
  name: string;
  x: number;
  y: number;
  /** The bubble's area is proportional to this (people placed). */
  size: number;
  tone: ScatterTone;
}

export interface ScatterQuadrants {
  topLeft: string;
  topRight: string;
  bottomLeft: string;
  bottomRight: string;
}

export interface ScatterMatrixProps {
  points: ScatterPoint[];
  /** Axis and tooltip names: "Billed", "Margin", "People". */
  xName: string;
  yName: string;
  sizeName: string;
  formatX?: (n: number) => string;
  formatY?: (n: number) => string;
  formatSize?: (n: number) => string;
  /** Tick labels, when they read better shorter than the tooltip's figures ("$20k", "18%"). */
  axisX?: (n: number) => string;
  axisY?: (n: number) => string;
  /** The legend's words for each tone ("Good", "Watch", "At risk", "Not rated"); left out, no legend. */
  toneWords?: Record<ScatterTone, string>;
  /** "Bubble size: people placed" — printed beside the legend. */
  sizeNote?: string;
  /** Where the quadrants divide. Default: the middle of the points on each axis. */
  split?: { x: number; y: number };
  quadrants?: ScatterQuadrants;
  onPointClick?: (id: string) => void;
  height?: number;
  /** Shown instead below SCATTER_MIN_POINTS: two dots on an axis say less than a sentence. Left out, a short list. */
  few?: (points: ScatterPoint[]) => ReactNode;
}

/** Below this many points a matrix is a list, not a picture. */
export const SCATTER_MIN_POINTS = 3;

/** The bubble diameters, px: area proportional to size, the largest at `max`, nothing smaller than `min`. */
export function bubbleSizes(sizes: ReadonlyArray<number>, min = 12, max = 46): number[] {
  const top = Math.max(0, ...sizes.filter((s) => Number.isFinite(s)));
  return sizes.map((s) => {
    if (!(top > 0) || !Number.isFinite(s) || s <= 0) return min;
    return Math.max(min, Math.sqrt(s / top) * max);
  });
}

/** The middle of a list (the median), for a quadrant split. */
export function middleOf(values: ReadonlyArray<number>): number {
  const v = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (v.length === 0) return 0;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m]! : (v[m - 1]! + v[m]!) / 2;
}

/** A round step for a span: 1, 2, 2.5 or 5 times a power of ten, about a fifth of it. */
function niceStep(span: number): number {
  if (!(span > 0)) return 1;
  const raw = span / 5;
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
}

export interface ScatterFrame {
  x: [number, number];
  y: [number, number];
  split: { x: number; y: number };
}

/**
 * The field the bubbles sit in: x from zero, y around the data, both padded
 * so no bubble lands in a corner (where the quadrant words are) and rounded
 * to a step — and where the quadrant lines cross. Pure: the option and the
 * HTML overlay both read it, so the lines sit exactly on the axes' values.
 */
export function scatterFrame(points: ReadonlyArray<ScatterPoint>, split?: { x: number; y: number }): ScatterFrame {
  const xs = points.map((p) => p.x).filter((n) => Number.isFinite(n));
  const ys = points.map((p) => p.y).filter((n) => Number.isFinite(n));
  const xTop = Math.max(0, ...xs) * 1.16 || 1;
  const xStep = niceStep(xTop);
  const lo = ys.length ? Math.min(...ys) : 0;
  const hi = ys.length ? Math.max(...ys) : 1;
  const pad = Math.max((hi - lo) * 0.22, 2);
  const yStep = niceStep(hi - lo + pad * 2);
  const s = split ?? { x: middleOf(xs), y: middleOf(ys) };
  return {
    x: [0, Math.ceil(xTop / xStep) * xStep],
    y: [Math.floor((lo - pad) / yStep) * yStep, Math.ceil((hi + pad) / yStep) * yStep],
    split: s,
  };
}

export type ToneColors = Record<ScatterTone, string>;

/** The status scale's 700 steps, dark-theme values for when no stylesheet is there to read (tests). */
const TONE_VAR: Record<ScatterTone, [string, string]> = {
  good: ['positive-700', '55 166 112'],
  watch: ['caution-700', '214 127 1'],
  bad: ['negative-700', '242 103 95'],
  none: ['neutral-500', '91 103 127'],
};

/** The tone colours as `rgb(r, g, b)`, read off <html> so they follow the theme. */
export function resolveToneColors(): ToneColors {
  const style = typeof document !== 'undefined' && typeof getComputedStyle === 'function' ? getComputedStyle(document.documentElement) : null;
  const triple = /^(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})$/;
  const read = ([name, fallback]: [string, string]) => {
    let raw: string;
    try {
      raw = style?.getPropertyValue(`--color-${name}`).trim() ?? '';
    } catch {
      raw = '';
    }
    const m = triple.exec(raw) ?? triple.exec(fallback)!;
    return `rgb(${m[1]}, ${m[2]}, ${m[3]})`;
  };
  return { good: read(TONE_VAR.good), watch: read(TONE_VAR.watch), bad: read(TONE_VAR.bad), none: read(TONE_VAR.none) };
}

/** The tone colours as live CSS, for the HTML legend. */
const TONE_CSS: ToneColors = {
  good: 'rgb(var(--color-positive-700))',
  watch: 'rgb(var(--color-caution-700))',
  bad: 'rgb(var(--color-negative-700))',
  none: 'rgb(var(--color-neutral-500))',
};

const plain = (n: number) => n.toLocaleString();

/** The grid's margins, px — the quadrant lines and words are laid over the same box. */
export const SCATTER_GRID = { left: 64, right: 24, top: 20, bottom: 48 } as const;

/** The plot box the names are placed in when the figure hasn't been measured (a test), px. */
const PLOT = { w: 440, h: 300 } as const;
export type PlotBox = { w: number; h: number };
const CHAR_PX = 6.2;
const LINE_PX = 14;

type LabelSide = 'right' | 'left' | 'top' | 'bottom';

/**
 * Where each bubble's name goes, largest bubble first: on its right (its
 * left past the right third, so it never runs off the figure), else the
 * other side, above or below — whichever clears the names and bubbles
 * already placed. A name with no clear place is left to the tooltip and the
 * table: an overprinted name reads as neither.
 */
export function placeLabels(points: ReadonlyArray<ScatterPoint>, sizes: ReadonlyArray<number>, frame: ScatterFrame, plot: PlotBox = PLOT): Array<LabelSide | null> {
  const px = (p: ScatterPoint) => ((p.x - frame.x[0]) / (frame.x[1] - frame.x[0] || 1)) * plot.w;
  const py = (p: ScatterPoint) => (1 - (p.y - frame.y[0]) / (frame.y[1] - frame.y[0] || 1)) * plot.h;
  type Box = [number, number, number, number];
  const hit = (a: Box, b: Box) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
  const taken: Box[] = points.map((p, i) => {
    const r = sizes[i]! / 2;
    return [px(p) - r, py(p) - r, px(p) + r, py(p) + r];
  });
  const order = points.map((_, i) => i).sort((a, b) => sizes[b]! - sizes[a]!);
  const out: Array<LabelSide | null> = points.map(() => null);
  for (const i of order) {
    const p = points[i]!;
    const r = sizes[i]! / 2 + 5;
    const w = p.name.length * CHAR_PX;
    const x = px(p);
    const y = py(p);
    const box: Record<LabelSide, Box> = {
      right: [x + r, y - LINE_PX / 2, x + r + w, y + LINE_PX / 2],
      left: [x - r - w, y - LINE_PX / 2, x - r, y + LINE_PX / 2],
      top: [x - w / 2, y - r - LINE_PX, x + w / 2, y - r],
      bottom: [x - w / 2, y + r, x + w / 2, y + r + LINE_PX],
    };
    const first: LabelSide = x / plot.w > 0.7 ? 'left' : 'right';
    const sides: LabelSide[] = [first, first === 'right' ? 'left' : 'right', 'top', 'bottom'];
    const fits = (s: LabelSide) => {
      const b = box[s];
      if (b[0] < -LINE_PX || b[2] > plot.w + LINE_PX || b[1] < 0 || b[3] > plot.h) return false;
      return taken.every((t, j) => j === i || !hit(b, t));
    };
    const side = sides.find(fits) ?? null;
    out[i] = side;
    if (side) taken.push(box[side]);
  }
  return out;
}

export interface ScatterOptionOpts {
  xName: string;
  yName: string;
  sizeName: string;
  formatX?: (n: number) => string;
  formatY?: (n: number) => string;
  formatSize?: (n: number) => string;
  axisX?: (n: number) => string;
  axisY?: (n: number) => string;
  toneWords?: Record<ScatterTone, string>;
  split?: { x: number; y: number };
  /** The measured plot box, so names are placed for the room there is (a phone's is half a desktop's). */
  plot?: PlotBox;
}

export function scatterOption(points: ReadonlyArray<ScatterPoint>, c: EChartColors, tones: ToneColors, opts: ScatterOptionOpts): EChartsCoreOption {
  const fx = opts.formatX ?? plain;
  const fy = opts.formatY ?? plain;
  const fs = opts.formatSize ?? plain;
  const ax = opts.axisX ?? fx;
  const ay = opts.axisY ?? fy;
  const sizes = bubbleSizes(points.map((p) => p.size));
  const frame = scatterFrame(points, opts.split);
  const sides = placeLabels(points, sizes, frame, opts.plot);
  const axisText = { color: c.muted, fontSize: 11, fontFamily: c.font };
  const axis = {
    nameLocation: 'middle',
    nameTextStyle: axisText,
    axisLabel: axisText,
    axisLine: { show: true, lineStyle: { color: c.grid } },
    axisTick: { show: false },
    splitLine: { lineStyle: { color: c.grid } },
  } as const;
  // Largest first, so a small bubble is never hidden under a big one.
  const order = points.map((p, i) => ({ p, s: sizes[i]!, side: sides[i]! })).sort((a, b) => b.s - a.s);
  return {
    textStyle: { fontFamily: c.font },
    grid: { ...SCATTER_GRID },
    tooltip: {
      ...tooltipBase(c),
      trigger: 'item',
      formatter: (p: { data?: { name?: string; value?: [number, number, number]; tone?: ScatterTone } }) => {
        const d = p.data;
        if (!d?.value) return '';
        const [x, y, size] = d.value;
        const tone = d.tone && opts.toneWords ? ` · ${esc(opts.toneWords[d.tone])}` : '';
        return `<b>${esc(d.name ?? '')}</b>${tone}<br/>${esc(opts.xName)}: ${esc(fx(x))}<br/>${esc(opts.yName)}: ${esc(fy(y))}<br/>${esc(opts.sizeName)}: ${esc(fs(size))}`;
      },
    },
    xAxis: { ...axis, type: 'value', name: opts.xName, nameGap: 30, min: frame.x[0], max: frame.x[1], axisLabel: { ...axisText, formatter: (v: number) => ax(v) } },
    yAxis: { ...axis, type: 'value', name: opts.yName, nameGap: 46, min: frame.y[0], max: frame.y[1], axisLabel: { ...axisText, formatter: (v: number) => ay(v) } },
    series: [
      {
        type: 'scatter',
        data: order.map(({ p, s, side }) => ({
          id: p.id,
          name: p.name,
          tone: p.tone,
          value: [p.x, p.y, p.size],
          symbolSize: s,
          label: side ? { show: true, position: side } : { show: false },
          itemStyle: { color: withAlpha(tones[p.tone], 0.72), borderColor: tones[p.tone], borderWidth: 1.5 },
        })),
        label: { show: true, distance: 6, formatter: '{b}', color: c.ink, fontSize: 11, fontFamily: c.font },
        emphasis: { scale: 1.08, label: { show: true, fontWeight: 600 } },
      },
    ],
  };
}

/** A point of the field as a CSS offset inside the chart box (the grid's margins in px, the rest a share). */
const along = (from: number, to: number, v: number) => Math.max(0, Math.min(1, (v - from) / (to - from || 1)));

/** The box's size, px, in 16px steps (a resize redraws the names only when it matters); null until measured. */
function useBoxSize(active: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<PlotBox | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => {
      const r = e?.contentRect;
      if (!r || r.width === 0) return;
      const next = { w: Math.round(r.width / 16) * 16, h: Math.round(r.height / 16) * 16 };
      setSize((prev) => (prev && prev.w === next.w && prev.h === next.h ? prev : next));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [active]);
  return { ref, size };
}

export function ScatterMatrix({ points, xName, yName, sizeName, formatX, formatY, formatSize, axisX, axisY, toneWords, sizeNote, split, quadrants, onPointClick, height, few }: ScatterMatrixProps) {
  const box = useBoxSize(points.length >= SCATTER_MIN_POINTS);
  const g0 = SCATTER_GRID;
  const plot = useMemo(() => (box.size ? { w: Math.max(80, box.size.w - g0.left - g0.right), h: Math.max(80, box.size.h - g0.top - g0.bottom) } : undefined), [box.size, g0]);
  const build = useCallback(
    (c: EChartColors) => scatterOption(points, c, resolveToneColors(), { xName, yName, sizeName, formatX, formatY, formatSize, axisX, axisY, toneWords, split, plot }),
    [points, xName, yName, sizeName, formatX, formatY, formatSize, axisX, axisY, toneWords, split, plot],
  );
  const frame = useMemo(() => scatterFrame(points, split), [points, split]);
  const onClick = useCallback(
    (p: { data?: unknown }) => {
      const id = (p.data as { id?: string } | undefined)?.id;
      if (id && onPointClick) onPointClick(id);
    },
    [onPointClick],
  );
  if (points.length < SCATTER_MIN_POINTS) {
    if (few) return <>{few(points)}</>;
    return (
      <ul className="space-y-1.5 text-sm" data-testid="scatter-few">
        {points.map((p) => (
          <li key={p.id} className="flex flex-wrap items-baseline justify-between gap-x-3">
            <span className="min-w-0 text-ink">{p.name}</span>
            <span className="tabular-nums text-ink-muted">
              {(formatX ?? plain)(p.x)} · {(formatY ?? plain)(p.y)}
            </span>
          </li>
        ))}
      </ul>
    );
  }
  const used = (['good', 'watch', 'bad', 'none'] as const).filter((t) => points.some((p) => p.tone === t));
  // On the card's own surface, so a quadrant line passes behind a word, not through it.
  const corner = 'pointer-events-none absolute max-w-[40%] truncate rounded-sm bg-surface px-1 text-2xs text-ink-muted';
  const g = SCATTER_GRID;
  const fx = along(frame.x[0], frame.x[1], frame.split.x);
  const fy = 1 - along(frame.y[0], frame.y[1], frame.split.y);
  return (
    <div className="flex h-full w-full flex-col" data-testid="scatter-matrix">
      <div ref={box.ref} className="relative min-h-0 flex-1" style={height ? { height } : undefined}>
        {/* Under the drawing (its SVG is transparent), so a bubble always sits on top of a line or a word. */}
        <div aria-hidden="true" data-testid="scatter-quadrants">
          <div className="pointer-events-none absolute w-0 border-l border-dashed border-line-strong" style={{ top: g.top, bottom: g.bottom, left: `calc(${g.left}px + (100% - ${g.left + g.right}px) * ${fx.toFixed(4)})` }} data-split="x" />
          <div className="pointer-events-none absolute h-0 border-t border-dashed border-line-strong" style={{ left: g.left, right: g.right, top: `calc(${g.top}px + (100% - ${g.top + g.bottom}px) * ${fy.toFixed(4)})` }} data-split="y" />
          {quadrants && (
            <>
              <span className={corner} style={{ left: g.left + 8, top: g.top + 4 }}>
                {quadrants.topLeft}
              </span>
              <span className={`${corner} text-right`} style={{ right: g.right + 8, top: g.top + 4 }}>
                {quadrants.topRight}
              </span>
              <span className={corner} style={{ left: g.left + 8, bottom: g.bottom + 4 }}>
                {quadrants.bottomLeft}
              </span>
              <span className={`${corner} text-right`} style={{ right: g.right + 8, bottom: g.bottom + 4 }}>
                {quadrants.bottomRight}
              </span>
            </>
          )}
        </div>
        <EChart build={build} onClick={onPointClick ? onClick : undefined} className="h-full" height={height} />
      </div>
      {(toneWords || sizeNote) && (
        <div className="mt-1 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          {toneWords && <LegendKey items={used.map((t) => ({ name: toneWords[t], color: TONE_CSS[t] }))} />}
          {sizeNote && <span className="text-2xs text-ink-muted">{sizeNote}</span>}
        </div>
      )}
    </div>
  );
}
