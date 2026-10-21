import { Link } from 'react-router-dom';
import { PALETTE, StackedBarChart, TrendLineChart } from '@/components/ui/charts';
import { ChartFrame } from '@/components/ui/ChartFrame';
import type { MarketingOverview, SourceFunnelRow } from '@/lib/marketingApi';
import { fmtDayShort, fmtMoney, parseYmd } from '@/lib/format';
import { SOURCE_LABEL } from '@/pages/recruiting/recruitingLabels';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent } from '@/components/ui/Card';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { EmptyState } from '@/components/ui/EmptyState';
import { MetricCard } from '@/components/ui/MetricCard';
import { SectionTitle } from '@/components/ui/SectionTitle';

/**
 * Marketing's funnel: views → applicants → interviewed → hires, by the
 * source the link carried, by posting, and week by week. Views come from
 * the careers site's beacon; everything after is recruiting's own record.
 */

export const sourceName = (s: string | null) =>
  s ? (SOURCE_LABEL[s] ?? `${s.charAt(0).toUpperCase()}${s.slice(1)}`) : 'Not recorded';

const pct = (v: number | null) => (v === null ? '—' : `${v}%`);

/** A week series as a tile trend: the last week is the one in progress. */
function weekTrend(series: number[]) {
  if (series.length < 3) return undefined;
  const complete = series.slice(0, -1);
  const last = complete[complete.length - 1] ?? 0;
  const before = complete[complete.length - 2] ?? 0;
  return { series, lastIsPartial: true, delta: last - before, deltaLabel: 'vs the week before', unit: 'week' };
}

