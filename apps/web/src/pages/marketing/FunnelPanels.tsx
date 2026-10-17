import { Link } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { MarketingOverview, SourceFunnelRow } from '@/lib/marketingApi';
import { fmtMoney } from '@/lib/format';
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

export function FunnelHero({ o }: { o: MarketingOverview }) {
  const f = o.funnel;
  const step = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}% of the step before` : undefined);
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <MetricCard label="Careers site views" value={f.views} hint="list and posting pages" />
      <MetricCard label="Applicants" value={f.applicants} hint={step(f.applicants, f.views)} />
      <MetricCard label="Interviewed" value={f.interviewed} hint={step(f.interviewed, f.applicants)} />
      <MetricCard label="Hires" value={f.hires} hint={step(f.hires, f.applicants)} accent />
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
      <CardContent className="p-4 md:p-5">
        <SectionTitle title="By posting" description="Views and applicants per job on the careers site." as="h3" />
        {rows.length === 0 ? (
          <EmptyState title="No postings in the range" description="Open a posting and its views and applicants show here." className="py-6" />
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

const ACCENT = 'rgb(var(--color-chart-1))';
const STEEL = 'rgb(var(--color-chart-2))';
const GOOD = 'rgb(var(--color-chart-3))';
const MUTED = 'rgb(var(--color-silver))';

export function WeeklyChart({ o }: { o: MarketingOverview }) {
  const data = o.weekly.map((w) => ({ week: w.weekStart.slice(5), views: w.views, applicants: w.applicants, hires: w.hires }));
  return (
    <Card>
      <CardContent className="p-4 md:p-5">
        <SectionTitle title="Week by week" description="Views against applicants and hires." as="h3" />
        {data.length === 0 ? (
          <EmptyState title="No activity in the range" description="Views and applications show here week by week." className="py-6" />
        ) : (
          <div className="mt-2 h-48">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
                <CartesianGrid stroke="rgb(var(--color-silver) / 0.12)" vertical={false} />
                <XAxis dataKey="week" tick={{ fill: MUTED, fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: MUTED, fontSize: 11 }} axisLine={false} tickLine={false} width={40} allowDecimals={false} />
                <Tooltip
                  contentStyle={{ background: 'rgb(var(--color-surface-raised))', border: '1px solid rgb(var(--color-line))', borderRadius: 8, fontSize: 12 }}
                  labelFormatter={(l) => `Week of ${l}`}
                />
                <Bar dataKey="views" name="Views" fill={STEEL} radius={[3, 3, 0, 0]} />
                <Bar dataKey="applicants" name="Applicants" fill={ACCENT} radius={[3, 3, 0, 0]} />
                <Bar dataKey="hires" name="Hires" fill={GOOD} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
