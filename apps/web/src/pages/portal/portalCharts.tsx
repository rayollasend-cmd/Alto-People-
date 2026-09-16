import type { ReactNode } from 'react';
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { cn } from '@/lib/cn';

/**
 * The portal's chart kit — a few fixed specs so every figure on the store
 * site reads as one system: thin marks, 4px rounded data-ends, hairline
 * solid grid one step off the surface, a 2px surface gap between touching
 * fills, text in text tokens (never the series color), a legend for two
 * or more series, a tooltip on every mark, and a table twin behind
 * "Details" so nothing is gated on hover or color.
 *
 * Colors are the validated chart tokens (--color-chart-1/2/3) for series
 * identity and the reserved status tokens for state (open = alert).
 */

export const SERIES = {
  primary: 'rgb(var(--color-chart-1))',
  secondary: 'rgb(var(--color-chart-2))',
  tertiary: 'rgb(var(--color-chart-3))',
} as const;
export const STATUS = {
  good: 'rgb(var(--color-success))',
  warn: 'rgb(var(--color-warning))',
  bad: 'rgb(var(--color-alert))',
} as const;
const SURFACE = 'rgb(var(--color-navy))';
const GRID = 'rgb(var(--color-navy-secondary))';
const TICK = { fill: 'rgb(var(--color-silver) / 0.75)', fontSize: 10 } as const;
const REF = 'rgb(var(--color-silver) / 0.55)';

/* ---- Tooltip ---------------------------------------------------------- */

interface TipRow {
  dataKey?: string | number;
  value?: number | string;
  color?: string;
}

export function PortalTooltip({
  active,
  payload,
  label,
  series,
  heading,
  format,
}: {
  active?: boolean;
  payload?: TipRow[];
  label?: string | number;
  /** dataKey → { name, color } so the readout keys each row by a line key. */
  series: Record<string, { name: string; color: string }>;
  heading?: (label: string) => string;
  format?: (v: number, key: string) => string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const rows = payload.filter((p) => p.dataKey !== undefined && series[String(p.dataKey)]);
  if (rows.length === 0) return null;
  return (
    <div className="rounded-md border border-navy-secondary bg-navy px-3 py-2 elev-2 text-xs">
      <div className="mb-1 text-silver/80">{heading ? heading(String(label)) : String(label)}</div>
      {rows.map((p) => {
        const key = String(p.dataKey);
        const s = series[key]!;
        const v = Number(p.value ?? 0);
        return (
          <div key={key} className="flex items-center gap-2 py-0.5">
            <span
              aria-hidden="true"
              className="inline-block h-0.5 w-3.5 rounded-full"
              style={{ background: s.color }}
            />
            <span className="font-semibold tabular-nums text-white">
              {format ? format(v, key) : v.toLocaleString()}
            </span>
            <span className="text-silver/80">{s.name}</span>
          </div>
        );
      })}
    </div>
  );
}

function LegendKey({ items }: { items: Array<{ name: string; color: string; line?: boolean }> }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-silver/80">
      {items.map((i) => (
        <li key={i.name} className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={cn('inline-block', i.line ? 'h-0.5 w-3.5 rounded-full' : 'h-2.5 w-2.5 rounded-sm')}
            style={{ background: i.color }}
          />
          {i.name}
        </li>
      ))}
    </ul>
  );
}

/* ---- Details table (the chart's table twin) ---------------------------- */

