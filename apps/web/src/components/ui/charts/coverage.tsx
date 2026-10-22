import { useState } from 'react';
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  LabelList,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { cn } from '@/lib/cn';
import { ChartTooltipContent as PortalTooltip, LegendKey } from './ChartTooltip';
import { CONCEPT, PALETTE, TICK as BASE_TICK } from './palette';

/**
 * Staffing figures shared by the store portal, the supervisor and region
 * homes and the scheduler: thin marks, 4px rounded data-ends, hairline
 * grid one step off the surface, a 2px surface gap between touching
 * fills, a tooltip on every mark and a legend for two or more series.
 */

const SERIES = { primary: PALETTE.primary, secondary: PALETTE.secondary, tertiary: PALETTE.tertiary } as const;
const STATUS = { good: PALETTE.good, warn: PALETTE.warn, bad: PALETTE.bad } as const;
const SURFACE = PALETTE.surface;
const GRID = PALETTE.grid;
const TICK = { ...BASE_TICK, fontSize: 10 } as const;
const REF = PALETTE.ref;

/*
 * Axes. These charts used a -18px left margin with a 36px y-axis, which cut
 * every tick wider than two characters ("100%" read "%", "24h" read "4h").
 * The plot now starts at the card's edge and the y-axis sizes itself to its
 * widest tick.
 */
