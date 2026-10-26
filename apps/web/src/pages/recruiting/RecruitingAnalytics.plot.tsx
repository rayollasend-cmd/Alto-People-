import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { fmtMoney } from '@/lib/format';
import { PALETTE, TICK, TOOLTIP_LABEL_STYLE, TOOLTIP_STYLE } from '@/components/ui/charts/palette';

/* Recruiting analytics' bar drawings — fetched with the first chart (lazyPlot), the only part that needs recharts. */

/** The funnel: how many reached each step, every bar labeled. */
export function FunnelPlot({ rows }: { rows: Array<{ step: string; reached: number; label: string }> }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 132, bottom: 0, left: 0 }}>
        <XAxis type="number" hide domain={[0, 'dataMax']} />
        <YAxis type="category" dataKey="step" width={92} tick={TICK} tickLine={false} axisLine={false} />
        <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL_STYLE} cursor={{ fill: PALETTE.cursor }} />
        <Bar dataKey="reached" name="Reached" fill={PALETTE.series[0]} radius={[0, 3, 3, 0]} maxBarSize={22} isAnimationActive={false}>
          <LabelList dataKey="label" position="right" style={{ fill: TICK.fill, fontSize: 11 }} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Hires by source, every bar labeled. */
export function HiresBySourcePlot({ hires }: { hires: Array<{ source: string; hires: number; applicants: number }> }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={hires} layout="vertical" margin={{ top: 0, right: 32, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={PALETTE.grid} horizontal={false} />
        <XAxis type="number" allowDecimals={false} tick={TICK} tickLine={false} axisLine={false} />
        <YAxis type="category" dataKey="source" width={110} tick={TICK} tickLine={false} axisLine={false} />
        <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL_STYLE} cursor={{ fill: PALETTE.cursor }} />
        <Bar dataKey="hires" name="Hired" fill={PALETTE.series[0]} radius={[0, 3, 3, 0]} maxBarSize={20}>
          <LabelList dataKey="hires" position="right" style={{ fill: TICK.fill, fontSize: 11 }} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Cost per hire by source, every bar labeled in dollars. */
export function CostPerHirePlot({ cost }: { cost: Array<{ source: string; costPerHire: number; hires: number }> }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={cost} layout="vertical" margin={{ top: 0, right: 64, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={PALETTE.grid} horizontal={false} />
        <XAxis type="number" tick={TICK} tickLine={false} axisLine={false} tickFormatter={(v: number) => `$${v}`} />
        <YAxis type="category" dataKey="source" width={110} tick={TICK} tickLine={false} axisLine={false} />
        <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL_STYLE} cursor={{ fill: PALETTE.cursor }} formatter={(v) => fmtMoney(Number(v))} />
        <Bar dataKey="costPerHire" name="Per hire" fill={PALETTE.series[1]} radius={[0, 3, 3, 0]} maxBarSize={20}>
          <LabelList dataKey="costPerHire" position="right" formatter={(v: unknown) => fmtMoney(Number(v))} style={{ fill: TICK.fill, fontSize: 11 }} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
