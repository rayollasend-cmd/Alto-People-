import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowLeft, BarChart3, CalendarOff, Clock, TrendingDown, Users } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { useTerm } from '@/lib/auth';
import { fmtDate, parseYmd } from '@/lib/format';
import { getPeopleAnalytics, type PeopleAnalytics as PeopleAnalyticsData, type TurnoverGroup } from '@/lib/peopleAnalyticsApi';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { MetricCard } from '@/components/ui/MetricCard';
import { QueryError } from '@/components/ui/QueryError';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { ListTemplate } from '@/components/templates';
import { cn } from '@/lib/cn';

/**
 * People analytics (HR pack 2026-10): the canned reports the builder can't
 * express — turnover by cohort, tenure, site and manager; time to fill;
 * absence; the headcount trend. Every number is computed from the records
 * at request time; nothing here is stored.
 */

const pct = (v: number | null) => (v === null ? '—' : `${v}%`);
const monthLabel = (ym: string) => fmtDate(parseYmd(`${ym}-01`)).replace(/ \d{1,2},/, ',').replace(/,\s*/, ' ');

function TurnoverTable({ id, caption, rows, header }: { id: string; caption: string; rows: TurnoverGroup[]; header: string }) {
  const columns: GridColumn<TurnoverGroup>[] = [
    { key: 'label', header, accessor: (r) => r.label, sortable: true, primary: true, className: 'text-ink' },
    { key: 'headcount', header: 'Active', accessor: (r) => r.headcount, sortable: true, searchable: false, align: 'right', className: 'tabular-nums' },
    { key: 'separations', header: 'Left', accessor: (r) => r.separations, sortable: true, searchable: false, align: 'right', className: 'tabular-nums' },
    { key: 'rate', header: 'Annualized turnover', accessor: (r) => r.annualizedTurnoverPct ?? -1, sortable: true, searchable: false, align: 'right', cell: (r) => <span className={cn('tabular-nums', (r.annualizedTurnoverPct ?? 0) >= 50 ? 'text-alert' : (r.annualizedTurnoverPct ?? 0) >= 25 ? 'text-warning' : 'text-ink')}>{pct(r.annualizedTurnoverPct)}</span> },
  ];
  return <DataGrid<TurnoverGroup> id={id} caption={caption} rows={rows} rowKey={(r) => r.key} search={{ placeholder: `${header}…` }} urlState={false} exportCsv={{ filename: id }} columns={columns} />;
}

