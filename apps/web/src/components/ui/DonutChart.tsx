import { useMemo, useState, type ReactNode } from 'react';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { PieChart as PieIcon } from 'lucide-react';
import { cn } from '@/lib/cn';
import { PALETTE, TOOLTIP_ITEM_STYLE, TOOLTIP_LABEL_STYLE, TOOLTIP_STYLE, seriesColor } from './charts/palette';
import { EmptyState } from './EmptyState';

export interface DonutDatum {
  name: string;
  value: number;
  /** RGB or hex; defaults cycle through the brand palette. */
  color?: string;
}

interface DonutChartProps {
  data: DonutDatum[];
  /** Px size of the chart square. The legend lives outside it. */
  size?: number;
  /** Stroke between segments — gives the slices a clean separation. */
  gap?: number;
  /** Center label override; defaults to the total. */
  centerLabel?: string;
  /** Center sublabel — sits beneath the center value. */
  centerSublabel?: string;
  /** Formats slice values in the tooltip + legend (e.g. money). Defaults
   *  to toLocaleString. */
  valueFormatter?: (n: number) => string;
  /** Shown when every slice is zero. Pass null to render nothing. */
  empty?: ReactNode;
  className?: string;
}

/** Slices past the fifth uncolored one fold into "Other" — five hues, never a sixth. */
const MAX_HUES = 5;

export function DonutChart({
  data,
  size = 220,
  gap = 2,
  centerLabel,
  centerSublabel,
  valueFormatter,
  empty,
  className,
}: DonutChartProps) {
  const fmt = valueFormatter ?? ((n: number) => n.toLocaleString());
  const [activeIdx, setActiveIdx] = useState<number | null>(null);

  const { total, withColors } = useMemo(() => {
    const total = data.reduce((sum, d) => sum + d.value, 0);
    // Callers that color their own slices keep them; uncolored slices take
    // the kit's order, and past the fifth they fold into one "Other".
    const uncolored = data.filter((d) => !d.color);
    const fold = uncolored.length > MAX_HUES + 1;
    const kept: DonutDatum[] = [];
    let other = 0;
    let hue = 0;
    for (const d of data) {
      if (d.color) kept.push(d);
      else if (!fold || hue < MAX_HUES) kept.push({ ...d, color: seriesColor(hue++) });
      else other += d.value;
    }
    if (fold && other > 0) kept.push({ name: 'Other', value: other, color: PALETTE.other });
    const withColors = kept as Array<DonutDatum & { color: string }>;
    return { total, withColors };
  }, [data]);

  if (total === 0) {
    return empty === undefined ? <EmptyState size="sm" icon={PieIcon} title="Nothing to break down yet" className={className} /> : <>{empty}</>;
  }

  const inner = Math.round(size * 0.34);
  const outer = Math.round(size * 0.48);

  return (
    <div className={cn('flex flex-col md:flex-row items-center gap-6', className)}>
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        {/* Fixed px (not 100%): the parent is exactly `size` square, so the
            100% measurement is unnecessary and is what triggers recharts'
            width(-1)/height(-1) warning when measured early during mount. */}
        <ResponsiveContainer width={size} height={size}>
          <PieChart accessibilityLayer={false}>
            <Pie
              data={withColors}
              dataKey="value"
              nameKey="name"
              cx="50%"
              cy="50%"
              innerRadius={inner}
              outerRadius={outer}
              paddingAngle={gap}
              stroke="none"
              isAnimationActive
              animationDuration={650}
              animationEasing="ease-out"
              onMouseEnter={(_, i) => setActiveIdx(i)}
              onMouseLeave={() => setActiveIdx(null)}
            >
              {withColors.map((d, i) => (
                <Cell
                  key={d.name}
                  fill={d.color}
                  opacity={activeIdx === null || activeIdx === i ? 1 : 0.35}
                  style={{ transition: 'opacity 150ms ease-out' }}
                />
              ))}
            </Pie>
            <Tooltip
              cursor={false}
              wrapperStyle={{ outline: 'none' }}
              contentStyle={TOOLTIP_STYLE}
              labelStyle={TOOLTIP_LABEL_STYLE}
              itemStyle={TOOLTIP_ITEM_STYLE}
              formatter={(value, name) => {
                const n = typeof value === 'number' ? value : Number(value) || 0;
                return [
                  `${fmt(n)} (${Math.round((n / total) * 100)}%)`,
                  String(name ?? ''),
                ];
              }}
            />
          </PieChart>
        </ResponsiveContainer>
        {/* Center label sits in the donut hole. Pointer-events none so it
            doesn't block tooltip hover on the slices. */}
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <div className="font-display text-3xl tabular-nums text-white leading-none">
            {centerLabel ?? total.toLocaleString()}
          </div>
          {centerSublabel && (
            <div className="text-2xs uppercase tracking-widest text-silver/70 mt-1">
              {centerSublabel}
            </div>
          )}
        </div>
      </div>

      <ul className="flex-1 min-w-0 space-y-1.5 w-full">
        {withColors.map((d, i) => {
          const pct = Math.round((d.value / total) * 100);
          const dim = activeIdx !== null && activeIdx !== i;
          return (
            <li
              key={d.name}
              onMouseEnter={() => setActiveIdx(i)}
              onMouseLeave={() => setActiveIdx(null)}
              className={cn(
                'flex items-center gap-3 px-2 py-1.5 rounded-md cursor-default transition-opacity',
                dim ? 'opacity-50' : 'opacity-100',
                activeIdx === i && 'bg-navy-secondary/40',
              )}
            >
              <span
                className="h-2.5 w-2.5 rounded-sm shrink-0"
                style={{ backgroundColor: d.color }}
                aria-hidden="true"
              />
              <span className="text-sm text-white flex-1 truncate">{d.name}</span>
              <span className="text-xs tabular-nums text-silver/80 w-10 text-right">
                {pct}%
              </span>
              <span className="text-sm tabular-nums text-white min-w-12 text-right">
                {fmt(d.value)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