const MARGIN = { top: 12, right: 12, bottom: 0, left: 0 } as const;
const Y_WIDTH = 'auto' as const;

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
  // A wrapping window (10p–6a) is two spans on a midnight-to-midnight axis.
  // The name rides the wider half, so a 10p start doesn't clip it.
  const spans = bands.flatMap((b) => {
    const from = Math.floor(b.startMinute / 60);
    const to = Math.ceil(b.endMinute / 60);
    if (to > from) return [{ from, to, label: b.label }];
    const lateWider = 24 - from >= to;
    return [
      { from, to: 24, label: lateWider ? b.label : '' },
      { from: 0, to, label: lateWider ? '' : b.label },
    ];
  });
  const at = (h: number) => points[Math.min(Math.max(h, 0), points.length - 1)]?.label;
  const series = {
    scheduled: { name: labels.scheduled, color: CONCEPT.scheduled },
    open: { name: labels.open, color: CONCEPT.unfilled },
  };
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
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart accessibilityLayer={false} data={points} margin={MARGIN}>
            <CartesianGrid stroke={GRID} strokeWidth={1} vertical={false} />
            <XAxis
              dataKey="label"
              tick={TICK}
              axisLine={{ stroke: GRID }}
              tickLine={false}
              interval={2}
            />
            <YAxis
              tick={TICK}
              axisLine={false}
              tickLine={false}
              allowDecimals={false}
              domain={coverageDomain(peak, target)}
              allowDataOverflow
              width={Y_WIDTH}
            />
            <ChartTooltip
              cursor={{ stroke: REF, strokeWidth: 1 }}
              content={<PortalTooltip series={series} heading={(l) => labels.at(l)} />}
            />
            <Area
              type="stepAfter"
              dataKey="scheduled"
              stackId="a"
              stroke={CONCEPT.scheduled}
              strokeWidth={2}
              fill={CONCEPT.scheduled}
              fillOpacity={0.12}
              isAnimationActive={false}
              dot={false}
              activeDot={{ r: 4, stroke: SURFACE, strokeWidth: 2 }}
            />
            {/* Unfilled slots sit on top of the scheduled stack as a fill with no
                stroke: an outline at zero height painted a red line over the gold one
                and made a fully covered day read as unfilled (walk 2026-10-15). */}
            <Area
              type="stepAfter"
              dataKey="open"
              stackId="a"
              stroke={CONCEPT.unfilled}
              strokeWidth={0}
              fill={CONCEPT.unfilled}
              fillOpacity={0.35}
              isAnimationActive={false}
              dot={false}
              activeDot={{ r: 4, stroke: SURFACE, strokeWidth: 2 }}
            />
            {spans.map((sp, i) =>
              sp.to > sp.from && at(sp.from) ? (
                <ReferenceArea
                  key={i}
                  x1={at(sp.from)}
                  x2={at(sp.to === 24 ? 23 : sp.to)}
                  fill="rgb(var(--color-gold) / 0.10)"
                  stroke="rgb(var(--color-gold) / 0.35)"
                  strokeDasharray="2 3"
                  ifOverflow="extendDomain"
                  label={
                    sp.label
                      ? { value: sp.label, position: 'insideTopLeft', fill: 'rgb(var(--color-gold) / 0.9)', fontSize: 10 }
                      : undefined
                  }
                />
              ) : null,
            )}
            {target !== null && (
              <ReferenceLine
                y={target}
                stroke={CONCEPT.target}
                strokeDasharray="4 3"
                ifOverflow="extendDomain"
                label={{
                  value: `${labels.contracted} ${target}`,
                  position: 'insideTopRight',
                  fill: 'rgb(var(--color-silver) / 0.8)',
                  fontSize: 10,
                }}
              />
            )}
            {nowLabel && (
              <ReferenceLine
                x={nowLabel}
                stroke="rgb(var(--color-fg) / 0.6)"
                strokeWidth={1}
                ifOverflow="extendDomain"
                label={{
                  value: labels.now,
                  position: 'top',
                  fill: 'rgb(var(--color-fg) / 0.8)',
                  fontSize: 10,
                }}
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
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
  const series = {
    filled: { name: labels.filled, color: CONCEPT.scheduled },
    open: { name: labels.open, color: CONCEPT.unfilled },
  };
  const peak = Math.max(0, ...days.map((d) => d.filled + d.open));
  return (
    <div>
      <div className="h-40 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart accessibilityLayer={false} data={days} margin={{ ...MARGIN, top: 8, right: 4 }} barCategoryGap="30%">
            <CartesianGrid stroke={GRID} strokeWidth={1} vertical={false} />
            <XAxis
              dataKey="day"
              tick={TICK}
              axisLine={{ stroke: GRID }}
              tickLine={false}
            />
            <YAxis tick={TICK} axisLine={false} tickLine={false} allowDecimals={false} domain={coverageDomain(peak)} allowDataOverflow width={Y_WIDTH} />
            <ChartTooltip
              cursor={{ fill: 'rgb(var(--color-navy-secondary) / 0.35)' }}
              content={<PortalTooltip series={series} heading={(l) => labels.heading(l)} />}
            />
            <Bar
              dataKey="filled"
              stackId="a"
              fill={CONCEPT.scheduled}
              stroke={SURFACE}
              strokeWidth={2}
              maxBarSize={24}
              isAnimationActive={false}
            >
              {days.map((d) => (
                <Cell key={d.date} fillOpacity={d.date === todayKey ? 1 : 0.75} />
              ))}
            </Bar>
            <Bar
              dataKey="open"
              stackId="a"
              fill={CONCEPT.unfilled}
              stroke={SURFACE}
              strokeWidth={0}
              maxBarSize={24}
              radius={[4, 4, 0, 0]}
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
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
  const series = { pct: { name: labels.fill, color: SERIES.primary } };
  // A 0% week drew nothing at all; the value label makes four zero weeks visibly zero.
  const data = weeks.map((w) => ({ ...w, pct: w.reliabilityPct, text: w.reliabilityPct === null ? '' : `${w.reliabilityPct}%` }));
  return (
    <div className="h-36 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart accessibilityLayer={false} data={data} margin={{ ...MARGIN, top: 16, right: 4 }} barCategoryGap="35%">
          <CartesianGrid stroke={GRID} strokeWidth={1} vertical={false} />
          <XAxis dataKey="label" tick={TICK} axisLine={{ stroke: GRID }} tickLine={false} />
          <YAxis
            tick={TICK}
            axisLine={false}
            tickLine={false}
            domain={[0, 100]}
            ticks={[0, 50, 100]}
            width={Y_WIDTH}
            tickFormatter={(v: number) => `${v}%`}
          />
          <ChartTooltip
            cursor={{ fill: 'rgb(var(--color-navy-secondary) / 0.35)' }}
            content={
              <PortalTooltip
                series={series}
                heading={(l) => labels.heading(l)}
                format={(v) => `${v}%`}
              />
            }
          />
          <ReferenceLine
            y={88}
            stroke={REF}
            strokeDasharray="4 3"
            label={{
              value: labels.target,
              position: 'insideTopRight',
              fill: 'rgb(var(--color-silver) / 0.8)',
              fontSize: 10,
            }}
          />
          <Bar
            dataKey="pct"
            fill={SERIES.primary}
            // A 0% week draws a hairline (and its label) instead of nothing; a week with no data stays empty.
            minPointSize={(v) => (v == null ? 0 : 2)}
            maxBarSize={24}
            radius={[4, 4, 0, 0]}
            isAnimationActive={false}
          >
            {data.map((w) => (
              <Cell key={w.start} fillOpacity={w.current ? 0.45 : 1} />
            ))}
            <LabelList dataKey="text" position="top" style={{ fill: TICK.fill, fontSize: 10 }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
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
        {target !== null && (
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
        const below = target !== null && n < target && (n > 0 || open > 0);
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
  // Scheduled is the primary series in every staffing chart; delivered the second.
  const series = {
    scheduledHours: { name: labels.scheduled, color: CONCEPT.scheduled },
    workedHours: { name: labels.worked, color: CONCEPT.delivered },
  };
  const peak = Math.max(0, ...days.map((d) => Math.max(d.scheduledHours, d.workedHours)));
  return (
    <div>
      <div className="h-40 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart accessibilityLayer={false} data={days} margin={{ ...MARGIN, top: 8, right: 4 }} barCategoryGap="25%" barGap={2}>
            <CartesianGrid stroke={GRID} strokeWidth={1} vertical={false} />
            <XAxis dataKey="day" tick={TICK} axisLine={{ stroke: GRID }} tickLine={false} />
            <YAxis tick={TICK} axisLine={false} tickLine={false} width={Y_WIDTH} domain={coverageDomain(peak)} allowDataOverflow tickFormatter={(v: number) => `${v}h`} />
            <ChartTooltip
              cursor={{ fill: 'rgb(var(--color-navy-secondary) / 0.35)' }}
              content={
                <PortalTooltip
                  series={series}
                  heading={(l) => labels.heading(l)}
                  format={(v) => `${Math.round(v * 10) / 10}h`}
                />
              }
            />
            <Bar dataKey="scheduledHours" fill={CONCEPT.scheduled} maxBarSize={16} radius={[4, 4, 0, 0]} isAnimationActive={false} />
            <Bar dataKey="workedHours" fill={CONCEPT.delivered} maxBarSize={16} radius={[4, 4, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
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
  const series = { value: { name: labels.value, color: SERIES.primary } };
  // At 0% a store drew no bar at all; the printed value says "0%" (and "—" for no data).
  const data = rows.map((r) => ({ ...r, value: r.value ?? 0, text: r.value === null ? '—' : `${r.value}%` }));
  const height = Math.max(120, rows.length * 30 + 24);
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart accessibilityLayer={false} data={data} layout="vertical" margin={{ top: 4, right: 36, bottom: 0, left: 4 }} barCategoryGap="30%">
          <CartesianGrid stroke={GRID} strokeWidth={1} horizontal={false} />
          <XAxis
            type="number"
            domain={[0, 100]}
            ticks={[0, 50, 100]}
            tick={TICK}
            axisLine={{ stroke: GRID }}
            tickLine={false}
            tickFormatter={(v: number) => `${v}%`}
          />
          <YAxis type="category" dataKey="name" tick={{ ...TICK, fontSize: 11 }} axisLine={false} tickLine={false} width={120} />
          <ChartTooltip
            cursor={{ fill: 'rgb(var(--color-navy-secondary) / 0.35)' }}
            content={<PortalTooltip series={series} heading={(l) => labels.heading(l)} format={(v) => `${v}%`} />}
          />
          <ReferenceLine
            x={88}
            stroke={REF}
            strokeDasharray="4 3"
            label={{ value: labels.target, position: 'insideTopRight', fill: 'rgb(var(--color-silver) / 0.8)', fontSize: 10 }}
          />
          <Bar dataKey="value" fill={SERIES.primary} maxBarSize={18} radius={[0, 4, 4, 0]} minPointSize={2} isAnimationActive={false}>
            {data.map((r) => (
              <Cell
                key={r.id}
                fill={r.value >= 88 ? STATUS.good : r.value >= 70 ? SERIES.primary : STATUS.bad}
                fillOpacity={rows.find((x) => x.id === r.id)?.value === null ? 0.25 : 1}
              />
            ))}
            <LabelList dataKey="text" position="right" style={{ fill: TICK.fill, fontSize: 10 }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
