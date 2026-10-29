import { Cell, Pie, PieChart } from 'recharts';
import { ResponsiveContainer } from '@/components/ui/charts/container.plot';
import { PALETTE } from '@/components/ui/charts/palette';

/** ComplianceDonut's drawing — fetched with the donut (lazyPlot), the only part that needs recharts. */
export function ComplianceDonutPlot({ fully, gaps, size }: { fully: number; gaps: number; size: number }) {
  return (
    /* Fixed px (not 100%): the parent is exactly SIZE square, so there's
        nothing to measure — and measuring "100%" a tick early during mount
        is what produces recharts' width(-1)/height(-1) warning. */
    <ResponsiveContainer width={size} height={size}>
      <PieChart accessibilityLayer={false}>
        <Pie
          data={[
            { name: 'Fully compliant', value: fully },
            { name: 'Has gaps', value: gaps },
          ]}
          dataKey="value"
          cx="50%"
          cy="50%"
          innerRadius={Math.round(size * 0.34)}
          outerRadius={Math.round(size * 0.48)}
          paddingAngle={gaps > 0 && fully > 0 ? 3 : 0}
          startAngle={90}
          endAngle={-270}
          stroke="none"
          isAnimationActive
          animationDuration={500}
        >
          {/* The kit's state colors — CSS variables, so the light/dark
              flip recolors the donut with no re-render. */}
          <Cell fill={PALETTE.good} />
          <Cell fill={PALETTE.bad} />
        </Pie>
      </PieChart>
    </ResponsiveContainer>
  );
}
