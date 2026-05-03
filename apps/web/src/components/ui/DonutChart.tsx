import { useMemo, useState } from 'react';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { cn } from '@/lib/cn';

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
  className?: string;
}

// Bound to CSS vars so the donut tracks light/dark mode automatically
// instead of freezing the dark-mode hexes into the chart.
const FALLBACK_COLORS = [
  'rgb(var(--color-gold))',
  'rgb(var(--color-success))',
  'rgb(var(--color-steel))',
  'rgb(var(--color-alert))',
  'rgb(var(--color-silver))',
  'rgb(var(--color-warning))',
  'rgb(var(--color-teal))',
];

export function DonutChart({
  data,
  size = 220,
  gap = 2,
  centerLabel,
  centerSublabel,
  className,
}: DonutChartProps) {
  const [activeIdx, setActiveIdx] = useState<number | null>(null);

  const { total, withColors } = useMemo(() => {
    const total = data.reduce((sum, d) => sum + d.value, 0);
    const withColors = data.map((d, i) => ({
      ...d,
      color: d.color ?? FALLBACK_COLORS[i % FALLBACK_COLORS.length],
    }));
    return { total, withColors };
  }, [data]);

  if (total === 0) {
    return null;
  }

  const inner = Math.round(size * 0.34);
  const outer = Math.round(size * 0.48);

  return (
    <div className={cn('flex flex-col md:flex-row items-center gap-6', className)}>
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
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
              contentStyle={{
                background: 'rgb(var(--color-navy))',
                border: '1px solid rgb(var(--color-navy-secondary))',
                borderRadius: 6,
                fontSize: 12,
                color: 'rgb(var(--color-fg))',
                boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
              }}
              labelStyle={{ color: 'rgb(var(--color-silver))' }}
              formatter={(value, name) => {
                const n = typeof value === 'number' ? value : Number(value) || 0;
                return [
                  `${n.toLocaleString()} (${Math.round((n / total) * 100)}%)`,
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
            <div className="text-[10px] uppercase tracking-widest text-silver/70 mt-1">
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
              <span className="text-sm tabular-nums text-white w-12 text-right">
                {d.value.toLocaleString()}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
