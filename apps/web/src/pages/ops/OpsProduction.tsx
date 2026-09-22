import { useMemo, useState } from 'react';
import { Minus, TrendingDown, TrendingUp } from 'lucide-react';
import {
  Bar,
  BarChart,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { cn } from '@/lib/cn';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { metricLabel, type getOpsScorecard } from '@/lib/opsApi';
import { fmtShortDayKey } from './opsTime';

type Scorecard = Awaited<ReturnType<typeof getOpsScorecard>>;
type Trend = Scorecard['metricTrends'][number];

/**
 * Production trends — what the floor actually produced, week over week.
 *
 * The old card drew four identical gold sparklines and a grand total.
 * That is a picture of volume, not a trend: it never said whether a line
 * was rising or falling, never marked the average it was moving around,
 * and treated "items discarded" as good news whenever it went up.
 *
 * This one gives each metric a direction and a judgement. Bars, not an
 * area — a weekly total is a count of discrete things, and an area
 * implies a continuum between Saturdays. The dashed line is the window's
 * mean, so a reader can see which weeks were genuinely unusual.
 */

/** Metrics where MORE is worse. Everything else reads more as better. */
const LOWER_IS_BETTER = new Set([
  'items_discarded',
  'oos_found',
  'freight_left',
  'price_changes',
]);

const SERIES = 'rgb(var(--color-chart-1))';
const MUTED = 'rgb(var(--color-chart-1) / 0.35)';

/** The org week runs Saturday to Friday; the key is that Saturday. */
const weekLabel = fmtShortDayKey;

interface Read {
  latest: number;
  prior: number | null;
  deltaPct: number | null;
  mean: number;
  good: boolean | null;
}

function readTrend(t: Trend): Read {
  const weeks = t.weeks;
  const latest = weeks.at(-1)?.total ?? 0;
  const prior = weeks.length > 1 ? (weeks.at(-2)?.total ?? 0) : null;
  const mean = weeks.length ? weeks.reduce((n, w) => n + w.total, 0) / weeks.length : 0;
  // A change from nothing is not a percentage, so it stays unstated.
  const deltaPct = prior && prior > 0 ? Math.round(((latest - prior) / prior) * 100) : null;
  const lowerBetter = LOWER_IS_BETTER.has(t.metricKey);
  const good =
    deltaPct == null || deltaPct === 0 ? null : lowerBetter ? deltaPct < 0 : deltaPct > 0;
  return { latest, prior, deltaPct, mean, good };
}

function Delta({ read }: { read: Read }) {
  if (read.deltaPct == null) {
    return (
      <span className="inline-flex items-center gap-1 text-2xs text-silver/50">
        <Minus className="h-3 w-3" aria-hidden="true" />
        no prior week
      </span>
    );
  }
  const Icon = read.deltaPct > 0 ? TrendingUp : read.deltaPct < 0 ? TrendingDown : Minus;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-2xs tabular-nums',
        read.good === true ? 'text-success' : read.good === false ? 'text-alert' : 'text-silver/60',
      )}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {read.deltaPct > 0 ? '+' : ''}
      {read.deltaPct}% vs last week
    </span>
  );
}