export function FunnelHero({ o }: { o: MarketingOverview }) {
  const f = o.funnel;
  const step = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}% of the step before` : undefined);
  const w = o.weekly;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <MetricCard label="Careers site views" value={f.views} hint="list and posting pages" trend={weekTrend(w.map((x) => x.views))} />
      <MetricCard label="Applicants" value={f.applicants} hint={step(f.applicants, f.views)} trend={weekTrend(w.map((x) => x.applicants))} />
      <MetricCard label="Interviewed" value={f.interviewed} hint={step(f.interviewed, f.applicants)} />
      <MetricCard label="Hires" value={f.hires} hint={step(f.hires, f.applicants)} accent trend={weekTrend(w.map((x) => x.hires))} />
    </div>
  );
}

const SOURCE_COLUMNS: GridColumn<SourceFunnelRow>[] = [
  { key: 'source', header: 'Source', accessor: (r) => sourceName(r.source), primary: true, cell: (r) => <span className="text-ink">{sourceName(r.source)}</span> },
  { key: 'views', header: 'Views', accessor: (r) => r.views, align: 'right', className: 'tabular-nums' },
  { key: 'applicants', header: 'Applicants', accessor: (r) => r.applicants, align: 'right', className: 'tabular-nums' },
  { key: 'viewToApplyPct', header: 'View → apply', accessor: (r) => r.viewToApplyPct, cell: (r) => pct(r.viewToApplyPct), align: 'right', className: 'tabular-nums' },
  { key: 'interviewed', header: 'Interviewed', accessor: (r) => r.interviewed, align: 'right', className: 'tabular-nums' },
  { key: 'hires', header: 'Hires', accessor: (r) => r.hires, align: 'right', className: 'tabular-nums font-medium' },
  { key: 'applyToHirePct', header: 'Apply → hire', accessor: (r) => r.applyToHirePct, cell: (r) => pct(r.applyToHirePct), align: 'right', className: 'tabular-nums' },
  { key: 'spend', header: 'Spend', accessor: (r) => r.spend, cell: (r) => (r.spend === null ? '—' : fmtMoney(r.spend)), align: 'right', className: 'tabular-nums' },
  { key: 'costPerHire', header: 'Cost per hire', accessor: (r) => r.costPerHire, cell: (r) => (r.costPerHire === null ? '—' : fmtMoney(r.costPerHire)), align: 'right', className: 'tabular-nums' },
  { key: 'retained90Pct', header: 'Still here at 90 days', accessor: (r) => r.retained90Pct, cell: (r) => pct(r.retained90Pct), align: 'right', className: 'tabular-nums' },
];

export function SourceOfHireGrid({ o, loading }: { o: MarketingOverview | null; loading: boolean }) {
  return (
    <section aria-labelledby="source-of-hire" className="space-y-3">
      <SectionTitle
        id="source-of-hire"
        title="Source of hire"
        description="Where applicants come from and which of those become hires that stay. Spend is what Recruiting recorded per source and month."
        trailing={
          <Link to="/recruiting/analytics" className="text-xs text-accent hover:underline">
            Record spend
          </Link>
        }
      />
      <DataGrid
        id="marketing-sources"
        caption="Source of hire"
        rows={o?.bySource ?? null}
        loading={loading}
        columns={SOURCE_COLUMNS}
        rowKey={(r) => r.source ?? 'none'}
        noun={{ one: 'source', many: 'sources' }}
        search={false}
        defaultSort={{ key: 'hires', direction: 'desc' }}
        exportCsv={{ filename: 'source-of-hire.csv' }}
        urlState={false}
      />
    </section>
  );
}

export function PostingsPanel({ o }: { o: MarketingOverview }) {
  const rows = o.byPosting.slice(0, 12);
  return (
    <Card>
      <CardContent>
        <SectionTitle title="By posting" description="Views and applicants per job on the careers site." as="h3" />
        {rows.length === 0 ? (
          o.funnel.views > 0 ? (
            <EmptyState
              title="No posting was opened"
              description={`The ${o.funnel.views} view${o.funnel.views === 1 ? ' was' : 's were'} on the job list page. When someone opens a posting, its views and applicants show here.`}
              className="py-6"
            />
          ) : (
            <EmptyState title="No postings in the range" description="Open a posting and its views and applicants show here." className="py-6" />
          )
        ) : (
          <ul className="mt-2 divide-y divide-line">
            {rows.map((p) => (
              <li key={p.slug} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2 first:pt-0 last:pb-0 text-sm">
                <Link to={`/careers/${p.slug}`} className="min-w-0 flex-1 truncate text-ink hover:text-accent hover:underline">
                  {p.title}
                </Link>
                <Badge variant={p.status === 'OPEN' ? 'success' : 'outline'}>{p.status === 'OPEN' ? 'Open' : 'Closed'}</Badge>
                <span className="w-32 text-right text-xs tabular-nums text-ink-muted">
                  {p.views} views · {p.applicants} applied
                </span>
                <span className="w-16 text-right text-xs tabular-nums text-ink">{p.hires} hired</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** "Mon, Oct 12" from a week's YYYY-MM-DD start. */
const weekLabel = (ymd: string) => fmtDayShort(parseYmd(ymd) ?? ymd, { anchored: true });

const pctOf = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

/**
 * The funnel as stages: each bar is how many reached that step, labelled
 * with the share of the step before — where the funnel loses people is the
 * shortest jump, at a glance. Views, applicants and hires on one bar axis
 * hid hires entirely; here each stage reads on its own.
 */
export function StageFunnel({ o }: { o: MarketingOverview }) {
  const f = o.funnel;
  const rows = [
    { stage: 'Viewed', people: f.views, step: null as number | null },
    { stage: 'Applied', people: f.applicants, step: pctOf(f.applicants, f.views) },
    { stage: 'Interviewed', people: f.interviewed, step: pctOf(f.interviewed, f.applicants) },
    { stage: 'Hired', people: f.hires, step: pctOf(f.hires, f.interviewed) },
  ];
  const worst = rows.slice(1).filter((r) => r.step !== null).sort((a, b) => (a.step ?? 0) - (b.step ?? 0))[0];
  return (
    <ChartFrame
      title="Where the funnel loses people"
      description="Everyone who reached each step, and the share of the step before who made it."
      summary={
        f.views === 0
          ? 'No views in the range.'
          : `${f.views} views became ${f.applicants} applicants, ${f.interviewed} interviews and ${f.hires} hires.${worst ? ` The steepest drop is into “${worst.stage}” (${worst.step}% made it).` : ''}`
      }
      csvName="careers-funnel"
      height={200}
      columns={[
        { key: 'stage', label: 'Step' },
        { key: 'people', label: 'People', numeric: true },
        { key: 'step', label: 'Of the step before', numeric: true, format: (v) => (v === null || v === undefined ? '—' : `${v}%`) },
      ]}
      rows={f.views + f.applicants === 0 ? [] : rows}
    >
      <StackedBarChart
        data={rows.map((r) => ({ ...r, label: r.step === null ? r.stage : `${r.stage} · ${r.step}%` }))}
        x="label"
        layout="horizontal"
        stacked={false}
        series={[{ key: 'people', name: 'People', color: PALETTE.primary }]}
        xLabel="People"
      />
    </ChartFrame>
  );
}

/**
 * Week by week as rates, not raw counts: view → apply and apply → hire on a
 * percent axis, so a week with more traffic but worse conversion shows as
 * the dip it is. The week in progress is left off.
 */
export function ConversionChart({ o }: { o: MarketingOverview }) {
  const weeks = o.weekly.slice(0, -1);
  const data = weeks.map((w) => ({
    week: weekLabel(w.weekStart),
    viewToApply: pctOf(w.applicants, w.views),
    applyToHire: pctOf(w.hires, w.applicants),
    views: w.views,
    applicants: w.applicants,
    hires: w.hires,
  }));
  const any = data.some((d) => d.viewToApply !== null || d.applyToHire !== null);
  const last = [...data].reverse().find((d) => d.viewToApply !== null);
  return (
    <ChartFrame
      title="Conversion, week by week"
      description="Views that became applications, and applications that became hires. Complete weeks only."
      summary={last ? `In the week of ${last.week}, ${last.viewToApply}% of views became applications.` : 'Not enough activity to show a rate yet.'}
      csvName="careers-conversion"
      height={220}
      columns={[
        { key: 'week', label: 'Week of' },
        { key: 'views', label: 'Views', numeric: true },
        { key: 'applicants', label: 'Applicants', numeric: true },
        { key: 'hires', label: 'Hires', numeric: true },
        { key: 'viewToApply', label: 'View → apply', numeric: true, format: (v) => (v === null || v === undefined ? '—' : `${v}%`) },
        { key: 'applyToHire', label: 'Apply → hire', numeric: true, format: (v) => (v === null || v === undefined ? '—' : `${v}%`) },
      ]}
      rows={any ? data : []}
    >
      <TrendLineChart
        data={data}
        x="week"
        series={[
          { key: 'viewToApply', name: 'View → apply' },
          { key: 'applyToHire', name: 'Apply → hire' },
        ]}
        format={(v) => `${v}%`}
        yLabel="Percent"
        heading={(w) => `Week of ${w}`}
      />
    </ChartFrame>
  );
}

/** @deprecated The stage funnel and the conversion chart replace it. */
export const WeeklyChart = ConversionChart;
