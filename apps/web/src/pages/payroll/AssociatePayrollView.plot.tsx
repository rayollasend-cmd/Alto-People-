import { Bar, BarChart, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import { PALETTE } from '@/components/ui/charts';

/** MoneySplit's one stacked bar — fetched with the check (lazyPlot), the only part that needs recharts. */
export function MoneySplitPlot({
  row,
  parts,
  total,
}: {
  row: Record<string, number>;
  parts: Array<{ key: string; color: string }>;
  total: number;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart accessibilityLayer={false} data={[row]} layout="vertical" margin={{ top: 0, right: 0, bottom: 0, left: 0 }} barCategoryGap={0}>
        <XAxis type="number" hide domain={[0, total]} />
        <YAxis type="category" hide />
        {parts.map((p, i) => (
          <Bar
            key={p.key}
            dataKey={p.key}
            stackId="split"
            fill={p.color}
            stroke={PALETTE.surface}
            strokeWidth={1}
            radius={parts.length === 1 ? [6, 6, 6, 6] : i === 0 ? [6, 0, 0, 6] : i === parts.length - 1 ? [0, 6, 6, 0] : [0, 0, 0, 0]}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
