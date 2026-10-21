import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, ComposedChart, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ArrowLeft, Download, Users } from 'lucide-react';
import { useTenant, useTerm } from '@/lib/auth';
import { downloadCsv } from '@/lib/csv';
import { fmtDate, parseYmd, ymdLocal } from '@/lib/format';
import { getPeopleAnalytics, type PeopleAnalytics as PeopleAnalyticsData, type TurnoverGroup } from '@/lib/peopleAnalyticsApi';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { CHART, ChartFrame } from '@/components/ui/ChartFrame';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { EmptyState } from '@/components/ui/EmptyState';
import { MetricCard } from '@/components/ui/MetricCard';
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
const monthLabel = (ym: string) => fmtDate(parseYmd(`${ym}-01`)).replace(/ \d{1,2},/, ',').replace(/,\s*/, ' ');
const axis = { fill: CHART.axis, fontSize: 11 };

function TurnoverTable({ id, caption, rows, header }: { id: string; caption: string; rows: TurnoverGroup[]; header: string }) {
  const columns: GridColumn<TurnoverGroup>[] = [
    { key: 'label', header, accessor: (r) => r.label, sortable: true, primary: true, className: 'text-ink' },
    { key: 'headcount', header: 'Active', accessor: (r) => r.headcount, sortable: true, searchable: false, align: 'right', className: 'tabular-nums' },
    { key: 'separations', header: 'Left', accessor: (r) => r.separations, sortable: true, searchable: false, align: 'right', className: 'tabular-nums' },
    { key: 'rate', header: 'Annualized turnover', accessor: (r) => r.annualizedTurnoverPct ?? -1, sortable: true, searchable: false, align: 'right', cell: (r) => <span className={cn('tabular-nums', (r.annualizedTurnoverPct ?? 0) >= 50 ? 'text-alert' : (r.annualizedTurnoverPct ?? 0) >= 25 ? 'text-warning' : 'text-ink')}>{pct(r.annualizedTurnoverPct)}</span> },
  ];
  return <DataGrid<TurnoverGroup> id={id} caption={caption} rows={rows} rowKey={(r) => r.key} search={{ placeholder: `${header}…` }} urlState={false} exportCsv={{ filename: id }} columns={columns} />;
}

