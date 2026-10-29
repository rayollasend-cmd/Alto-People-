import { useAuth, useTenant, useTerm } from '@/lib/auth';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  Building2,
  Calendar,
  DollarSign,
  Download,
  ShieldCheck,
} from '@/components/ui/icons';
import { METRICS, type DashboardKPIs, type KpiTrend } from '@alto-people/shared';
import { PALETTE } from '@/components/ui/charts/palette';
import { TrendLineChart, fmtMoneyAxis } from '@/components/ui/charts';
import { ChartFrame } from '@/components/ui/ChartFrame';
import { apiFetch } from '@/lib/api';
import type { FinanceOverview, MarginWeek } from '@/pages/finance/financeTypes';
import { getDashboardKPIs } from '@/lib/analyticsApi';
import { downloadCsv } from '@/lib/csv';
import { fmtDateOnly, fmtDateOnlyRange, fmtMoney, fmtMoneyCompact, ymdLocal } from '@/lib/format';
import { urlNumber, useUrlState, type UrlCodec } from '@/lib/useUrlState';
import { Card, CardContent } from '@/components/ui/Card';
import { MetricCard, type MetricDelta, type TrendGood } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { QueryError } from '@/components/ui/QueryError';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { ListTemplate } from '@/components/templates';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * Brand-aligned color per application status. Drives the donut chart and
 * any legend/tooltip downstream. Order also defines display order in the
 * donut/legend (largest-impact-on-pipeline first).
 */
