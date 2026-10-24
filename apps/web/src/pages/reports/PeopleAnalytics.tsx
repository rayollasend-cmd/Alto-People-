import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, ComposedChart, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { STOCK_LEGEND, seriesColor } from '@/components/ui/charts';
import { Download, Users } from '@/components/ui/icons';
import { useTenant, useTerm } from '@/lib/auth';
import { downloadCsv } from '@/lib/csv';
import { fmtMonth, ymdLocal } from '@/lib/format';
import { urlEnum, urlNumber, useUrlState, type UrlCodec } from '@/lib/useUrlState';
import { getPeopleAnalytics, type PeopleAnalytics as PeopleAnalyticsData, type TurnoverGroup } from '@/lib/peopleAnalyticsApi';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { CHART, ChartFrame } from '@/components/ui/ChartFrame';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { EmptyState } from '@/components/ui/EmptyState';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { QueryError } from '@/components/ui/QueryError';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { SkeletonRows } from '@/components/ui';
import { ListTemplate } from '@/components/templates';
import { cn } from '@/lib/cn';

/**
 * People analytics: the questions a staffing company asks of its people,
 * drawn — the headcount trend (company or by store), where early leavers
 * leave (store × how long they lasted), the first 90 days cohort by cohort,
 * how long seats take to fill by client and position, and absence month by
 * month. Every chart has its table one click away (and always to a screen
 * reader) and a CSV. Computed from the records at request time.
 */