/** Where early leavers leave: store rows, tenure-band columns, shaded by share of the store's leavers. */
function EarlyTurnoverGrid({ d }: { d: PeopleAnalyticsData }) {
  const term = useTerm();
  const hasClients = useTenant().moduleOn('clientPortal');
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
      ...grid.rows.map((r) => [...(hasClients ? [r.clientName ?? ''] : []), r.storeName, String(r.hires), String(r.separations), ...r.bands.map(String)]),
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
                    <div className="text-ink">{r.storeName}</div>
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
  const [months, setMonths] = useState<6 | 12 | 24>(12);
  const [trendBy, setTrendBy] = useState<'company' | 'store'>('company');
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
    if (!d?.survival?.length) return [];
    const days = d.survival[0]!.points.map((p) => p.day);
    return days.map((day, k) => {
      const row: Record<string, string | number | null> = { day: `Day ${day}` };
      for (const c of d.survival!) row[monthLabel(c.month)] = c.points[k]?.pct ?? null;
      return row;
    });
  }, [d]);
  const absence = useMemo(() => (d?.absenceTrend ?? []).map((a) => ({ month: monthLabel(a.month), rate: a.absenceRatePct, days: a.absenceDays, scheduled: a.scheduledShiftDays })), [d]);
  const fillByClient = d?.timeToFill.byClient ?? [];
  const fillByPosition = d?.timeToFill.byPosition ?? [];

  return (
    <ListTemplate
      title="People analytics"
      subtitle={`Headcount, who leaves and how early, the first 90 days, time to fill and absence — by ${term('label.store').toLowerCase()} where it matters. Computed from the records as of now.`}
      breadcrumbs={[{ label: 'Reports', to: '/reports' }, { label: 'People analytics' }]}
      secondaryActions={
        <Button asChild variant="outline">
          <Link to="/reports">
            <ArrowLeft className="h-4 w-4" />
            Report builder
          </Link>
        </Button>
      }
      filters={<SegmentedControl ariaLabel="Window" options={([6, 12, 24] as const).map((m) => ({ value: m, label: `${m} months` }))} value={months} onChange={(m) => setMonths(m)} />}
      summary={
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <MetricCard label="Annualized turnover" value={d ? pct(d.turnover.annualizedPct) : '—'} accent={Boolean(d && (d.turnover.annualizedPct ?? 0) >= 25)} hint={d ? `${d.turnover.separations} left · average headcount ${d.turnover.averageHeadcount}` : undefined} />
          <MetricCard label="Headcount" value={headcountNow ?? '—'} hint={headcountThen !== null && headcountNow !== null ? `${headcountNow - headcountThen >= 0 ? '+' : ''}${headcountNow - headcountThen} since ${d ? monthLabel(d.headcount[0]!.month) : ''}` : undefined} />
          <MetricCard label="Median time to fill" value={d && d.timeToFill.medianDays !== null ? `${d.timeToFill.medianDays} days` : '—'} hint={d ? `${d.timeToFill.filled} seats filled in the window` : undefined} />
          <MetricCard label="Absence rate" value={d ? pct(d.absence.absenceRatePct) : '—'} hint={d ? `${d.absence.absenceDays} days off against ${d.absence.scheduledShiftDays} shift days` : undefined} />
        </div>
      }
    >
      {query.isError && <QueryError what="people analytics" query={query} />}
      {!d && !query.isError ? (
        <SkeletonRows count={8} />
      ) : d ? (
        <div className="space-y-5">
          <ChartFrame
            title="Headcount, month by month"
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
                'Headcount at month end, with the hires and leavers that moved it.'
              )
            }
            summary={
              trendBy === 'company'
                ? `Headcount went from ${headcountThen ?? 0} to ${headcountNow ?? 0} over ${months} months, with ${trend.reduce((s, t) => s + t.hires, 0)} hires and ${trend.reduce((s, t) => s + t.left, 0)} leavers.`
                : `Headcount by ${term('label.store').toLowerCase()} for the ${d.headcountByStore?.length ?? 0} busiest.`
            }
            columns={
              trendBy === 'company'
                ? [
                    { key: 'month', label: 'Month' },
                    { key: 'headcount', label: 'Headcount', numeric: true },
                    { key: 'hires', label: 'Hires', numeric: true },
                    { key: 'left', label: 'Left', numeric: true },
                  ]
                : [{ key: 'month', label: 'Month' }, ...(d.headcountByStore ?? []).map((s) => ({ key: s.storeName, label: s.storeName, numeric: true }))]
            }
            rows={trendBy === 'company' ? trend : storeTrend}
            csvName={trendBy === 'company' ? 'headcount-trend' : 'headcount-by-store'}
          >
            <ResponsiveContainer width="100%" height="100%">
              {trendBy === 'company' ? (
                <ComposedChart data={trend} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
                  <CartesianGrid stroke={CHART.grid} vertical={false} />
                  <XAxis dataKey="month" tick={axis} tickLine={false} axisLine={false} />
                  <YAxis allowDecimals={false} tick={axis} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={CHART.tooltip} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="hires" name="Hires" fill={CHART.good} radius={[3, 3, 0, 0]} />
                  <Bar dataKey="left" name="Left" fill={CHART.bad} radius={[3, 3, 0, 0]} />
                  <Line dataKey="headcount" name="Headcount" stroke={CHART.series[0]} strokeWidth={2} dot={false} />
                </ComposedChart>
              ) : (
                <LineChart data={storeTrend} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
                  <CartesianGrid stroke={CHART.grid} vertical={false} />
                  <XAxis dataKey="month" tick={axis} tickLine={false} axisLine={false} />
                  <YAxis allowDecimals={false} tick={axis} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={CHART.tooltip} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  {(d.headcountByStore ?? []).map((s, i) => (
                    <Line key={s.storeId} dataKey={s.storeName} stroke={CHART.series[i % CHART.series.length]} strokeWidth={2} dot={false} />
                  ))}
                </LineChart>
              )}
            </ResponsiveContainer>
          </ChartFrame>

          <EarlyTurnoverGrid d={d} />

          <div className="grid gap-5 lg:grid-cols-2">
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
                <LineChart data={survivalRows} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
                  <CartesianGrid stroke={CHART.grid} vertical={false} />
                  <XAxis dataKey="day" tick={axis} tickLine={false} axisLine={false} interval={2} />
                  <YAxis domain={[0, 100]} tickFormatter={(v: number) => `${v}%`} tick={axis} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={CHART.tooltip} formatter={(v) => pct(v as number | null)} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  {(d.survival ?? []).map((c, i) => (
                    <Line key={c.month} dataKey={monthLabel(c.month)} stroke={CHART.series[i % CHART.series.length]} strokeWidth={2} dot={false} connectNulls={false} />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </ChartFrame>

            <ChartFrame
              title="Turnover by tenure"
              description="Annualized, so a 6-month window reads like a year."
              summary={`Annualized turnover by tenure band: ${d.turnover.byTenure.map((b) => `${b.label} ${pct(b.annualizedTurnoverPct)}`).join(', ')}.`}
              columns={[
                { key: 'label', label: 'Tenure' },
                { key: 'headcount', label: 'Active', numeric: true },
                { key: 'separations', label: 'Left', numeric: true },
                { key: 'annualizedTurnoverPct', label: 'Annualized', numeric: true, format: (v) => pct(v as number | null) },
              ]}
              rows={d.turnover.byTenure}
              csvName="turnover-by-tenure"
            >
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={d.turnover.byTenure} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
                  <CartesianGrid stroke={CHART.grid} vertical={false} />
                  <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={false} />
                  <YAxis tickFormatter={(v: number) => `${v}%`} tick={axis} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={CHART.tooltip} formatter={(v) => pct(v as number | null)} />
                  <Bar dataKey="annualizedTurnoverPct" name="Annualized turnover" fill={CHART.series[0]} radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </ChartFrame>
          </div>

          <CohortGrid cohorts={d.cohorts} />

          <div className="grid gap-5 lg:grid-cols-2">
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
                  <Tooltip contentStyle={CHART.tooltip} />
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
            >
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={absence} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
                  <CartesianGrid stroke={CHART.grid} vertical={false} />
                  <XAxis dataKey="month" tick={axis} tickLine={false} axisLine={false} />
                  <YAxis tickFormatter={(v: number) => `${v}%`} tick={axis} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={CHART.tooltip} formatter={(v) => pct(v as number | null)} />
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
                  <Tooltip contentStyle={CHART.tooltip} />
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