export function PeopleAnalytics() {
  const term = useTerm();
  const [months, setMonths] = useState<6 | 12 | 24>(12);
  const query = useQuery({ queryKey: ['people-analytics', months], queryFn: () => getPeopleAnalytics(months) });
  const d: PeopleAnalyticsData | undefined = query.data;
  const error = query.error ? (query.error instanceof ApiError ? query.error.message : 'Could not load people analytics.') : null;
  const headcountNow = d?.headcount[d.headcount.length - 1]?.headcount ?? null;
  const headcountThen = d?.headcount[0]?.headcount ?? null;

  return (
    <ListTemplate
      title="People analytics"
      subtitle={`Turnover by cohort, tenure, ${term('site').toLowerCase()} and manager; time to fill; absence; the headcount trend. Computed from the records as of now.`}
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
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard label="Annualized turnover" value={d ? pct(d.turnover.annualizedPct) : '—'} accent={Boolean(d && (d.turnover.annualizedPct ?? 0) >= 25)} hint={d ? `${d.turnover.separations} left · average headcount ${d.turnover.averageHeadcount}` : undefined} />
          <MetricCard label="Headcount" value={headcountNow ?? '—'} hint={headcountThen !== null && headcountNow !== null ? `${headcountNow - headcountThen >= 0 ? '+' : ''}${headcountNow - headcountThen} since ${d ? monthLabel(d.headcount[0]!.month) : ''}` : undefined} />
          <MetricCard label="Median time to fill" value={d && d.timeToFill.medianDays !== null ? `${d.timeToFill.medianDays} days` : '—'} hint={d ? `${d.timeToFill.filled} seats filled in the window` : undefined} />
          <MetricCard label="Absence rate" value={d ? pct(d.absence.absenceRatePct) : '—'} hint={d ? `${d.absence.absenceDays} days off against ${d.absence.scheduledShiftDays} shift days` : undefined} />
        </div>
      }
    >
      {error && <QueryError what="people analytics" query={query} />}

      <section className="space-y-3">
        <SectionTitle as="h2" icon={BarChart3} title="Headcount, month by month" description="Headcount at month end, with the hires and the leavers that moved it." />
        <Card>
          <CardContent className="p-3">
            <DataGrid<NonNullable<typeof d>['headcount'][number]>
              id="people-analytics-headcount"
              caption="Headcount by month"
              rows={d?.headcount ?? []}
              rowKey={(r) => r.month}
              loading={query.isLoading}
              search={false}
              urlState={false}
              exportCsv={{ filename: 'headcount-trend' }}
              columns={[
                { key: 'month', header: 'Month', accessor: (r) => r.month, primary: true, className: 'text-ink', cell: (r) => monthLabel(r.month) },
                { key: 'headcount', header: 'Headcount', accessor: (r) => r.headcount, align: 'right', className: 'tabular-nums' },
                { key: 'hires', header: 'Hires', accessor: (r) => r.hires, align: 'right', className: 'tabular-nums text-success' },
                { key: 'separations', header: 'Left', accessor: (r) => r.separations, align: 'right', className: 'tabular-nums', cell: (r) => <span className={r.separations > 0 ? 'text-alert' : ''}>{r.separations}</span> },
                { key: 'voluntary', header: 'Voluntary', accessor: (r) => r.voluntary, align: 'right', className: 'tabular-nums text-ink-muted' },
                { key: 'involuntary', header: 'Involuntary', accessor: (r) => r.involuntary, align: 'right', className: 'tabular-nums text-ink-muted' },
              ]}
            />
          </CardContent>
        </Card>
      </section>

      <section className="space-y-3">
        <SectionTitle as="h2" icon={TrendingDown} title="Turnover" description="Separations against the active base, annualized, so a 6-month window reads like a year." />
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardContent className="p-3">
              <DataGrid<NonNullable<typeof d>['turnover']['byTenure'][number]>
                id="people-analytics-tenure"
                caption="Turnover by tenure"
                rows={d?.turnover.byTenure ?? []}
                rowKey={(r) => r.label}
                loading={query.isLoading}
                search={false}
                urlState={false}
                columns={[
                  { key: 'label', header: 'Tenure', accessor: (r) => r.label, primary: true, className: 'text-ink' },
                  { key: 'headcount', header: 'Active', accessor: (r) => r.headcount, align: 'right', className: 'tabular-nums' },
                  { key: 'separations', header: 'Left', accessor: (r) => r.separations, align: 'right', className: 'tabular-nums' },
                  { key: 'rate', header: 'Annualized', accessor: (r) => r.annualizedTurnoverPct ?? -1, align: 'right', className: 'tabular-nums', cell: (r) => pct(r.annualizedTurnoverPct) },
                ]}
              />
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3">
              <DataGrid<NonNullable<typeof d>['cohorts'][number]>
                id="people-analytics-cohorts"
                caption="Hiring cohorts"
                rows={d?.cohorts ?? []}
                rowKey={(r) => r.month}
                loading={query.isLoading}
                search={false}
                urlState={false}
                exportCsv={{ filename: 'hiring-cohorts' }}
                columns={[
                  { key: 'month', header: 'Hired in', accessor: (r) => r.month, primary: true, className: 'text-ink', cell: (r) => monthLabel(r.month) },
                  { key: 'hires', header: 'Hires', accessor: (r) => r.hires, align: 'right', className: 'tabular-nums' },
                  { key: 's30', header: 'Still here at 30d', accessor: (r) => r.s30 ?? -1, align: 'right', className: 'tabular-nums', cell: (r) => pct(r.s30) },
                  { key: 's90', header: '90d', accessor: (r) => r.s90 ?? -1, align: 'right', className: 'tabular-nums', cell: (r) => pct(r.s90) },
                  { key: 's180', header: '180d', accessor: (r) => r.s180 ?? -1, align: 'right', className: 'tabular-nums', cell: (r) => pct(r.s180) },
                ]}
              />
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3">
              <TurnoverTable id="people-analytics-site" caption={`Turnover by ${term('site').toLowerCase()}`} rows={d?.turnover.bySite ?? []} header={term('site')} />
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3">
              <TurnoverTable id="people-analytics-manager" caption="Turnover by manager" rows={d?.turnover.byManager ?? []} header={term('manager')} />
            </CardContent>
          </Card>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="space-y-3">
          <SectionTitle as="h2" icon={Clock} title="Time to fill" description="Days from a seat opening to its fill, by department." />
          <Card>
            <CardContent className="p-3">
              <DataGrid<NonNullable<typeof d>['timeToFill']['byDepartment'][number]>
                id="people-analytics-ttf"
                caption="Time to fill by department"
                rows={d?.timeToFill.byDepartment ?? []}
                rowKey={(r) => r.department}
                loading={query.isLoading}
                search={false}
                urlState={false}
                columns={[
                  { key: 'department', header: 'Department', accessor: (r) => r.department, primary: true, className: 'text-ink' },
                  { key: 'filled', header: 'Filled', accessor: (r) => r.filled, align: 'right', className: 'tabular-nums' },
                  { key: 'median', header: 'Median days', accessor: (r) => r.medianDays ?? -1, align: 'right', className: 'tabular-nums', cell: (r) => r.medianDays ?? '—' },
                  { key: 'avg', header: 'Average days', accessor: (r) => r.averageDays, align: 'right', className: 'tabular-nums' },
                ]}
              />
            </CardContent>
          </Card>
        </section>
        <section className="space-y-3">
          <SectionTitle as="h2" icon={CalendarOff} title="Absence" description="Approved time off in the window, by category." />
          <Card>
            <CardContent className="p-3">
              <DataGrid<NonNullable<typeof d>['absence']['byCategory'][number]>
                id="people-analytics-absence"
                caption="Absence by category"
                rows={d?.absence.byCategory ?? []}
                rowKey={(r) => r.category}
                loading={query.isLoading}
                search={false}
                urlState={false}
                columns={[
                  { key: 'category', header: 'Category', accessor: (r) => r.category, primary: true, className: 'text-ink', cell: (r) => r.category.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) },
                  { key: 'requests', header: 'Requests', accessor: (r) => r.requests, align: 'right', className: 'tabular-nums' },
                  { key: 'days', header: 'Days', accessor: (r) => r.days, align: 'right', className: 'tabular-nums' },
                ]}
              />
            </CardContent>
          </Card>
        </section>
      </div>
      <p className="flex items-center gap-2 text-xs text-ink-muted">
        <Users className="h-3.5 w-3.5" aria-hidden="true" />
        Active is the one definition (placed and recently working or scheduled). A separation is a separated record, never a deleted one.
      </p>
    </ListTemplate>
  );
}