const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v}%`);
/** "Nov 2025" — one month formatter for the axes, the tables and the CSVs. */
const monthLabel = (ym: string) => fmtMonth(ym);
const WINDOWS = [6, 12, 24] as const;
/** ?months= — one of the windows; anything else reads as 12. */
const MONTHS_CODEC: UrlCodec<number> = {
  parse: (raw) => {
    const n = urlNumber({ integer: true }).parse(raw);
    return n !== undefined && (WINDOWS as readonly number[]).includes(n) ? n : undefined;
  },
  serialize: (n) => String(n),
};
const TREND_BY = urlEnum(['company', 'store'] as const);

/** A site row's name: an active site as the API labels it ("Client · Site"); every closed site as one row. */
function useSiteLabel() {
  const term = useTerm();
  return (r: { label?: string; storeName?: string; inactive?: boolean; siteCount?: number }) =>
    r.inactive
      ? `Inactive ${term('label.stores').toLowerCase()}${r.siteCount ? ` (${r.siteCount})` : ''}`
      : (r.label ?? r.storeName ?? '—');
}
const axis = { fill: CHART.axis, fontSize: 11 };

function TurnoverTable({ id, caption, rows, header }: { id: string; caption: string; rows: TurnoverGroup[]; header: string }) {
  const siteLabel = useSiteLabel();
  const columns: GridColumn<TurnoverGroup>[] = [
    { key: 'label', header, accessor: (r) => siteLabel(r), sortable: true, primary: true, className: 'text-ink' },
    { key: 'headcount', header: 'On the books', accessor: (r) => r.headcount, sortable: true, searchable: false, align: 'right', className: 'tabular-nums' },
    { key: 'separations', header: 'Left', accessor: (r) => r.separations, sortable: true, searchable: false, align: 'right', className: 'tabular-nums' },
    { key: 'rate', header: 'Annualized turnover', accessor: (r) => r.annualizedTurnoverPct ?? -1, sortable: true, searchable: false, align: 'right', cell: (r) => <span className={cn('tabular-nums', (r.annualizedTurnoverPct ?? 0) >= 50 ? 'text-alert' : (r.annualizedTurnoverPct ?? 0) >= 25 ? 'text-warning' : 'text-ink')}>{pct(r.annualizedTurnoverPct)}</span> },
  ];
  return <DataGrid<TurnoverGroup> id={id} caption={caption} empty={{ title: 'No one on the books or leaving in this window' }} rows={rows} rowKey={(r) => r.key} search={{ placeholder: `${header}…` }} urlState={false} exportCsv={{ filename: id }} columns={columns} />;
}

/** Where early leavers leave: store rows, tenure-band columns, shaded by share of the store's leavers. */
function EarlyTurnoverGrid({ d }: { d: PeopleAnalyticsData }) {
  const term = useTerm();
  const hasClients = useTenant().moduleOn('clientPortal');
  const siteLabel = useSiteLabel();
  const grid = d.turnoverGrid;
  if (!grid || grid.rows.length === 0) {
    return (
      <Card>
        <CardContent className="p-0">
          <EmptyState icon={Users} title="No one left in this window" description={`When people leave, this shows which ${term('label.stores').toLowerCase()} lose them and how early.`} />
        </CardContent>
      </Card>
    );
  }
  const shade = (n: number, of: number) => {
    if (n === 0 || of === 0) return '';
    const r = n / of;
    return r >= 0.5 ? 'bg-alert/30 font-medium' : r >= 0.25 ? 'bg-alert/15' : 'bg-alert/5';
  };
  const csv = () =>
    downloadCsv(`early-turnover-${ymdLocal()}.csv`, [
      [...(hasClients ? [term('label.client')] : []), term('label.store'), 'Hired in window', 'Left in window', ...grid.bands.map((b) => b.label)],
      ...grid.rows.map((r) => [...(hasClients ? [r.clientName ?? ''] : []), siteLabel(r), String(r.hires), String(r.separations), ...r.bands.map(String)]),
    ]);
  return (
    <Card>
      <CardContent className="space-y-3">
        <SectionTitle
          title="Where early leavers leave"
          description={`People who left in the window, by ${term('label.store').toLowerCase()} and how long they had been there. Darker = a bigger share of that ${term('label.store').toLowerCase()}’s leavers.`}
          trailing={
            <Button size="sm" variant="ghost" onClick={csv} aria-label="Download early turnover as CSV">
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              CSV
            </Button>
          }
        />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Separations by {term('label.store').toLowerCase()} and tenure at leaving</caption>
            <thead>
              <tr className="border-b border-line text-xs text-ink-muted">
                <th scope="col" className="px-2 py-1.5 text-left font-medium">
                  {term('label.store')}
                </th>
                <th scope="col" className="px-2 py-1.5 text-right font-medium">
                  Hired
                </th>
                <th scope="col" className="px-2 py-1.5 text-right font-medium">
                  Left
                </th>
                {grid.bands.map((b) => (
                  <th key={b.key} scope="col" className="px-2 py-1.5 text-center font-medium">
                    {b.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grid.rows.map((r) => (
                <tr key={r.storeId} className="border-b border-line/60 last:border-0">
                  <th scope="row" className="px-2 py-1.5 text-left font-normal">
                    <div className={r.inactive ? 'text-ink-muted' : 'text-ink'}>{siteLabel(r)}</div>
                    {hasClients && r.clientName && <div className="text-2xs text-ink-muted">{r.clientName}</div>}
                  </th>
                  <td className="px-2 py-1.5 text-right tabular-nums text-ink">{r.hires}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-ink">{r.separations}</td>
                  {r.bands.map((n, k) => (
                    <td key={k} className="px-1 py-1 text-center">
                      <span className={cn('block rounded px-2 py-1 tabular-nums text-ink', shade(n, r.separations))}>{n || <span className="text-ink-subtle">·</span>}</span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

export function PeopleAnalytics() {
  const term = useTerm();
  const hasClients = useTenant().moduleOn('clientPortal');
  // The window and the trend's cut live in the URL, so Back and a shared link keep them.
  const [months, setMonths] = useUrlState<number>('months', 12, MONTHS_CODEC);
  const [trendBy, setTrendBy] = useUrlState<'company' | 'store'>('by', 'company', TREND_BY);
  const query = useQuery({ queryKey: ['people-analytics', months], queryFn: () => getPeopleAnalytics(months) });
  const d: PeopleAnalyticsData | undefined = query.data;
  const headcountNow = d?.headcount[d.headcount.length - 1]?.headcount ?? null;
  const headcountThen = d?.headcount[0]?.headcount ?? null;

  const trend = useMemo(() => (d ? d.headcount.map((h) => ({ month: monthLabel(h.month), headcount: h.headcount, hires: h.hires, left: h.separations })) : []), [d]);
  const storeTrend = useMemo(() => {
    if (!d?.headcountByStore?.length) return [];
    return d.headcount.map((h, k) => {
      const row: Record<string, string | number> = { month: monthLabel(h.month) };
      for (const st of d.headcountByStore!) row[st.storeName] = st.series[k] ?? 0;
      return row;
    });
  }, [d]);
  const survivalRows = useMemo(() => {
    // No cohort has reached a single milestone yet: nothing to draw (not an empty axis).
    if (!d?.survival?.some((c) => c.points.some((p) => p.pct !== null))) return [];
    const days = d.survival[0]!.points.map((p) => p.day);
    return days.map((day, k) => {
      const row: Record<string, string | number | null> = { day: `Day ${day}` };
      for (const c of d.survival!) row[monthLabel(c.month)] = c.points[k]?.pct ?? null;
      return row;
    });
  }, [d]);
  const absence = useMemo(() => {
    const rows = (d?.absenceTrend ?? []).map((a) => ({ month: monthLabel(a.month), rate: a.absenceRatePct, days: a.absenceDays, scheduled: a.scheduledShiftDays }));
    // No shifts and no days off all window: a 0% line would be a reading of nothing.
    return rows.some((r) => r.days > 0 || r.scheduled > 0) ? rows : [];
  }, [d]);
  // Turnover by tenure with nobody leaving in the window is 0% in every band: say
  // that in a line instead of drawing four empty bars on an axis (F500 G4).
  const nobodyLeft = !!d && d.turnover.byTenure.every((b) => b.separations === 0);
  const tenureRows = d && !nobodyLeft ? d.turnover.byTenure : [];
  const fillByClient = d?.timeToFill.byClient ?? [];
  const fillByPosition = d?.timeToFill.byPosition ?? [];

  return (
    <ListTemplate
      title="People analytics"
      subtitle={`Who is on the books, who leaves and how early, the first 90 days, time to fill and absence — by ${term('label.store').toLowerCase()} where it matters. Computed from the records as of now.`}
      related={[
        { label: 'Report builder', to: '/reports' },
        { label: 'Analytics', to: '/analytics' },
      ]}
      summary={
        <div className="space-y-3">
        {/* The window first: it sets every number under it. */}
        <SegmentedControl ariaLabel="Window" options={WINDOWS.map((m) => ({ value: m, label: `${m} months` }))} value={months} onChange={(m) => setMonths(m)} />
        <MetricStrip label="People at a glance">
          <MetricCard label="Annualized turnover" value={d ? pct(d.turnover.annualizedPct) : '—'} accent={Boolean(d && (d.turnover.annualizedPct ?? 0) >= 25)} hint={d ? `${d.turnover.separations} left · average ${d.turnover.averageHeadcount} on the books` : undefined} />
          {/* "On the books" (hired, not separated): the number Headcount and Analytics show (apps/api/src/lib/peopleStatus.ts). */}
          <MetricCard label="On the books" value={headcountNow ?? '—'} valueTitle="Hired and not separated" hint={headcountThen !== null && headcountNow !== null ? `${headcountNow - headcountThen >= 0 ? '+' : ''}${headcountNow - headcountThen} since ${d ? monthLabel(d.headcount[0]!.month) : ''}` : undefined} />
          <MetricCard label="Median time to fill" value={d && d.timeToFill.medianDays !== null ? `${d.timeToFill.medianDays} days` : '—'} hint={d ? `${d.timeToFill.filled} seats filled in the window` : undefined} />
          <MetricCard label="Absence rate" value={d ? pct(d.absence.absenceRatePct) : '—'} hint={d ? `${d.absence.absenceDays} days off against ${d.absence.scheduledShiftDays} shift days` : undefined} />
        </MetricStrip>
        </div>
      }
    >
      {query.isError && <QueryError what="people analytics" query={query} />}
      {!d && !query.isError ? (
        <SkeletonRows count={8} />
      ) : d ? (
        <div className="space-y-5">
          <ChartFrame
            title="On the books, month by month"
            description={
              d.headcountByStore?.length ? (
                <SegmentedControl
                  ariaLabel="Headcount for"
                  value={trendBy}
                  onChange={setTrendBy}
                  options={[
                    { value: 'company' as const, label: 'Everyone' },
                    { value: 'store' as const, label: `By ${term('label.store').toLowerCase()}` },
                  ]}
                />
              ) : (
                'Hired and not separated at each month’s end, with the hires and leavers that moved it.'
              )
            }
            summary={
              trendBy === 'company'
                ? `On the books went from ${headcountThen ?? 0} to ${headcountNow ?? 0} over ${months} months, with ${trend.reduce((s, t) => s + t.hires, 0)} hires and ${trend.reduce((s, t) => s + t.left, 0)} leavers.`
                : `On the books by ${term('label.store').toLowerCase()} for the ${d.headcountByStore?.length ?? 0} busiest.`
            }
            columns={
              trendBy === 'company'
                ? [
                    { key: 'month', label: 'Month' },
                    { key: 'headcount', label: 'On the books', numeric: true },
                    { key: 'hires', label: 'Hires', numeric: true },
                    { key: 'left', label: 'Left', numeric: true },
                  ]
                : [{ key: 'month', label: 'Month' }, ...(d.headcountByStore ?? []).map((s) => ({ key: s.storeName, label: s.clientName ? `${s.clientName} · ${s.storeName}` : s.storeName, numeric: true }))]
            }
            rows={trendBy === 'company' ? trend : storeTrend}
            csvName={trendBy === 'company' ? 'headcount-trend' : 'headcount-by-store'}
          >
            <ResponsiveContainer width="100%" height="100%">
              {trendBy === 'company' ? (
                <ComposedChart data={trend} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke={CHART.grid} vertical={false} />
                  <XAxis dataKey="month" tick={axis} tickLine={false} axisLine={false} />
                  <YAxis allowDecimals={false} tick={axis} tickLine={false} axisLine={false} width="auto" />
                  <Tooltip contentStyle={CHART.tooltip} labelStyle={CHART.tooltipLabel} itemStyle={CHART.tooltipItem} />
                  <Legend {...STOCK_LEGEND} />
                  <Bar dataKey="hires" name="Hires" fill={CHART.good} radius={[3, 3, 0, 0]} />
                  <Bar dataKey="left" name="Left" fill={CHART.bad} radius={[3, 3, 0, 0]} />
                  <Line dataKey="headcount" name="On the books" stroke={CHART.series[0]} strokeWidth={2} dot={false} />
                </ComposedChart>
              ) : (
                <LineChart data={storeTrend} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke={CHART.grid} vertical={false} />
                  <XAxis dataKey="month" tick={axis} tickLine={false} axisLine={false} />
                  <YAxis allowDecimals={false} tick={axis} tickLine={false} axisLine={false} width="auto" />
                  <Tooltip contentStyle={CHART.tooltip} labelStyle={CHART.tooltipLabel} itemStyle={CHART.tooltipItem} />
                  <Legend {...STOCK_LEGEND} />
                  {/* Five hues, never a sixth: the rest draw thin in "Other" gray, off the legend (the table names them). */}
                  {(d.headcountByStore ?? []).map((s, i) => (
                    <Line key={s.storeId} dataKey={s.storeName} stroke={i < 5 ? seriesColor(i) : CHART.other} strokeWidth={i < 5 ? 2 : 1} dot={false} legendType={i < 5 ? undefined : 'none'} />
                  ))}
                </LineChart>
              )}
            </ResponsiveContainer>
          </ChartFrame>

          <EarlyTurnoverGrid d={d} />

          {/* items-start: an empty card keeps its own height instead of stretching to its neighbour's chart. */}
          <div className="grid items-start gap-5 lg:grid-cols-2">
            <ChartFrame
              title="The first 90 days"
              description="Share of each hiring month still here, week by week."
              summary={`Survival over the first 90 days for the last ${d.survival?.length ?? 0} hiring months.`}
              columns={[{ key: 'day', label: 'Day' }, ...(d.survival ?? []).map((c) => ({ key: monthLabel(c.month), label: `${monthLabel(c.month)} (${c.hires})`, numeric: true, format: (v: unknown) => pct(v as number | null) }))]}
              rows={survivalRows}
              csvName="first-90-days"
              empty={<p className="text-sm text-ink-muted">Nobody was hired in this window.</p>}
            >
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={survivalRows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke={CHART.grid} vertical={false} />
                  <XAxis dataKey="day" tick={axis} tickLine={false} axisLine={false} interval={2} />
                  <YAxis domain={[0, 100]} tickFormatter={(v: number) => `${v}%`} tick={axis} tickLine={false} axisLine={false} width="auto" />
                  <Tooltip contentStyle={CHART.tooltip} labelStyle={CHART.tooltipLabel} itemStyle={CHART.tooltipItem} formatter={(v) => pct(v as number | null)} />
                  <Legend {...STOCK_LEGEND} />
                  {/* The five most recent hiring months in color; older ones thin and gray. */}
                  {(d.survival ?? []).map((c, i, all) => {
                    const rank = all.length - 1 - i;
                    return (
                      <Line key={c.month} dataKey={monthLabel(c.month)} stroke={rank < 5 ? seriesColor(rank) : CHART.other} strokeWidth={rank < 5 ? 2 : 1} dot={false} connectNulls={false} legendType={rank < 5 ? undefined : 'none'} />
                    );
                  })}
                </LineChart>
              </ResponsiveContainer>
            </ChartFrame>

            <ChartFrame
              title="Turnover by tenure"
              description="Annualized, so a 6-month window reads like a year."
              summary={`Annualized turnover by tenure band: ${d.turnover.byTenure.map((b) => `${b.label} ${pct(b.annualizedTurnoverPct)}`).join(', ')}.`}
              columns={[
                { key: 'label', label: 'Tenure' },
                { key: 'headcount', label: 'On the books', numeric: true },
                { key: 'separations', label: 'Left', numeric: true },
                { key: 'annualizedTurnoverPct', label: 'Annualized', numeric: true, format: (v) => pct(v as number | null) },
              ]}
              rows={tenureRows}
              csvName="turnover-by-tenure"
              empty={
                <p className="text-sm text-ink-muted">
                  {d.turnover.byTenure.some((b) => b.headcount > 0) ? 'Nobody left in this window: turnover is 0% in every tenure band.' : 'No one on the books or leaving in this window.'}
                </p>
              }
            >
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={d.turnover.byTenure} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke={CHART.grid} vertical={false} />
                  <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={false} />
                  <YAxis tickFormatter={(v: number) => `${v}%`} tick={axis} tickLine={false} axisLine={false} width="auto" />
                  <Tooltip contentStyle={CHART.tooltip} labelStyle={CHART.tooltipLabel} itemStyle={CHART.tooltipItem} formatter={(v) => pct(v as number | null)} />
                  <Bar dataKey="annualizedTurnoverPct" name="Annualized turnover" fill={CHART.series[0]} radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </ChartFrame>
          </div>

          <CohortGrid cohorts={d.cohorts} />

          <div className="grid items-start gap-5 lg:grid-cols-2">
            <ChartFrame
              title={hasClients ? `Time to fill, by ${term('label.client').toLowerCase()}` : 'Time to fill, by department'}
              description="Median days from a seat opening to its fill."
              summary={`Median time to fill is ${d.timeToFill.medianDays ?? '—'} days across ${d.timeToFill.filled} seats.`}
              columns={[
                { key: 'label', label: hasClients ? term('label.client') : 'Department' },
                { key: 'filled', label: 'Filled', numeric: true },
                { key: 'medianDays', label: 'Median days', numeric: true },
              ]}
              rows={hasClients && fillByClient.length ? fillByClient : d.timeToFill.byDepartment.map((r) => ({ label: r.department, filled: r.filled, medianDays: r.medianDays }))}
              csvName="time-to-fill"
              empty={<p className="text-sm text-ink-muted">No seats were filled in this window.</p>}
            >
              <ResponsiveContainer width="100%" height="100%">
                <BarChart layout="vertical" data={hasClients && fillByClient.length ? fillByClient : d.timeToFill.byDepartment.map((r) => ({ label: r.department, medianDays: r.medianDays }))} margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
                  <CartesianGrid stroke={CHART.grid} horizontal={false} />
                  <XAxis type="number" tick={axis} tickLine={false} axisLine={false} />
                  <YAxis type="category" dataKey="label" width={120} tick={axis} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={CHART.tooltip} labelStyle={CHART.tooltipLabel} itemStyle={CHART.tooltipItem} />
                  <Bar dataKey="medianDays" name="Median days" fill={CHART.series[1]} radius={[0, 3, 3, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </ChartFrame>

            <ChartFrame
              title="Absence, month by month"
              description="Approved days off against scheduled shift days."
              summary={`Absence rate ${pct(d.absence.absenceRatePct)} over the window.`}
              columns={[
                { key: 'month', label: 'Month' },
                { key: 'days', label: 'Days off', numeric: true },
                { key: 'scheduled', label: 'Shift days', numeric: true },
                { key: 'rate', label: 'Absence rate', numeric: true, format: (v) => pct(v as number | null) },
              ]}
              rows={absence}
              csvName="absence-trend"
              empty={<p className="text-sm text-ink-muted">No shifts or days off in this window.</p>}
            >
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={absence} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke={CHART.grid} vertical={false} />
                  <XAxis dataKey="month" tick={axis} tickLine={false} axisLine={false} />
                  <YAxis tickFormatter={(v: number) => `${v}%`} tick={axis} tickLine={false} axisLine={false} width="auto" />
                  <Tooltip contentStyle={CHART.tooltip} labelStyle={CHART.tooltipLabel} itemStyle={CHART.tooltipItem} formatter={(v) => pct(v as number | null)} />
                  <Line dataKey="rate" name="Absence rate" stroke={CHART.warn} strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </ChartFrame>
          </div>

          {fillByPosition.length > 0 && (
            <ChartFrame
              title="Slowest positions to fill"
              summary={`The slowest position to fill takes a median of ${fillByPosition[0]!.medianDays ?? '—'} days.`}
              columns={[
                { key: 'label', label: 'Position' },
                { key: 'filled', label: 'Filled', numeric: true },
                { key: 'medianDays', label: 'Median days', numeric: true },
              ]}
              rows={fillByPosition}
              csvName="time-to-fill-by-position"
              height={Math.max(160, fillByPosition.length * 28)}
            >
              <ResponsiveContainer width="100%" height="100%">
                <BarChart layout="vertical" data={fillByPosition} margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
                  <CartesianGrid stroke={CHART.grid} horizontal={false} />
                  <XAxis type="number" tick={axis} tickLine={false} axisLine={false} />
                  <YAxis type="category" dataKey="label" width={160} tick={axis} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={CHART.tooltip} labelStyle={CHART.tooltipLabel} itemStyle={CHART.tooltipItem} />
                  <Bar dataKey="medianDays" name="Median days" fill={CHART.series[2]} radius={[0, 3, 3, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </ChartFrame>
          )}

          <section className="space-y-3">
            <SectionTitle as="h2" title={`Turnover by ${term('label.store').toLowerCase()} and by manager`} description="The full tables, sortable." />
            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardContent className="p-3">
                  <TurnoverTable id="people-analytics-site" caption={`Turnover by ${term('label.store').toLowerCase()}`} rows={d.turnover.bySite} header={term('label.store')} />
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-3">
                  <TurnoverTable id="people-analytics-manager" caption="Turnover by manager" rows={d.turnover.byManager} header="Manager" />
                </CardContent>
              </Card>
            </div>
          </section>
        </div>
      ) : null}
    </ListTemplate>
  );
}

/* ----- Hiring cohorts: who is still here at 30, 60, 90 and 180 days ------ */

const HORIZONS = [
  { key: 's30', label: '30 days' },
  { key: 's60', label: '60 days' },
  { key: 's90', label: '90 days' },
  { key: 's180', label: '180 days' },
] as const;

/**
 * The classic cohort triangle: one row per hiring month, the share of that
 * month's hires still here at each milestone. A cell stays empty until the
 * whole cohort is old enough to count; the stronger the tint, the more stayed.
 */
function CohortGrid({ cohorts }: { cohorts: PeopleAnalyticsData['cohorts'] }) {
  const rows = cohorts.filter((c) => c.hires > 0).map((c) => ({ month: monthLabel(c.month), hires: c.hires, s30: c.s30, s60: c.s60, s90: c.s90, s180: c.s180 }));
  const latest90 = [...rows].reverse().find((r) => r.s90 !== null);
  return (
    <ChartFrame
      title="Hiring cohorts"
      description="Each hiring month, and the share still here at 30, 60, 90 and 180 days. Blank until the whole month’s hires are old enough to count."
      summary={latest90 ? `Of ${latest90.month}’s ${latest90.hires} hires, ${pct(latest90.s90)} were still here at 90 days.` : 'No cohort is 90 days old yet.'}
      csvName="hiring-cohorts"
      height={Math.max(120, rows.length * 32 + 36)}
      columns={[
        { key: 'month', label: 'Hired in' },
        { key: 'hires', label: 'Hires', numeric: true },
        ...HORIZONS.map((h) => ({ key: h.key, label: h.label, numeric: true, format: (v: unknown) => pct(v as number | null) })),
      ]}
      rows={rows}
      empty={<p className="text-sm text-ink-muted">Nobody was hired in this window.</p>}
    >
      <div className="h-full overflow-auto" aria-hidden="true">
        <div className="grid min-w-[28rem] grid-cols-[minmax(6rem,1fr)_4rem_repeat(4,minmax(4.5rem,1fr))] gap-1 text-xs">
          <span className="px-2 py-1 text-ink-muted">Hired in</span>
          <span className="px-2 py-1 text-right text-ink-muted">Hires</span>
          {HORIZONS.map((h) => (
            <span key={h.key} className="px-2 py-1 text-center text-ink-muted">
              {h.label}
            </span>
          ))}
          {rows.map((r) => (
            <CohortRow key={r.month} row={r} />
          ))}
        </div>
      </div>
    </ChartFrame>
  );
}

function CohortRow({ row }: { row: { month: string; hires: number; s30: number | null; s60: number | null; s90: number | null; s180: number | null } }) {
  return (
    <>
      <span className="truncate px-2 py-1.5 text-ink">{row.month}</span>
      <span className="px-2 py-1.5 text-right tabular-nums text-ink-muted">{row.hires}</span>
      {HORIZONS.map((h) => {
        const v = row[h.key];
        return (
          <span
            key={h.key}
            className={cn('rounded px-2 py-1.5 text-center tabular-nums', v === null ? 'text-ink-muted/50' : 'text-ink')}
            style={v === null ? undefined : { background: `rgb(var(--color-success) / ${(0.08 + (v / 100) * 0.5).toFixed(2)})` }}
          >
            {v === null ? '·' : `${v}%`}
          </span>
        );
      })}
    </>
  );
}
