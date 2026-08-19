import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { RetentionResponse } from '@alto-people/shared';
import { getRetention } from '@/lib/analyticsApi';
import { ApiError } from '@/lib/api';
import { fmtPercent } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/Card';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * Retention analytics: monthly turnover trend, hiring-cohort survival,
 * and store-vs-store comparison. Cohorts smaller than 5 hires render
 * greyed with the raw n — a 100% badge on a cohort of one misleads.
 */

const SMALL_COHORT = 5;

const pct = (v: number | null): string => fmtPercent(v);

export function RetentionSection() {
  const [data, setData] = useState<RetentionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    getRetention()
      .then((r) => setData(r))
      .catch((err) => {
        setError(
          err instanceof ApiError ? err.message : 'Could not load retention data.',
        );
      });
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  // Memoized — recharts re-renders whenever the array identity changes.
  const trend = useMemo(
    () =>
      (data?.monthly ?? []).map((m) => ({
        month: m.month.slice(5),
        turnover: m.turnoverPct,
        hires: m.hires,
        separations: m.separations,
      })),
    [data],
  );
  const hasTrend = trend.some((t) => t.turnover !== null || t.hires > 0);
  const anySmallCohort = (data?.cohorts ?? []).some((c) => c.hires < SMALL_COHORT);

  return (
    <div className="mt-8 space-y-4">
      <h2 className="text-sm font-medium uppercase tracking-wider text-silver">
        Retention
      </h2>
      {error && (
        <ErrorBanner
          action={
            <Button size="sm" variant="secondary" onClick={load}>
              Retry
            </Button>
          }
        >
          {error}
        </ErrorBanner>
      )}
      {/* Reserve roughly the settled height (chart card + two tables) so
          the page doesn't jump when data lands. */}
      {!data && !error && (
        <div className="space-y-4">
          <Skeleton className="h-72" />
          <div className="grid gap-4 lg:grid-cols-2">
            <Skeleton className="h-64" />
            <Skeleton className="h-64" />
          </div>
        </div>
      )}
      {data && (
        <>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Monthly turnover</CardTitle>
              <p className="text-xs text-silver">
                Separations ÷ average headcount, last 12 months. Hires and
                separations in the tooltip.
              </p>
            </CardHeader>
            <CardContent>
              {!hasTrend && (
                <p className="py-8 text-center text-sm text-silver">
                  Not enough history yet — the trend appears once a month has
                  hires or separations.
                </p>
              )}
              {hasTrend && (
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={trend} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
                    <CartesianGrid stroke="rgb(var(--color-silver) / 0.12)" vertical={false} />
                    <XAxis
                      dataKey="month"
                      tick={{ fill: 'rgb(var(--color-silver))', fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      unit="%"
                      tick={{ fill: 'rgb(var(--color-silver))', fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                      width={52}
                    />
                    <Tooltip
                      formatter={(value, name) =>
                        name === 'turnover'
                          ? [`${Number(value)}%`, 'Turnover']
                          : [String(value), String(name ?? '')]
                      }
                      contentStyle={{
                        background: 'rgb(var(--color-navy))',
                        border: '1px solid rgb(var(--color-navy-secondary))',
                        borderRadius: 6,
                        fontSize: 12,
                      }}
                    />
                    <Line
                      type="monotone"
                      dataKey="turnover"
                      stroke="rgb(var(--color-steel))"
                      strokeWidth={2}
                      dot={false}
                      connectNulls
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              )}
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Cohort survival</CardTitle>
                <p className="text-xs text-silver">
                  Of everyone hired that month, the share still active N days
                  later. “—” = cohort not old enough yet.
                </p>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <table className="w-full text-sm tabular-nums">
                  <thead>
                    <tr className="border-b border-navy-secondary text-2xs uppercase tracking-wider text-silver/60">
                      <th className="py-1.5 pr-3 text-left font-medium">Hired</th>
                      <th className="py-1.5 px-2 text-right font-medium">n</th>
                      <th className="py-1.5 px-2 text-right font-medium">30d</th>
                      <th className="py-1.5 px-2 text-right font-medium">60d</th>
                      <th className="py-1.5 px-2 text-right font-medium">90d</th>
                      <th className="py-1.5 pl-2 text-right font-medium">180d</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-navy-secondary/50">
                    {data.cohorts.length === 0 && (
                      <tr>
                        <td colSpan={6} className="py-3 text-silver">
                          No hires in the last 12 months.
                        </td>
                      </tr>
                    )}
                    {data.cohorts.map((c) => {
                      const small = c.hires < SMALL_COHORT;
                      return (
                        <tr
                          key={c.month}
                          className={small ? 'text-silver/50' : 'text-white'}
                          title={small ? `Only ${c.hires} hire${c.hires === 1 ? '' : 's'} — too small to read as a rate` : undefined}
                        >
                          <td className="py-1.5 pr-3">{c.month}</td>
                          <td className="py-1.5 px-2 text-right">{c.hires}</td>
                          <td className="py-1.5 px-2 text-right">{pct(c.s30)}</td>
                          <td className="py-1.5 px-2 text-right">{pct(c.s60)}</td>
                          <td className="py-1.5 px-2 text-right">{pct(c.s90)}</td>
                          <td className="py-1.5 pl-2 text-right">{pct(c.s180)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {/* Visible (keyboard/touch-reachable) version of what used
                    to live only in a hover tooltip. */}
                {anySmallCohort && (
                  <p className="mt-2 text-2xs text-silver/60">
                    Greyed months have fewer than {SMALL_COHORT} hires — too
                    small to read as a rate.
                  </p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">By store</CardTitle>
                <p className="text-xs text-silver">
                  A store that's an outlier here is a management conversation,
                  not a hiring problem. Store = where the associate onboarded.
                </p>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <table className="w-full text-sm tabular-nums">
                  <thead>
                    <tr className="border-b border-navy-secondary text-2xs uppercase tracking-wider text-silver/60">
                      <th className="py-1.5 pr-3 text-left font-medium">Store</th>
                      <th className="py-1.5 px-2 text-right font-medium">Active</th>
                      <th className="py-1.5 px-2 text-right font-medium">Seps (12 mo)</th>
                      <th className="py-1.5 pl-2 text-right font-medium">90d survival</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-navy-secondary/50">
                    {data.byLocation.length === 0 && (
                      <tr>
                        <td colSpan={4} className="py-3 text-silver">
                          No assignment history yet.
                        </td>
                      </tr>
                    )}
                    {data.byLocation.map((l) => (
                      <tr key={l.locationId} className="text-white">
                        <td className="py-1.5 pr-3">{l.locationName}</td>
                        <td className="py-1.5 px-2 text-right">{l.active}</td>
                        <td className="py-1.5 px-2 text-right">{l.separations12mo}</td>
                        <td className="py-1.5 pl-2 text-right">{pct(l.survival90Pct)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
