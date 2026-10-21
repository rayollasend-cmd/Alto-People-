import { useQuery } from '@tanstack/react-query';
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { fmtMoney, fmtMoneyCompact } from '@/lib/format';
import { getTransportTrends, type TransportTrendWeek } from '@/lib/transportApi';
import { ChartFrame } from '@/components/ui/ChartFrame';
import { PALETTE, TICK, TOOLTIP_LABEL_STYLE, TOOLTIP_STYLE } from '@/components/ui/charts/palette';
import { MetricCard, type MetricTrend } from '@/components/ui/MetricCard';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * Eight weeks of the vans, under the day's board: riders carried, pickups
 * on time, the no-show rate, and what the vans earned against what they
 * cost. The last week is the one still running, so each tile's change
 * compares the two weeks before it.
 */

const dollars = (c: number) => fmtMoney(c / 100);
const weekLabel = (ymd: string) => {
  const [, m, d] = ymd.split('-').map(Number);
  return `${m}/${d}`;
};

/** The tile's trend: the series, and the last complete week against the one before. */
function trendOf(weeks: TransportTrendWeek[], pick: (w: TransportTrendWeek) => number | null, format?: (n: number) => string): MetricTrend | undefined {
  const series = weeks.map((w) => pick(w) ?? Number.NaN);
  const complete = weeks.filter((w) => !w.partial).map(pick);
  const a = complete[complete.length - 1];
  const b = complete[complete.length - 2];
  if (series.filter((v) => Number.isFinite(v)).length < 2) return undefined;
  const lastIsPartial = weeks[weeks.length - 1]?.partial ?? false;
  // A week with nothing to measure has no change to show — a quiet dash, not "0 vs the week before".
  if (a == null || b == null) return { series, delta: 0, deltaLabel: '', lastIsPartial, ...(format ? { format } : {}) };
  return { series, delta: Math.round((a - b) * 10) / 10, deltaLabel: 'vs the week before', lastIsPartial, ...(format ? { format } : {}) };
}

export function TransportTrends() {
  const q = useQuery({ queryKey: ['transport', 'trends', 8], queryFn: () => getTransportTrends(8), staleTime: 5 * 60_000 });
  if (q.isError) return null;
  if (!q.data) return <Skeleton className="h-64" />;
  const weeks = q.data.weeks;
  if (!weeks.some((w) => w.riders + w.noShows > 0 || w.costCents > 0)) return null;
  const last = [...weeks].reverse().find((w) => !w.partial) ?? weeks[weeks.length - 1]!;
  const rows = weeks.map((w) => ({
    week: `${weekLabel(w.start)}${w.partial ? ' (so far)' : ''}`,
    riders: w.riders,
    noShows: w.noShows,
    onTimePct: w.onTimePct,
    revenue: w.revenueCents / 100,
    cost: w.costCents / 100,
    net: (w.revenueCents - w.costCents) / 100,
  }));
  const net = last.revenueCents - last.costCents;

  return (
    <section aria-labelledby="transport-trends" className="space-y-3">
      <SectionTitle as="h2" title={<span id="transport-trends">The last 8 weeks</span>} description="Week by week, Monday to Sunday. Each change compares the last full week with the one before." />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard label="Riders last week" value={last.riders.toLocaleString('en-US')} trend={trendOf(weeks, (w) => w.riders)} />
        <MetricCard
          label="On time"
          value={last.onTimePct === null ? '—' : `${last.onTimePct}%`}
          hint="Van there within 5 minutes of the pickup time"
          trend={trendOf(weeks, (w) => w.onTimePct, (n) => `${n} pts`)}
        />
        <MetricCard
          label="No-show rate"
          value={last.noShowPct === null ? '—' : `${last.noShowPct}%`}
          hint={`${last.noShows} no-show${last.noShows === 1 ? '' : 's'} last week`}
          accent={(last.noShowPct ?? 0) >= 10}
          deltaPositiveIsGood={false}
          trend={trendOf(weeks, (w) => w.noShowPct, (n) => `${n} pts`)}
        />
        <MetricCard
          label="Earned less cost"
          value={`${net < 0 ? '−' : ''}${dollars(Math.abs(net))}`}
          hint={`${dollars(last.revenueCents)} earned · ${dollars(last.costCents)} cost`}
          accent={net < 0}
          trend={trendOf(weeks, (w) => (w.revenueCents - w.costCents) / 100, (n) => fmtMoneyCompact(n))}
        />
      </div>
      <ChartFrame
        title="Earned against cost"
        description={q.data.note}
        summary={`Over the last ${weeks.length} weeks the vans earned ${dollars(weeks.reduce((s, w) => s + w.revenueCents, 0))} and cost ${dollars(weeks.reduce((s, w) => s + w.costCents, 0))}.`}
        csvName="transport-weekly"
        columns={[
          { key: 'week', label: 'Week of' },
          { key: 'riders', label: 'Riders', numeric: true },
          { key: 'noShows', label: 'No-shows', numeric: true },
          { key: 'onTimePct', label: 'On time', numeric: true, format: (v) => (v === null || v === undefined ? '—' : `${v}%`) },
          { key: 'revenue', label: 'Earned', numeric: true, format: (v) => fmtMoney(v as number) },
          { key: 'cost', label: 'Cost', numeric: true, format: (v) => fmtMoney(v as number) },
          { key: 'net', label: 'Net', numeric: true, format: (v) => fmtMoney(v as number) },
        ]}
        rows={rows}
      >
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={PALETTE.grid} vertical={false} />
            <XAxis dataKey="week" tick={TICK} tickLine={false} axisLine={false} />
            <YAxis tick={TICK} tickLine={false} axisLine={false} width={56} tickFormatter={(v: number) => fmtMoneyCompact(v)} />
            <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL_STYLE} cursor={{ fill: PALETTE.cursor }} formatter={(v) => fmtMoney(Number(v))} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="revenue" name="Earned" fill={PALETTE.series[0]} radius={[3, 3, 0, 0]} maxBarSize={28} />
            <Bar dataKey="cost" name="Cost" fill={PALETTE.other} radius={[3, 3, 0, 0]} maxBarSize={28} />
            <Line dataKey="net" name="Net" stroke={PALETTE.series[1]} strokeWidth={2} dot={false} type="monotone" />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartFrame>
    </section>
  );
}