const STATUS_ORDER: readonly string[] = [
  'APPROVED',
  'IN_REVIEW',
  'SUBMITTED',
  'DRAFT',
  'REJECTED',
  'CANCELLED',
] as const;
/** "IN_REVIEW" → "In review": the fallback for a status the label map has not met yet. */
function sentenceCase(code: string): string {
  const words = code.toLowerCase().replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
const STATUS_LABELS: Record<string, string> = {
  APPROVED: 'Approved',
  IN_REVIEW: 'In review',
  SUBMITTED: 'Submitted',
  DRAFT: 'Draft',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
};

const WINDOW_PRESETS = [7, 30, 60, 90] as const;
/** ?days= is one of the presets; anything else reads as the default 30. */
const WINDOW_CODEC: UrlCodec<number> = {
  parse: (raw) => {
    const n = urlNumber({ integer: true }).parse(raw);
    return n !== undefined && (WINDOW_PRESETS as readonly number[]).includes(n) ? n : undefined;
  },
  serialize: (n) => String(n),
};

/**
 * Phase 38 — dedicated reports view. Same data as the dashboard's KPI
 * tiles, presented denser, with CSV export, a window selector for the
 * time-bounded metrics, and drill-in links from each KPI to its source
 * page. Retention, hiring cohorts and turnover by store live on People
 * analytics (one home, one definition — F500 G4); this page links there.
 */
export function AnalyticsHome() {
  const term = useTerm();
  const { moduleOn } = useTenant();
  const { can } = useAuth();
  const hasClients = moduleOn('clientPortal');
  // Revenue and margin are the Finance home's numbers, read from the same source
  // (GET /finance/overview → lib/financeCockpit marginTrend), for the people who see that home.
  const moneyOn = can('process:payroll') && moduleOn('billRates');
  const workers = term('workers');
  // The window lives in the URL (?days=7): Back, a reload and a shared link keep it.
  const [days, setDays] = useUrlState<number>('days', 30, WINDOW_CODEC);

  const kpisQuery = useQuery({
    queryKey: ['AnalyticsHome', 'kpis', days],
    queryFn: () => getDashboardKPIs(days),
  });
  const kpis: DashboardKPIs | null = kpisQuery.data ?? null;
  const activeDays = kpis?.activeWindowDays ?? 14;

  const exportCsv = () => {
    if (!kpis) return;
    // Shared RFC-4180 helper + local calendar date in the filename
    // (toISOString is UTC and rolls to tomorrow for evening users).
    downloadCsv(`alto-analytics-${ymdLocal()}.csv`, [
      ['Metric', 'Value'],
      ['Window (days)', kpis.windowDays],
      ...(kpis.onTheBooks !== undefined ? [['On the books', kpis.onTheBooks] as [string, number]] : []),
      [`${METRICS.working.label} (${activeDays} days)`, kpis.activeAssociates],
      [`${METRICS.onTheFloor.label} (${workers.toLowerCase()} clocked in)`, kpis.associatesClockedIn],
      ...(kpis.week
        ? [
            [`${METRICS.hoursThisWeek.label} (${kpis.week.start} to ${kpis.week.end})`, kpis.week.paidHours] as [string, number],
            [`${METRICS.scheduledHours.label} this week`, kpis.week.scheduledHours] as [string, number],
          ]
        : []),
      [`${METRICS.openShifts.label} (next ${kpis.windowDays}d)`, kpis.openShiftsNext30d],
      ['Pending onboarding applications', kpis.pendingOnboardingApplications],
      ['Pending I-9 Section 2', kpis.pendingI9Section2],
      ['Pending document reviews', kpis.pendingDocumentReviews],
      [`Net paid (last ${kpis.windowDays}d) USD`, kpis.netPaidLast30d.toFixed(2)],
      ['Net pending disbursement USD', kpis.netPendingDisbursement.toFixed(2)],
      ...Object.entries(kpis.applicationStatusCounts).map(
        ([status, count]) => [`Applications: ${STATUS_LABELS[status] ?? status}`, count],
      ),
    ]);
  };

  return (
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    <ListTemplate
      title="Analytics"
      subtitle={hasClients ? 'Live operational and financial KPIs across all clients.' : 'Live operational and financial KPIs across the organization.'}
      actions={[{ label: 'Export CSV', icon: Download, onSelect: exportCsv, disabled: !kpis }]}
      related={[{ label: 'People analytics: retention, cohorts and turnover', to: '/reports/people' }]}
      filters={
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
          <span className="text-silver">Window</span>
          <SegmentedControl
            ariaLabel="Reporting window"
            value={days}
            onChange={(d) => setDays(d)}
            options={WINDOW_PRESETS.map((d) => ({ value: d, label: `${d} days` }))}
          />
          <span className="basis-full text-xs text-silver/80 sm:basis-auto">
            Applies to shifts and pay. Headcount and backlogs are as of now.
          </span>
        </div>
      }
    >
      {kpisQuery.isError && !kpis ? (
        <QueryError what="analytics" query={kpisQuery} />
      ) : (
        <>
          {/* One grid for every section: four tiles a row on a desktop (it ran 4 · 2 · 2 · 3 by section). */}
          <Section title="Workforce" icon={Building2} description="Headcount and live presence.">
            {kpis ? (
              <MetricStrip label="Workforce">
                {/* The two named numbers every page shows (apps/api/src/lib/peopleStatus.ts):
                    "On the books" and "Working", each with its definition. */}
                {kpis.onTheBooks !== undefined && (
                  <MetricCard
                    label={METRICS.onTheBooks.label}
                    value={fmtInt(kpis.onTheBooks)}
                    valueTitle={METRICS.onTheBooks.definition}
                    hint="Hired and not separated"
                    href="/people"
                  />
                )}
                <MetricCard
                  label={`${METRICS.working.label} (${activeDays} days)`}
                  value={fmtInt(kpis.activeAssociates)}
                  valueTitle={METRICS.working.definition}
                  hint={`Placed, and worked in the last ${activeDays} days or has a shift ahead`}
                  href="/people?workStatus=ACTIVE"
                />
                <MetricCard
                  label={METRICS.onTheFloor.label}
                  value={fmtInt(kpis.associatesClockedIn)}
                  valueTitle={METRICS.onTheFloor.definition}
                  hint={
                    kpis.activeAssociates > 0
                      ? `${Math.round((kpis.associatesClockedIn / kpis.activeAssociates) * 100)}% of those working`
                      : undefined
                  }
                  href="/time-attendance"
                />
                {kpis.trends?.hoursWorked && (
                  <MetricCard
                    label={`${METRICS.paidHours.label} · last week`}
                    value={fmtHours(lastComplete(kpis.trends.hoursWorked))}
                    valueTitle={METRICS.paidHours.definition}
                    // "Hours this week" is the dictionary's: the company week
                    // (Saturday → Friday) so far, the number the ops home shows.
                    hint={
                      kpis.week
                        ? `${METRICS.hoursThisWeek.label}: ${fmtHours(kpis.week.paidHours)} of ${fmtHours(kpis.week.scheduledHours)} scheduled · ${fmtDateOnlyRange(kpis.week.start, kpis.week.end)}`
                        : `${fmtHours(kpis.trends.hoursWorked.series.at(-1) ?? 0)} so far this week`
                    }
                    href="/time-attendance"
                    delta={weekly(kpis.trends.hoursWorked, 'vs the week before', 'neutral', fmtHours)}
                  />
                )}
              </MetricStrip>
            ) : (
              <SkeletonGrid count={4} />
            )}
          </Section>

          {moneyOn && <MoneySection />}

          <Section title="Scheduling and pay" icon={Calendar} description="Shifts ahead, and what payroll paid and owes.">
            {kpis ? (
              <MetricStrip label="Scheduling and pay">
                <MetricCard
                  label={`${METRICS.openShifts.label} (next ${kpis.windowDays} days)`}
                  value={fmtInt(kpis.openShiftsNext30d)}
                  valueTitle={METRICS.openShifts.definition}
                  hint={`Published, with no ${term('worker').toLowerCase()} assigned yet`}
                  href="/scheduling?open=1"
                />
                {kpis.trends?.shiftsScheduled && (
                  <MetricCard
                    label="Shifts scheduled · last week"
                    value={fmtInt(lastComplete(kpis.trends.shiftsScheduled))}
                    hint={`${fmtInt(kpis.trends.shiftsScheduled.series.at(-1) ?? 0)} on this week's schedule`}
                    href="/scheduling"
                    delta={weekly(kpis.trends.shiftsScheduled, 'vs the week before', 'neutral')}
                  />
                )}
                <MetricCard
                  label={`Net paid (last ${kpis.windowDays} days)`}
                  value={fmtMoney(kpis.netPaidLast30d)}
                  // A $0.00 tile said nothing: say there was no payroll paid.
                  nothing={kpis.netPaidLast30d === 0 ? `No payroll paid in the last ${kpis.windowDays} days` : undefined}
                  hint="Net pay on every paid paycheck"
                  href="/payroll"
                />
                <MetricCard
                  label="Waiting to be paid"
                  value={fmtMoney(kpis.netPendingDisbursement)}
                  nothing={kpis.netPendingDisbursement === 0 ? 'No payroll waiting to be paid' : undefined}
                  hint="Net pay on draft and finalized runs"
                  href="/payroll"
                />
              </MetricStrip>
            ) : (
              <SkeletonGrid count={4} />
            )}
          </Section>

          <Section title="Onboarding & compliance" icon={ShieldCheck} description="What needs HR's attention.">
            {kpis ? (
              <MetricStrip label="Onboarding and compliance">
                <MetricCard
                  label="Pending applications"
                  value={fmtInt(kpis.pendingOnboardingApplications)}
                  tone={kpis.pendingOnboardingApplications > 0 ? 'warning' : 'default'}
                  href="/onboarding"
                  delta={weekly(kpis.trends?.applications, 'new vs the week before', 'neutral')}
                />
                <MetricCard
                  label="I-9 Section 2 backlog"
                  value={fmtInt(kpis.pendingI9Section2)}
                  tone={kpis.pendingI9Section2 > 0 ? 'warning' : 'default'}
                  href="/compliance?tab=i9"
                />
                <MetricCard
                  label="Documents to review"
                  value={fmtInt(kpis.pendingDocumentReviews)}
                  tone={kpis.pendingDocumentReviews > 0 ? 'warning' : 'default'}
                  href="/documents"
                />
                {/* The status mix in one tile: a two-slice donut took a whole 290px card. */}
                <ApplicationsTile counts={kpis.applicationStatusCounts} />
              </MetricStrip>
            ) : (
              <SkeletonGrid count={4} />
            )}
          </Section>
        </>
      )}

      <p className="text-xs text-silver/70 mt-8">
        <Activity className="h-3 w-3 inline mr-1 -mt-0.5" />
        Numbers are live — refresh to recompute.
      </p>
    </ListTemplate>
  );
}

interface SectionProps {
  title: string;
  icon: typeof Activity;
  description?: string;
  children: React.ReactNode;
}

function Section({ title, icon: Icon, description, children }: SectionProps) {
  return (
    <section className="mb-6">
      <div className="flex items-center gap-2 mb-3">
        <Icon className="h-4 w-4 text-silver/80" aria-hidden="true" />
        <h2 className="text-xl text-ink">{title}</h2>
      </div>
      {description && <p className="text-xs text-ink-muted mb-3">{description}</p>}
      {children}
    </section>
  );
}

// Thousands separators on every count and hour (LEAD-28); Intl directly — toLocale* is lint-banned.
const INT_FMT = new Intl.NumberFormat('en-US');
const fmtInt = (n: number) => INT_FMT.format(n);
const fmtHours = (n: number) => `${INT_FMT.format(Math.round(n))}h`;

/** The last complete week (the final bucket is the week in progress). */
function lastComplete(t: KpiTrend): number {
  return t.series[t.series.length - 2] ?? 0;
}

/**
 * The API's weekly series as a change in words ("↑ 3 vs the week before"):
 * the last complete week against the one before. No sparkline: eight
 * undated points told no one which weeks they were (F500 G4).
 */
function weekly(
  t: KpiTrend | undefined,
  label: string,
  good: TrendGood,
  format?: (n: number) => string,
): MetricDelta | undefined {
  return t && t.series.length >= 3 ? { value: t.delta, label, good, format } : undefined;
}

/** Applications by status, in one tile: the total, the mix in words, and how many are approved. */
function ApplicationsTile({ counts }: { counts: Record<string, number> }) {
  const entries = [
    ...STATUS_ORDER.filter((st) => (counts[st] ?? 0) > 0).map((st) => [st, counts[st]!] as const),
    ...Object.entries(counts).filter(([st, n]) => !STATUS_ORDER.includes(st) && n > 0),
  ];
  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  const approved = counts.APPROVED ?? 0;
  return (
    <MetricCard
      label="Applications"
      value={fmtInt(total)}
      nothing={total === 0 ? 'No applications yet' : undefined}
      hint={entries.map(([st, n]) => `${fmtInt(n)} ${(STATUS_LABELS[st] ?? sentenceCase(st)).toLowerCase()}`).join(' · ')}
      meter={total > 0 ? { percent: Math.round((approved / total) * 100), tone: 'good' } : null}
      href="/onboarding"
    />
  );
}

/** "+$420", "−$1.2k": a week-over-week change in money. */
const moneyChange = (n: number) => `${n < 0 ? '\u2212' : '+'}${fmtMoneyCompact(Math.abs(n))}`;

/**
 * Billing and margin after wages, week by week — the Finance home's numbers
 * (approved hours × the client's contract bill rate against the wages
 * payroll pays for them), from the same read, so the two pages agree.
 *
 * Named by the metric dictionary (packages/shared metrics.ts): this is
 * "Billed at contract rates" and "Margin after wages", NOT the executive
 * pages' "Revenue" and "Gross margin" — those are priced at the standard
 * rates and also take out employer burden and overhead, so they read
 * lower (20.8% there against 30% here was one label on two measures,
 * LEAD-5). Complete weeks only: the week in progress would dip every line.
 */
function MoneySection() {
  const q = useQuery({ queryKey: ['finance', 'overview'], queryFn: () => apiFetch<FinanceOverview>('/finance/overview'), staleTime: 60_000, retry: false });
  const weeks: MarginWeek[] = (q.data?.margin?.weeks ?? []).filter((w) => !w.inProgress);
  const any = weeks.some((w) => w.hours > 0);
  const last = weeks.at(-1);
  const prev = weeks.at(-2);
  const pts = (w: MarginWeek | undefined) => (w?.marginPct == null ? null : Math.round(w.marginPct * 100));
  const rows = weeks.map((w) => ({ week: w.weekEnd, revenue: w.revenue, wages: w.wages, margin: pts(w) }));
  const sum = (k: 'revenue' | 'wages') => weeks.reduce((s, w) => s + w[k], 0);
  return (
    <Section
      title="Billing and margin after wages"
      icon={DollarSign}
      description={METRICS.marginAfterWages.definition}
    >
      {q.isError ? (
        <QueryError what="billing and margin" query={q} />
      ) : !q.data ? (
        <SkeletonGrid count={4} />
      ) : !any || !last ? (
        <MetricStrip label="Billing and margin after wages" empty="No approved hours in the last eight weeks yet, so there is no billing or margin to show.">
          {null}
        </MetricStrip>
      ) : (
        <div className="space-y-3">
          <MetricStrip label="Billing and margin after wages">
            {/* The dictionary's names as the labels (they fit two lines at 1024);
                the week goes in the hint, with its dates. */}
            <MetricCard
              label={METRICS.billedAtContractRates.label}
              value={fmtMoney(last.revenue)}
              valueTitle={METRICS.billedAtContractRates.definition}
              hint={`Last week, ${fmtDateOnlyRange(last.weekStart, last.weekEnd)}`}
              href="/labor-costs"
              delta={prev ? { value: last.revenue - prev.revenue, label: 'vs the week before', good: 'up', format: (n) => fmtMoneyCompact(Math.abs(n)) } : undefined}
            />
            <MetricCard
              label="Wages"
              value={fmtMoney(last.wages)}
              hint="Last week: what payroll pays for those hours, overtime included"
              href="/labor-costs"
              delta={prev ? { value: last.wages - prev.wages, label: 'vs the week before', good: 'neutral', format: (n) => fmtMoneyCompact(Math.abs(n)) } : undefined}
            />
            <MetricCard
              label={METRICS.marginAfterWages.label}
              value={pts(last) === null ? '' : `${pts(last)}%`}
              valueTitle={METRICS.marginAfterWages.definition}
              nothing={pts(last) === null ? 'No billed hours last week' : undefined}
              tone={pts(last) !== null && pts(last)! < 0 ? 'alert' : 'default'}
              hint={`${fmtMoney(last.margin)} last week · before burden and overhead`}
              deltaText={
                pts(last) !== null && pts(prev) !== null
                  ? { text: `${pts(last)! - pts(prev)! >= 0 ? '+' : '\u2212'}${Math.abs(pts(last)! - pts(prev)!)} pts vs the week before`, tone: pts(last)! >= pts(prev)! ? 'good' : 'bad' }
                  : null
              }
            />
            <MetricCard
              label={`Billed over ${weeks.length} weeks`}
              value={fmtMoney(sum('revenue'))}
              hint={`At contract rates · ${moneyChange(sum('revenue') - sum('wages'))} after wages`}
              href="/labor-costs"
            />
          </MetricStrip>
          <div className="grid gap-3 lg:grid-cols-2">
            <ChartFrame
              title="Billed at contract rates and wages, by week"
              summary={`Billing at contract rates ran ${fmtMoney(sum('revenue'))} over ${weeks.length} weeks against ${fmtMoney(sum('wages'))} in wages; last week ${fmtMoney(last.revenue)} against ${fmtMoney(last.wages)}.`}
              columns={[
                { key: 'week', label: 'Week ending', format: (v) => fmtDateOnly(String(v), { year: 'auto' }) },
                { key: 'revenue', label: METRICS.billedAtContractRates.label, numeric: true, format: (v) => fmtMoney(Number(v)) },
                { key: 'wages', label: 'Wages', numeric: true, format: (v) => fmtMoney(Number(v)) },
              ]}
              rows={rows}
              csvName="billed-and-wages"
              height={240}
            >
              <TrendLineChart
                data={rows}
                x="week"
                xDates="day"
                heading={(v) => `Week ending ${fmtDateOnly(v, { year: 'auto' })}`}
                series={[
                  { key: 'revenue', name: 'Billed', color: PALETTE.primary },
                  { key: 'wages', name: 'Wages', color: PALETTE.secondary },
                ]}
                format={fmtMoneyAxis}
              />
            </ChartFrame>
            <ChartFrame
              title={`${METRICS.marginAfterWages.label}, by week`}
              summary={`${METRICS.marginAfterWages.label} was ${pts(last) ?? 0}% last week${pts(prev) !== null ? `, ${pts(prev)}% the week before` : ''}.`}
              columns={[
                { key: 'week', label: 'Week ending', format: (v) => fmtDateOnly(String(v), { year: 'auto' }) },
                { key: 'margin', label: METRICS.marginAfterWages.label, numeric: true, format: (v) => (v === null ? '' : `${v}%`) },
              ]}
              rows={rows}
              csvName="margin-after-wages-by-week"
              height={240}
              zerosMeaningful
            >
              <TrendLineChart
                data={rows}
                x="week"
                xDates="day"
                heading={(v) => `Week ending ${fmtDateOnly(v, { year: 'auto' })}`}
                series={[{ key: 'margin', name: METRICS.marginAfterWages.label, color: PALETTE.tertiary }]}
                format={(v) => `${v}%`}
                // From zero (LEAD-22): a 29–30% axis drew a one-point move as a cliff.
                // The break-even line only where a week came near it: otherwise it sat on the axis, over the dates.
                target={rows.some((r) => r.margin !== null && r.margin <= 2) ? { value: 0, label: 'Break-even' } : undefined}
              />
            </ChartFrame>
          </div>
        </div>
      )}
    </Section>
  );
}

function SkeletonGrid({ count = 2 }: { count?: number }) {
  // The same columns MetricStrip lays tiles in: two a row on a phone, up to four from lg.
  const cols = count >= 4 ? 'lg:grid-cols-4' : count === 3 ? 'lg:grid-cols-3' : '';
  return (
    <div className={`grid grid-cols-2 ${cols} gap-2 sm:gap-3`}>
      {Array.from({ length: count }).map((_, i) => (
        <Card key={i}>
          <CardContent>
            <Skeleton className="h-3 w-2/3 mb-3" />
            <Skeleton className="h-8 w-1/2 mb-2" />
            <Skeleton className="h-3 w-1/3" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