export function DetailsTable({
  label,
  columns,
  rows,
}: {
  label: string;
  columns: string[];
  rows: Array<Array<string | number>>;
}) {
  return (
    <details className="group mt-2 print:hidden">
      <summary className="cursor-pointer select-none text-2xs uppercase tracking-wider text-silver/60 hover:text-silver">
        {label}
      </summary>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-2xs uppercase tracking-wider text-silver/60">
              {columns.map((c) => (
                <th key={c} className="py-1 pr-3 font-medium">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-navy-secondary/60">
            {rows.map((r, i) => (
              <tr key={i}>
                {r.map((cell, j) => (
                  <td
                    key={j}
                    className={cn('py-1 pr-3', j === 0 ? 'text-silver' : 'tabular-nums text-white')}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
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
}: {
  points: HourPoint[];
  target: number | null;
  /** Current hour in the store's zone, 0–23; null when today is over. */
  nowHour: number | null;
  labels: { scheduled: string; open: string; contracted: string; now: string; at: (h: string) => string };
}) {
  const series = {
    scheduled: { name: labels.scheduled, color: SERIES.primary },
    open: { name: labels.open, color: STATUS.bad },
  };
  const max = Math.max(target ?? 0, ...points.map((p) => p.scheduled + p.open), 1);
  const nowLabel = nowHour !== null ? points[nowHour]?.label : undefined;
  return (
    <div>
      <div className="h-44 w-full sm:h-48">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={points} margin={{ top: 12, right: 12, bottom: 0, left: -18 }}>
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
              domain={[0, Math.ceil(max * 1.15)]}
              width={36}
            />
            <ChartTooltip
              cursor={{ stroke: REF, strokeWidth: 1 }}
              content={<PortalTooltip series={series} heading={(l) => labels.at(l)} />}
            />
            <Area
              type="stepAfter"
              dataKey="scheduled"
              stackId="a"
              stroke={SERIES.primary}
              strokeWidth={2}
              fill={SERIES.primary}
              fillOpacity={0.12}
              isAnimationActive={false}
              dot={false}
              activeDot={{ r: 4, stroke: SURFACE, strokeWidth: 2 }}
            />
            <Area
              type="stepAfter"
              dataKey="open"
              stackId="a"
              stroke={STATUS.bad}
              strokeWidth={2}
              fill={STATUS.bad}
              fillOpacity={0.12}
              isAnimationActive={false}
              dot={false}
              activeDot={{ r: 4, stroke: SURFACE, strokeWidth: 2 }}
            />
            {target !== null && (
              <ReferenceLine
                y={target}
                stroke={REF}
                strokeDasharray="4 3"
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
            { name: labels.scheduled, color: SERIES.primary },
            { name: labels.open, color: STATUS.bad },
            ...(target !== null ? [{ name: labels.contracted, color: REF, line: true }] : []),
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
    filled: { name: labels.filled, color: SERIES.primary },
    open: { name: labels.open, color: STATUS.bad },
  };
  return (
    <div>
      <div className="h-40 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={days} margin={{ top: 8, right: 4, bottom: 0, left: -18 }} barCategoryGap="30%">
            <CartesianGrid stroke={GRID} strokeWidth={1} vertical={false} />
            <XAxis
              dataKey="day"
              tick={TICK}
              axisLine={{ stroke: GRID }}
              tickLine={false}
            />
            <YAxis tick={TICK} axisLine={false} tickLine={false} allowDecimals={false} width={36} />
            <ChartTooltip
              cursor={{ fill: 'rgb(var(--color-navy-secondary) / 0.35)' }}
              content={<PortalTooltip series={series} heading={(l) => labels.heading(l)} />}
            />
            <Bar
              dataKey="filled"
              stackId="a"
              fill={SERIES.primary}
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
              fill={STATUS.bad}
              stroke={SURFACE}
              strokeWidth={2}
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
            { name: labels.filled, color: SERIES.primary },
            { name: labels.open, color: STATUS.bad },
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
  weeks: Array<{ start: string; label: string; fillPct: number | null; current: boolean }>;
  labels: { fill: string; target: string; heading: (w: string) => string };
}) {
  const series = { fillPct: { name: labels.fill, color: SERIES.primary } };
  const data = weeks.map((w) => ({ ...w, fillPct: w.fillPct ?? 0 }));
  return (
    <div className="h-36 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 12, right: 4, bottom: 0, left: -18 }} barCategoryGap="35%">
          <CartesianGrid stroke={GRID} strokeWidth={1} vertical={false} />
          <XAxis dataKey="label" tick={TICK} axisLine={{ stroke: GRID }} tickLine={false} />
          <YAxis
            tick={TICK}
            axisLine={false}
            tickLine={false}
            domain={[0, 100]}
            ticks={[0, 50, 100]}
            width={36}
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
            y={95}
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
            dataKey="fillPct"
            fill={SERIES.primary}
            maxBarSize={24}
            radius={[4, 4, 0, 0]}
            isAnimationActive={false}
          >
            {data.map((w) => (
              <Cell key={w.start} fillOpacity={w.current ? 0.45 : 1} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ---- Ring meter: one ratio against a limit ---------------------------- */

export function RingMeter({
  percent,
  tone = 'primary',
  size = 88,
  children,
  label,
}: {
  percent: number | null;
  tone?: 'primary' | 'good' | 'warn' | 'bad';
  size?: number;
  /** Center content (the figure). */
  children?: ReactNode;
  label: string;
}) {
  const r = (size - 10) / 2;
  const c = 2 * Math.PI * r;
  const pct = percent === null ? 0 : Math.max(0, Math.min(100, percent));
  const color =
    tone === 'good' ? STATUS.good : tone === 'warn' ? STATUS.warn : tone === 'bad' ? STATUS.bad : SERIES.primary;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        aria-label={label}
      >
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeOpacity={0.18} strokeWidth={8} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={8}
          strokeLinecap="round"
          strokeDasharray={`${(pct / 100) * c} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: 'stroke-dasharray 500ms ease-out' }}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center">{children}</div>
    </div>
  );
}

/* ---- Stat tile ---------------------------------------------------------- */

export function StatTile({
  label,
  value,
  unit,
  delta,
  deltaTone = 'neutral',
  sub,
  meter,
  className,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  delta?: string | null;
  deltaTone?: 'good' | 'bad' | 'neutral';
  sub?: ReactNode;
  /** 0–100 fill for a same-hue meter under the value. */
  meter?: { percent: number; tone?: 'primary' | 'good' | 'warn' | 'bad' } | null;
  className?: string;
}) {
  const meterColor =
    meter?.tone === 'good'
      ? STATUS.good
      : meter?.tone === 'warn'
        ? STATUS.warn
        : meter?.tone === 'bad'
          ? STATUS.bad
          : SERIES.primary;
  return (
    <div
      className={cn(
        'rounded-lg border border-navy-secondary bg-navy-secondary/20 p-4 elev-1',
        className,
      )}
    >
      <div className="text-2xs font-medium uppercase tracking-wider text-silver/60">{label}</div>
      <div className="mt-1.5 flex items-baseline gap-1.5">
        <span className="text-3xl font-bold tracking-tight text-white">{value}</span>
        {unit && <span className="text-sm text-silver">{unit}</span>}
        {delta && (
          <span
            className={cn(
              'ml-auto text-xs font-medium tabular-nums',
              deltaTone === 'good' ? 'text-success' : deltaTone === 'bad' ? 'text-alert' : 'text-silver/70',
            )}
          >
            {delta}
          </span>
        )}
      </div>
      {meter && (
        <div
          className="mt-2 h-1.5 w-full overflow-hidden rounded-full"
          style={{ background: `color-mix(in srgb, ${meterColor} 18%, transparent)` }}
          aria-hidden="true"
        >
          <div
            className="h-full rounded-full transition-[width] duration-500 ease-out"
            style={{ width: `${Math.max(0, Math.min(100, meter.percent))}%`, background: meterColor }}
          />
        </div>
      )}
      {sub && <div className="mt-1.5 text-xs text-silver/70 tabular-nums">{sub}</div>}
    </div>
  );
}
