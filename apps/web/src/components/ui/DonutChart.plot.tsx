import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { TOOLTIP_ITEM_STYLE, TOOLTIP_LABEL_STYLE, TOOLTIP_STYLE } from './charts/palette';
import type { DonutDatum } from './DonutChart';

/** DonutChart's drawing — fetched with the first chart (lazyPlot), the only part that needs recharts. */
export function DonutPlot({
  data,
  size,
  inner,
  outer,
  gap,
  total,
  fmt,
  activeIdx,
  onActive,
}: {
  data: Array<DonutDatum & { color: string }>;
  size: number;
  inner: number;
  outer: number;
  gap: number;
  total: number;
  fmt: (n: number) => string;
  activeIdx: number | null;
  onActive: (i: number | null) => void;
}) {
  return (
    // Fixed px (not 100%): the parent is exactly `size` square, so the
    // 100% measurement is unnecessary and is what triggers recharts'
    // width(-1)/height(-1) warning when measured early during mount.
    <ResponsiveContainer width={size} height={size}>
      <PieChart accessibilityLayer={false}>
        <Pie
          data={data}
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
          onMouseEnter={(_, i) => onActive(i)}
          onMouseLeave={() => onActive(null)}
        >
          {data.map((d, i) => (
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
  );
}
