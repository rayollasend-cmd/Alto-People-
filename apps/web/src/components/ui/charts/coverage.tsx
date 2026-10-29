import { useState } from 'react';
import { cn } from '@/lib/cn';
import { LegendKey } from './ChartTooltip';
import { lazyPlot } from './lazyPlot';
import { CONCEPT, PALETTE } from './palette';

/** The drawings (recharts) load with the first chart, not the page (lazyPlot). */
const CoverageCurvePlot = lazyPlot(() => import('./coverage.plot').then((m) => ({ default: m.CoverageCurvePlot })));
const WeekFillPlot = lazyPlot(() => import('./coverage.plot').then((m) => ({ default: m.WeekFillPlot })));
const ReliabilityPlot = lazyPlot(() => import('./coverage.plot').then((m) => ({ default: m.ReliabilityPlot })));
const HoursPlot = lazyPlot(() => import('./coverage.plot').then((m) => ({ default: m.HoursPlot })));
const StoreBarPlot = lazyPlot(() => import('./coverage.plot').then((m) => ({ default: m.StoreBarPlot })));

/**
 * Staffing figures shared by the store portal, the supervisor and region
 * homes and the scheduler: thin marks, 4px rounded data-ends, hairline
 * grid one step off the surface, a 2px surface gap between touching
 * fills, a tooltip on every mark and a legend for two or more series.
 */

const SERIES = { primary: PALETTE.primary, secondary: PALETTE.secondary, tertiary: PALETTE.tertiary } as const;
const STATUS = { good: PALETTE.good, warn: PALETTE.warn, bad: PALETTE.bad } as const;

/**
 * A y-domain that always has a scale: zero to a rounded-up 15% above the
 * highest of the peak, the target and 1. With every value zero, recharts
 * gave a stacked chart no scale at all (no ticks, no contract line, no
 * "Now"); an explicit domain with allowDataOverflow keeps the axis, and
 * the domain is built to cover the data, so nothing is ever clipped.
 */
export function coverageDomain(peak: number, target: number | null = null): [number, number] {
  const top = Math.max(target ?? 0, peak, 1) * 1.15;
  // A multiple of 4, so recharts' five whole-number ticks are evenly spaced (0 3 6 9 12, not 0 3 6 10).
  return [0, Math.ceil(top / 4) * 4];
}

/**
 * A "nice" axis for a measured quantity (hours): zero to a round top with
 * evenly spaced round ticks — 0/25/50/75/100, never 0/25/50/88 (deep audit
 * LEAD-26: the hours chart's domain top, 88, was drawn as the last tick).
 * The top clears the peak by 15%, like coverageDomain; steps are 1, 2, 2.5
 * or 5 × a power of ten, at least 1 (whole hours).
 */
export function niceAxis(peak: number, segments = 4): { domain: [number, number]; ticks: number[] } {
  const top = Math.max(peak, 1) * 1.15;
  const raw = top / segments;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw - 1e-9) ?? 10 * mag);
  const n = Math.ceil(top / step - 1e-9);
  const ticks = Array.from({ length: n + 1 }, (_, i) => Math.round(i * step * 100) / 100);
  return { domain: [0, ticks[ticks.length - 1]!], ticks };
}

/* ---- Coverage curve: headcount by hour today vs the contracted line ---- */

export interface HourPoint {
  hour: number;
  label: string;
  scheduled: number;
  open: number;
}

export function CoverageCurve({
  points,
  target,
  nowHour,
  labels,
  bands = [],
}: {
  points: HourPoint[];
  target: number | null;
  /** Current hour in the store's zone, 0–23; null when today is over. */
  nowHour: number | null;
  labels: {
    scheduled: string;
    open: string;
    contracted: string;
    now: string;
    at: (h: string) => string;
    /** Said over the plot when every hour is zero ("Nothing scheduled today"). */
    empty?: string;
  };
  /** Hours to shade — a supervisor's own shift inside the store's day.
   *  Site-local minutes; end <= start wraps past midnight. */
  bands?: Array<{ startMinute: number; endMinute: number; label: string }>;
}) {
  const peak = Math.max(0, ...points.map((p) => p.scheduled + p.open));
  const nowLabel = nowHour !== null ? points[nowHour]?.label : undefined;
  return (
    <div>
      <div className="relative h-40 w-full sm:h-48">
        {peak === 0 && labels.empty && (
          <div className="pointer-events-none absolute inset-x-0 top-1/2 z-10 -translate-y-1/2 text-center" data-chart-empty="">
            <span className="rounded-md bg-navy/90 px-2 py-0.5 text-sm text-silver">{labels.empty}</span>
          </div>
        )}
        <CoverageCurvePlot points={points} target={target} nowLabel={nowLabel} labels={labels} bands={bands} domain={coverageDomain(peak, target)} />
      </div>
      <div className="mt-1 flex items-center justify-between gap-3">
        <LegendKey
          items={[
            { name: labels.scheduled, color: CONCEPT.scheduled },
            { name: labels.open, color: CONCEPT.unfilled },
            ...(target !== null ? [{ name: labels.contracted, color: CONCEPT.target, line: true }] : []),
          ]}
        />
      </div>
    </div>
  );
}

