import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { PALETTE, TICK, TOOLTIP_LABEL_STYLE, TOOLTIP_STYLE } from '@/components/ui/charts/palette';

/* The OSHA tab's drawings — fetched with the first chart (lazyPlot), the only part that needs recharts. */

/** Incidents, month by month: one stacked bar per severity in use. */
export function OshaByMonthPlot({ byMonth, bars }: { byMonth: Array<Record<string, string | number>>; bars: Array<{ key: string; name: string; fill: string }> }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={byMonth} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={PALETTE.grid} vertical={false} />
        <XAxis dataKey="month" tick={TICK} tickLine={false} axisLine={false} />
        <YAxis allowDecimals={false} tick={TICK} tickLine={false} axisLine={false} width="auto" />
        <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL_STYLE} cursor={{ fill: PALETTE.cursor }} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        {bars.map((b) => (
          <Bar key={b.key} dataKey={b.key} name={b.name} stackId="sev" fill={b.fill} maxBarSize={26} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

/** By body part: the most often hurt, longest bar first. */
export function OshaByPartPlot({ topParts }: { topParts: Array<{ part: string; count: number }> }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={topParts} layout="vertical" margin={{ top: 0, right: 16, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={PALETTE.grid} horizontal={false} />
        <XAxis type="number" allowDecimals={false} tick={TICK} tickLine={false} axisLine={false} />
        <YAxis type="category" dataKey="part" width={100} tick={TICK} tickLine={false} axisLine={false} />
        <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL_STYLE} cursor={{ fill: PALETTE.cursor }} />
        <Bar dataKey="count" name="Incidents" fill={PALETTE.series[0]} radius={[0, 3, 3, 0]} maxBarSize={18} />
      </BarChart>
    </ResponsiveContainer>
  );
}
