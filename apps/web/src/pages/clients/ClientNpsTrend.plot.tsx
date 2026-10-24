import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { PALETTE, TICK, TOOLTIP_ITEM_STYLE, TOOLTIP_LABEL_STYLE, TOOLTIP_STYLE } from '@/components/ui/charts/palette';

const LINE = PALETTE.primary;
/** Axis ticks: the kit's muted text token. */
const MUTED = TICK.fill;

/** The NPS-by-quarter drawing on ClientNpsPage — fetched with the chart (lazyPlot), the only part that needs recharts. */
export function NpsTrendPlot({ trend }: { trend: Array<{ quarter: string; nps: number; responded: number }> }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={trend} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={PALETTE.grid} vertical={false} />
        <XAxis dataKey="quarter" tick={{ fill: MUTED, fontSize: 11 }} axisLine={false} tickLine={false} />
        <YAxis domain={[-100, 100]} tick={{ fill: MUTED, fontSize: 11 }} axisLine={false} tickLine={false} width="auto" />
        <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL_STYLE} itemStyle={TOOLTIP_ITEM_STYLE} />
        <Area type="monotone" dataKey="nps" name="NPS" stroke={LINE} strokeWidth={2} fill={LINE} fillOpacity={0.15} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