/* ---- Week fill: stacked columns per day, filled vs open ---------------- */

export function WeekFillChart({
  days,
  todayKey,
  labels,
}: {
  days: Array<{ date: string; day: string; filled: number; open: number }>;
  todayKey: string;
  labels: { filled: string; open: string; heading: (d: string) => string };
}) {
  const peak = Math.max(0, ...days.map((d) => d.filled + d.open));
  return (
    <div>
      <div className="h-40 w-full">
        <WeekFillPlot days={days} todayKey={todayKey} labels={labels} domain={coverageDomain(peak)} />
      </div>
      <div className="mt-1">
        <LegendKey
          items={[
            { name: labels.filled, color: CONCEPT.scheduled },
            { name: labels.open, color: CONCEPT.unfilled },
          ]}
        />
      </div>
    </div>
  );
}

/* ---- Reliability: fill % per week with the 95% line ------------------- */

export function ReliabilityChart({
  weeks,
  labels,
}: {
  weeks: Array<{ start: string; label: string; reliabilityPct: number | null; current: boolean }>;
  labels: { fill: string; target: string; heading: (w: string) => string };
}) {
  return (
    <div className="h-36 w-full">
      <ReliabilityPlot weeks={weeks} labels={labels} />
    </div>
  );
}

/* ---- Coverage heatmap: the week, one row per day, one cell per hour ---- */

export interface HeatDay {
  date: string;
  label: string;
  /** 24 entries: scheduled headcount at the top of each hour. */
  scheduled: number[];
  /** 24 entries: unfilled slots at the top of each hour. */
  open: number[];
  /**
   * Optional, 24 entries: the contracted headcount at the top of each hour
   * (0 outside every contracted window). When given, every contracted hour
   * below it is marked — also an hour with nothing scheduled, which the
   * single `target` couldn't tell from an hour nobody contracted.
   */
  target?: number[];
}

/**
 * Sequential single hue (the series step) — more people, darker cell;
 * an unfilled slot is a dot in the reserved alert color; an hour below
 * the contracted headcount gets a hairline underline. Every cell carries
 * a native tooltip and the table twin lives behind Details.
 */
export function CoverageHeatmap({
  days,
  target,
  todayKey,
  labels,
}: {
  days: HeatDay[];
  target: number | null;
  todayKey: string;
  labels: {
    cell: (day: string, hour: string, scheduled: number, open: number) => string;
    scale: { low: string; high: string };
    unfilled: string;
    belowTarget: string;
    /** Phone hint under the grid ("swipe for later hours"). */
    swipe?: string;
  };
}) {
  const max = Math.max(1, ...days.flatMap((d) => d.scheduled));
  // A tapped cell reads its numbers out below the grid — hover tooltips
  // never fire on touch, so this is the phone path to the exact figure.
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <div>
      <div className="relative">
        <div className="overflow-x-auto">
          <div className="min-w-[36rem]">
            <div className="grid" style={{ gridTemplateColumns: '2.75rem repeat(24, minmax(0, 1fr))' }}>
              <div className="sticky left-0 z-10 bg-navy" />
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} className="pb-1 text-center text-2xs text-silver/60">
                {h % 3 === 0 ? hourLabelShort(h) : ''}
              </div>
            ))}
            {days.map((d) => (
              <DayRow
                key={d.date}
                day={d}
                max={max}
                target={target}
                isToday={d.date === todayKey}
                labels={labels}
                onPick={(text) => setPicked((cur) => (cur === text ? null : text))}
              />
            ))}
            </div>
          </div>
        </div>
        <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-navy to-transparent sm:hidden" />
      </div>
      <div className={cn('mt-1 min-h-5 text-xs transition-opacity', picked ? 'text-white opacity-100' : 'opacity-0')} aria-live="polite">
        {picked ?? ''}
      </div>
      {labels.swipe && <p className="text-2xs text-silver/50 sm:hidden">{labels.swipe}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-silver/80">
        <span className="flex items-center gap-1.5">
          {labels.scale.low}
          <span className="flex gap-px" aria-hidden="true">
            {[0.12, 0.3, 0.5, 0.72, 0.95].map((o) => (
              <span key={o} className="h-2.5 w-3 rounded-sm" style={{ background: SERIES.primary, opacity: o }} />
            ))}
          </span>
          {labels.scale.high}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: STATUS.bad }} aria-hidden="true" />
          {labels.unfilled}
        </span>
        {(target !== null || days.some((d) => d.target?.some((n) => n > 0))) && (
          <span className="flex items-center gap-1.5">
            <span className="h-0.5 w-3.5 rounded-full" style={{ background: STATUS.warn }} aria-hidden="true" />
            {labels.belowTarget}
          </span>
        )}
      </div>
    </div>
  );
}