function MetricPanel({ t }: { t: Trend }) {
  const read = readTrend(t);
  const data = t.weeks.map((w) => ({ ...w, label: weekLabel(w.weekKey) }));
  const lastKey = t.weeks.at(-1)?.weekKey;
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-xs font-medium text-white">{metricLabel(t.metricKey)}</span>
        <span className="shrink-0 text-2xs tabular-nums text-silver/60">
          {t.total.toLocaleString('en-US')} {t.unit ?? ''} total
        </span>
      </div>
      <div className="mt-0.5 flex items-baseline gap-2">
        <span className="text-lg font-semibold tabular-nums leading-none text-white">
          {read.latest.toLocaleString('en-US')}
        </span>
        <span className="text-2xs text-silver/50">this week</span>
        <Delta read={read} />
      </div>
      <div className="mt-1.5 h-24">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 6, right: 4, bottom: 0, left: -24 }}>
            <XAxis
              dataKey="label"
              tick={{ fill: 'rgb(var(--color-silver) / 0.55)', fontSize: 9 }}
              axisLine={false}
              tickLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              tick={{ fill: 'rgb(var(--color-silver) / 0.6)', fontSize: 9 }}
              axisLine={false}
              tickLine={false}
              width={38}
              allowDecimals={false}
            />
            {/* The window's mean, so an unusual week looks unusual. */}
            <ReferenceLine
              y={read.mean}
              stroke="rgb(var(--color-silver) / 0.5)"
              strokeDasharray="3 3"
            />
            <ChartTooltip
              cursor={{ fill: 'rgb(var(--color-navy-secondary) / 0.5)' }}
              contentStyle={{
                background: 'rgb(var(--color-navy))',
                border: '1px solid rgb(var(--color-navy-secondary))',
                borderRadius: 8,
                fontSize: 11,
              }}
              labelFormatter={(v) => `Week of ${String(v)}`}
              formatter={(value) => [
                `${Number(value).toLocaleString('en-US')} ${t.unit ?? ''}`,
                metricLabel(t.metricKey),
              ]}
            />
            <Bar dataKey="total" radius={[4, 4, 0, 0]} maxBarSize={26}>
              {data.map((d) => (
                // The current week carries the full step; the weeks behind
                // it recede, so the eye lands on the number that is live.
                <Cell key={d.weekKey} fill={d.weekKey === lastKey ? SERIES : MUTED} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function OpsProduction({ scorecard }: { scorecard: Scorecard | null }) {
  const [showTable, setShowTable] = useState(false);
  const trends = scorecard?.metricTrends ?? [];
  const weekKeys = useMemo(
    () => (trends[0]?.weeks ?? []).map((w) => w.weekKey),
    [trends],
  );
  if (!scorecard || trends.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <CardTitle className="text-base">
            Production trends
            <span className="ml-2 text-xs font-normal text-silver/60">
              {scorecard.weeks} org weeks, Saturday to Friday
            </span>
          </CardTitle>
          <Button size="xs" variant="ghost" onClick={() => setShowTable((v) => !v)}>
            {showTable ? 'Hide the numbers' : 'Details'}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-5 sm:grid-cols-2">
          {trends.map((t) => (
            <MetricPanel key={t.metricKey} t={t} />
          ))}
        </div>
        <p className="text-2xs text-silver/50">
          The dashed line is the window&rsquo;s weekly mean. Green means the week moved the right
          way for that metric — more cases stocked is good, more items discarded is not.
        </p>
        {/* The table twin: nothing here is gated on hover or on colour. */}
        {showTable && (
          <div className="overflow-x-auto border-t border-navy-secondary/60 pt-3">
            <table className="w-full text-left text-xs">
              <caption className="sr-only">Weekly production totals by metric</caption>
              <thead>
                <tr className="text-2xs uppercase tracking-wider text-silver/60">
                  <th scope="col" className="py-1 pr-3 font-normal">
                    Metric
                  </th>
                  {weekKeys.map((k) => (
                    <th key={k} scope="col" className="py-1 pr-3 text-right font-normal">
                      {weekLabel(k)}
                    </th>
                  ))}
                  <th scope="col" className="py-1 text-right font-normal">
                    Total
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-navy-secondary/40">
                {trends.map((t) => (
                  <tr key={t.metricKey}>
                    <th scope="row" className="py-1.5 pr-3 font-normal text-white">
                      {metricLabel(t.metricKey)}
                      {t.unit && <span className="ml-1 text-silver/50">({t.unit})</span>}
                    </th>
                    {t.weeks.map((w) => (
                      <td key={w.weekKey} className="py-1.5 pr-3 text-right tabular-nums text-silver">
                        {w.total.toLocaleString('en-US')}
                      </td>
                    ))}
                    <td className="py-1.5 text-right tabular-nums text-white">
                      {t.total.toLocaleString('en-US')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