function hourLabelShort(h: number): string {
  if (h === 0) return '12a';
  if (h < 12) return `${h}a`;
  if (h === 12) return '12p';
  return `${h - 12}p`;
}

function DayRow({
  day,
  max,
  target,
  isToday,
  labels,
  onPick,
}: {
  day: HeatDay;
  max: number;
  target: number | null;
  isToday: boolean;
  labels: { cell: (day: string, hour: string, scheduled: number, open: number) => string };
  onPick: (text: string) => void;
}) {
  return (
    <>
      <div className={cn('sticky left-0 z-10 flex items-center pr-2 text-2xs bg-navy', isToday ? 'font-medium text-gold' : 'text-silver/70')}>
        {day.label}
      </div>
      {day.scheduled.map((n, h) => {
        const open = day.open[h] ?? 0;
        // Per-hour contract when the day carries one: every contracted hour short of it.
        const hourTarget = day.target ? (day.target[h] ?? 0) : null;
        const below = hourTarget !== null ? hourTarget > 0 && n < hourTarget : target !== null && n < target && (n > 0 || open > 0);
        const opacity = n === 0 ? 0 : 0.12 + (n / max) * 0.83;
        const text = labels.cell(day.label, hourLabelShort(h), n, open);
        return (
          <button
            key={h}
            type="button"
            onClick={() => onPick(text)}
            className="relative m-px h-6 rounded-sm bg-navy-secondary/40 focus:outline-none focus-visible:ring-1 focus-visible:ring-gold coarse:h-7"
            title={text}
            aria-label={text}
          >
            {n > 0 && (
              <div className="absolute inset-0 rounded-sm" style={{ background: SERIES.primary, opacity }} />
            )}
            {open > 0 && (
              <span
                className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full"
                style={{ background: STATUS.bad }}
                aria-hidden="true"
              />
            )}
            {below && (
              <span
                data-testid="heat-below"
                className="absolute inset-x-0.5 bottom-0 h-0.5 rounded-full"
                style={{ background: STATUS.warn }}
                aria-hidden="true"
              />
            )}
          </button>
        );
      })}
    </>
  );
}

/* ---- Hours: scheduled vs delivered per day (two series, one axis) ------ */

export function HoursChart({
  days,
  labels,
}: {
  days: Array<{ date: string; day: string; scheduledHours: number; workedHours: number }>;
  labels: { scheduled: string; worked: string; heading: (d: string) => string };
}) {
  const peak = Math.max(0, ...days.map((d) => Math.max(d.scheduledHours, d.workedHours)));
  const axis = niceAxis(peak);
  return (
    <div>
      <div className="h-40 w-full">
        <HoursPlot days={days} labels={labels} domain={axis.domain} ticks={axis.ticks} />
      </div>
      <div className="mt-1">
        <LegendKey
          items={[
            { name: labels.scheduled, color: CONCEPT.scheduled },
            { name: labels.worked, color: CONCEPT.delivered },
          ]}
        />
      </div>
    </div>
  );
}

/* ---- Stores side by side: one horizontal bar per store ----------------- */

export function StoreBarChart({
  rows,
  labels,
}: {
  rows: Array<{ id: string; name: string; value: number | null }>;
  labels: { value: string; target: string; heading: (n: string) => string };
}) {
  const height = Math.max(120, rows.length * 30 + 24);
  return (
    <div style={{ height }} className="w-full">
      <StoreBarPlot rows={rows} labels={labels} />
    </div>
  );
}
