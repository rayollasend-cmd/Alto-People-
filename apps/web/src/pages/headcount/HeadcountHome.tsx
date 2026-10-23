import { useMemo, useState } from 'react';
import { termizeText } from '@/lib/modules';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowDown, ArrowUp, Scale, Settings2, TrendingDown, TrendingUp } from 'lucide-react';
import { toast } from 'sonner';
import type { HeadcountOverview, HeadcountRow, ReconciliationSummary } from '@alto-people/shared';
import { getHeadcountOverview, getTurnover } from '@/lib/headcount110Api';
import { patchOrgBranding } from '@/lib/brandingApi';
import { ApiError } from '@/lib/api';
import { useAuth, useTerm, useTenant } from '@/lib/auth';
import { fmtDate, fmtDateOnly, fmtDateOnlyRange, fmtDateTime, fmtHours, fmtMoney } from '@/lib/format';
import { EMPLOYMENT_LABEL } from '@/lib/employmentLabels';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { urlNumber, useUrlParam, useUrlState } from '@/lib/useUrlState';
import { QueryError } from '@/components/ui/QueryError';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Input } from '@/components/ui/Input';
import { ListTemplate } from '@/components/templates';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ChartFrame } from '@/components/ui/ChartFrame';
import { PALETTE, TICK, TOOLTIP_LABEL_STYLE, TOOLTIP_STYLE } from '@/components/ui/charts/palette';
import { getPeopleAnalytics } from '@/lib/peopleAnalyticsApi';
import { parseYmd } from '@/lib/format';

/**
 * Headcount (Brief 1A-2) — one definition of active, on one screen.
 *
 * The hero is the company-wide active count from lib/activeDefinition
 * on the server; every other number here is that same definition cut
 * by store, client, department and employment type, beside what payroll
 * last said (the reconciliation snapshot). The old department drill
 * drawer is gone: it listed every employed associate in a department,
 * which is not the active set, so it contradicted the number above it.
 */

type TurnoverDays = 30 | 90 | 365;
type Cut = 'store' | 'client';

const WINDOW_MIN = 1;
const WINDOW_MAX = 90;

function definitionSentence(windowDays: number | undefined): string {
  const days = windowDays === undefined ? 'N' : String(windowDays);
  return `Active = placed at a site and either clocked in within the last ${days} days or scheduled ahead. Separated and deactivated people never count.`;
}

/** The Working tile's hint: why the number is what it is. */
function workingHint(o: HeadcountOverview): string {
  const behind = o.scheduledNotWorking ?? 0;
  if (behind > 0) {
    return `${n(behind)} scheduled this week ${behind === 1 ? "hasn't" : "haven't"} worked in ${o.windowDays} days`;
  }
  return `Worked in the last ${o.windowDays} days or scheduled ahead`;
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError && err.message ? err.message : fallback;
}

const n = (v: number) => v.toLocaleString('en-US');

const TURNOVER_DAYS = urlNumber({ integer: true, min: 30, max: 365 });
const CUTS = ['store', 'client'] as const;

export function HeadcountHome() {
  const term = useTerm();
  const { can } = useAuth();
  const canManage = can('manage:org');
  const [daysRaw, setDays] = useUrlState<number>('turnover', 90, TURNOVER_DAYS);
  const days: TurnoverDays = daysRaw === 30 || daysRaw === 365 ? daysRaw : 90;
  const [cut, setCut] = useUrlParam<Cut>('cut', 'store', CUTS);
  const [windowOpen, setWindowOpen] = useState(false);

  const overview = useQuery({ queryKey: ['headcount', 'overview'], queryFn: getHeadcountOverview });
  const turnover = useQuery({ queryKey: ['headcount', 'turnover', days], queryFn: () => getTurnover(days) });

  const o = overview.data;
  const t = turnover.data;
  const loading = overview.isLoading;
  const run = o?.onPayrollLastPeriod ?? null;

  return (
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    <ListTemplate
      title={term('nav.headcount')}
      subtitle="Who's working, where, and how that's changing."
      related={[{ label: 'Headcount plan', to: '/headcount/plan' }]}
      actions={canManage ? [{ label: 'Activity window', icon: Settings2, onSelect: () => setWindowOpen(true), hint: definitionSentence(o?.windowDays) }] : undefined}
    >

      {overview.isError && <QueryError what="the headcount" query={overview} />}

      {/* One error, said once: the cards and the grid below read the same query. */}
      {!overview.isError && (
      <>
      <MetricStrip label="Headcount now">
        {/* "Working" and "On the books": the two named numbers every page
            shows (apps/api/src/lib/peopleStatus.ts). */}
        <MetricCard
          label="Working"
          value={loading || !o ? '—' : n(o.active)}
          hint={o ? workingHint(o) : undefined}
          valueTitle={definitionSentence(o?.windowDays)}
          href="/people?workStatus=ACTIVE"
        />
        <MetricCard
          label="On the books"
          value={loading || !o || o.onTheBooks === undefined ? '—' : n(o.onTheBooks)}
          hint="Hired and not separated"
          href="/people"
        />
        <MetricCard label="Scheduled this week" value={loading || !o ? '—' : n(o.scheduledThisWeek)} hint="On an assigned shift in the current workweek" />
        <MetricCard
          label="Last payroll run"
          value={loading || !o ? '—' : run ? n(run.count) : '—'}
          hint={o ? (run ? `Paid ${fmtDateOnlyRange(run.periodStart, run.periodEnd)}${run.finalizedOn ? ` · finalized ${fmtDateOnly(run.finalizedOn)}` : ''}` : undefined) : undefined}
          nothing={o && !run ? 'No payroll run yet' : undefined}
        />
        {/* Shown once housing is linked: a dash and "No housing link yet" in prime space said nothing (and a hotel tenant has no housing). */}
        {typeof o?.inHousing === 'number' && <MetricCard label="In housing" value={loading ? '—' : n(o.inHousing)} />}
      </MetricStrip>

      {o && !o.reconciliation ? (
        // No reconciliation yet: one line, not half a card of dashes.
        <>
          <NotActiveCard notActive={o.notActive} windowDays={o.windowDays} />
          <p className="text-sm text-silver" data-testid="reconciliation-none">
            No reconciliation yet. Once a payroll export has been checked against the platform, the match rate and any differences appear here.
          </p>
        </>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <ReconciliationCard summary={o?.reconciliation} loaded={Boolean(o)} />
          <NotActiveCard notActive={o?.notActive} windowDays={o?.windowDays} />
        </div>
      )}

      {canManage ? (
        <Dialog open={windowOpen} onOpenChange={setWindowOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Activity window</DialogTitle>
              <DialogDescription>{definitionSentence(o?.windowDays)}</DialogDescription>
            </DialogHeader>
            <ActivityWindowCard windowDays={o?.windowDays} canManage onSaved={() => setWindowOpen(false)} />
          </DialogContent>
        </Dialog>
      ) : null}

      <CutGrid overview={o} cut={cut} onCut={setCut} loading={loading} error={null} onRetry={() => overview.refetch()} />

      <div className="grid gap-4 lg:grid-cols-2">
        <CompactList
          title="By department"
          rows={o?.byDepartment.map((d) => ({ key: d.id ?? 'unassigned', label: d.name, count: d.active }))}
        />
        <CompactList
          title="By employment type"
          rows={o?.byEmploymentType.map((e) => ({
            key: e.employmentType,
            label: EMPLOYMENT_LABEL[e.employmentType] ?? e.employmentType,
            count: e.active,
            href: `/people?employmentType=${encodeURIComponent(e.employmentType)}`,
          }))}
        />
      </div>

      </>
      )}

      {can('view:analytics') && <HeadcountTrend />}

      <section className="space-y-3" aria-labelledby="headcount-turnover">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SectionTitle as="h2" title={<span id="headcount-turnover">Turnover</span>} description="Hires and separations over the active base." />
          <SegmentedControl
            ariaLabel="Turnover window"
            options={([30, 90, 365] as const).map((d) => ({ value: d, label: `${d}d` }))}
            value={days}
            onChange={(d) => setDays(d)}
          />
        </div>
        {turnover.isError && <QueryError what="turnover" query={turnover} />}
        <MetricStrip label="Turnover">
          <MetricCard label="Hires" value={t ? n(t.hires) : '—'} hint={<span className="inline-flex items-center gap-1"><ArrowUp className="h-3 w-3" aria-hidden="true" />Last {days} days</span>} />
          <MetricCard label="Separations" value={t ? n(t.terminations) : '—'} accent={Boolean(t && t.terminations > 0)} hint={<span className="inline-flex items-center gap-1"><ArrowDown className="h-3 w-3" aria-hidden="true" />Last {days} days</span>} />
          <MetricCard
            label="Annualized turnover"
            value={t ? `${t.annualizedTurnoverRate}%` : '—'}
            accent={Boolean(t && t.annualizedTurnoverRate >= 25)}
            hint={
              <span className="inline-flex items-center gap-1">
                {t && t.annualizedTurnoverRate >= 25 ? <TrendingUp className="h-3 w-3" aria-hidden="true" /> : <TrendingDown className="h-3 w-3" aria-hidden="true" />}
                Last {days} days
              </span>
            }
          />
        </MetricStrip>
      </section>
    </ListTemplate>
  );
}

/* ------------------------------------------------------ reconciliation */

function Variance({ value, format }: { value: number | null; format: (v: number) => string }) {
  if (value === null) return <span className="font-sans text-2xl font-semibold tracking-tight tabular-nums text-silver/60">—</span>;
  const nonzero = value !== 0;
  const sign = value > 0 ? '+' : '';
  return (
    <span className={`font-sans text-2xl font-semibold tracking-tight tabular-nums ${nonzero ? 'text-warning' : 'text-white'}`}>
      {sign}
      {format(value)}
    </span>
  );
}

function ReconciliationCard({ summary, loaded }: { summary: ReconciliationSummary | null | undefined; loaded: boolean }) {
  return (
    <Card>
      <CardContent className="space-y-4">
        <SectionTitle as="h2" title="Reconciliation" icon={Scale} description="Platform against the payroll export, last run." />
        {!loaded ? (
          <p className="text-sm text-silver">—</p>
        ) : !summary ? (
          <p className="text-sm text-silver">
            No reconciliation yet. Once a payroll export has been checked against the platform, the match rate and any differences appear here.
          </p>
        ) : (
          <>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <dt className="text-silver">Period</dt>
              <dd className="text-white">
                {fmtDate(summary.periodStart)} – {fmtDate(summary.periodEnd)}
              </dd>
              <dt className="text-silver">Ran</dt>
              <dd className="text-white">{fmtDateTime(summary.ranAt)}</dd>
              <dt className="text-silver">Platform paid</dt>
              <dd className="tabular-nums text-white">{n(summary.platformPaid)}</dd>
              <dt className="text-silver">Payroll paid</dt>
              <dd className="tabular-nums text-white">{summary.payrollPaid === null ? '—' : n(summary.payrollPaid)}</dd>
            </dl>
            <div className="grid grid-cols-3 gap-3 border-t border-navy-secondary pt-4">
              <div>
                <div className="text-xs2 font-medium uppercase tracking-[0.14em] text-silver/70">Headcount</div>
                <div className="mt-1" data-testid="variance-headcount">
                  <Variance value={summary.headcountVariance} format={n} />
                </div>
              </div>
              <div>
                <div className="text-xs2 font-medium uppercase tracking-[0.14em] text-silver/70">Hours</div>
                <div className="mt-1" data-testid="variance-hours">
                  <Variance value={summary.hoursVariance} format={fmtHours} />
                </div>
              </div>
              <div>
                <div className="text-xs2 font-medium uppercase tracking-[0.14em] text-silver/70">Gross</div>
                <div className="mt-1" data-testid="variance-gross">
                  <Variance value={summary.grossVariance} format={(v) => fmtMoney(v)} />
                </div>
              </div>
            </div>
            <p className="text-xs text-silver">
              {summary.payrollProvided
                ? summary.varianceLines === null
                  ? 'Variance lines not counted.'
                  : `${n(summary.varianceLines)} variance ${summary.varianceLines === 1 ? 'line' : 'lines'}.`
                : 'Payroll figures were not provided for this run; variances show as —.'}
            </p>
            {summary.notes ? <p className="text-xs text-silver">{summary.notes}</p> : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/* --------------------------------------------------------- not active */

function NotActiveCard({ notActive, windowDays }: { notActive: HeadcountOverview['notActive'] | undefined; windowDays: number | undefined }) {
  const rows = notActive
    ? [
        // The People directory's words and filters (one status per person,
        // apps/api/src/lib/peopleStatus.ts): each row opens the people it counts.
        { label: 'No recent shifts', hint: `Placed, no shift worked in ${windowDays ?? 'N'} days and nothing scheduled`, value: notActive.placedNoRecentWork, status: 'PLACED_NOT_ACTIVE' },
        { label: 'Not placed', hint: 'Hired, not placed at any site', value: notActive.employedNotPlaced, status: 'NOT_PLACED' },
        { label: 'Onboarding', hint: 'Onboarding in progress, not hired yet', value: notActive.onboarding, status: 'ONBOARDING' },
        { label: 'Paused', hint: 'Paused by hand; still employed', value: notActive.deactivated, status: 'DEACTIVATED' },
        { label: 'Separated', hint: 'No longer with the company', value: notActive.separated, status: 'SEPARATED' },
      ]
    : null;
  const total = rows ? rows.reduce((s, r) => s + r.value, 0) : 0;
  return (
    <Card>
      <CardContent className="space-y-3">
        <SectionTitle as="h2" title="Not active" description={rows ? `${n(total)} on file who do not count.` : 'On file but not counted, by reason.'} />
        {!rows ? (
          <p className="text-sm text-silver">—</p>
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">People on file who are not active, by reason</caption>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label} className="border-t border-navy-secondary/60 first:border-t-0">
                  <th scope="row" className="py-1.5 pr-3 text-left font-normal">
                    <Link to={`/people?workStatus=${r.status}`} className="text-white underline-offset-2 hover:text-gold hover:underline">{r.label}</Link>
                    <span className="block text-xs2 text-silver/70">{r.hint}</span>
                  </th>
                  <td className="py-1.5 text-right font-sans font-semibold tabular-nums text-white">{n(r.value)}</td>
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

/* ---------------------------------------------------- activity window */

/** The activity window, set from the header's "Activity window" (it changes every headcount on the platform, so it isn't mid-page). */
function ActivityWindowCard({ windowDays, canManage, onSaved }: { windowDays: number | undefined; canManage: boolean; onSaved?: () => void }) {
  const term = useTerm();
  const qc = useQueryClient();
  // null = untouched: the input shows the server value, and a refetch
  // never overwrites what the admin has typed.
  const [typed, setTyped] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const draft = typed ?? (windowDays === undefined ? '' : String(windowDays));

  const parsed = Number(draft);
  const valid = draft !== '' && Number.isInteger(parsed) && parsed >= WINDOW_MIN && parsed <= WINDOW_MAX;
  const dirty = windowDays !== undefined && valid && parsed !== windowDays;

  const save = async () => {
    if (!valid || !canManage) return;
    setSaving(true);
    try {
      await patchOrgBranding({ activeWindowDays: parsed });
      toast.success(`Activity window set to ${parsed} ${parsed === 1 ? 'day' : 'days'}.`);
      setTyped(null);
      await Promise.all([qc.invalidateQueries({ queryKey: ['headcount'] }), qc.invalidateQueries({ queryKey: ['BrandingHome', 'branding'] })]);
      onSaved?.();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not save the activity window.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-silver">How many trailing days of work keep a placed {term('worker').toLowerCase()} Working. Changing it changes every headcount on the platform.</p>
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label htmlFor="headcount-window-days" className="sr-only">
          Activity window (days)
        </label>
        <Input
          id="headcount-window-days"
          type="number"
          inputMode="numeric"
          min={WINDOW_MIN}
          max={WINDOW_MAX}
          step={1}
          size="sm"
          className="w-24 text-right"
          value={draft}
          onChange={(e) => setTyped(e.target.value)}
          invalid={draft !== '' && !valid}
          aria-describedby="headcount-window-range"
          disabled={windowDays === undefined || saving}
        />
        <span id="headcount-window-range" className="text-xs text-silver">
          {WINDOW_MIN}–{WINDOW_MAX} days
        </span>
        <Button type="submit" size="sm" disabled={!dirty || saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </form>
    </div>
  );
}

/* ---------------------------------------------------- store / client */

function CutGrid({ overview, cut, onCut, loading, error, onRetry }: { overview: HeadcountOverview | undefined; cut: Cut; onCut: (c: Cut) => void; loading: boolean; error: unknown; onRetry: () => void }) {
  const term = useTerm();
  // A tenant with no clients cuts by site only.
  const hasClients = useTenant().moduleOn('clientPortal');
  const tz = (t: string) => termizeText(t, term);
  const rows = cut === 'store' ? overview?.byStore : overview?.byClient;
  const hasRate = (rows ?? []).some((r) => r.withoutRate !== null);

  const columns = useMemo<GridColumn<HeadcountRow>[]>(() => {
    const cols: GridColumn<HeadcountRow>[] = [
      {
        key: 'name',
        header: cut === 'store' ? tz('Store') : tz('Client'),
        accessor: (r) => r.name,
        primary: true,
        sortable: true,
        searchable: true,
        cell: (r) =>
          cut === 'client' ? (
            <Link to={`/clients/${r.id}`} className="font-medium text-white hover:text-gold">
              {r.name}
            </Link>
          ) : (
            <span className="font-medium text-white">{r.name}</span>
          ),
      },
    ];
    if (cut === 'store' && hasClients) {
      cols.push({ key: 'client', header: tz('Client'), accessor: (r) => r.clientName ?? '', sortable: true, searchable: true, cardMeta: true });
    }
    cols.push(
      { key: 'active', header: 'Active', accessor: (r) => r.active, sortable: true, align: 'right', className: 'tabular-nums font-semibold' },
      { key: 'scheduled', header: 'Scheduled this week', accessor: (r) => r.scheduledThisWeek, sortable: true, align: 'right', className: 'tabular-nums' },
    );
    if (hasRate) {
      cols.push({
        key: 'withoutRate',
        header: 'Without rate',
        accessor: (r) => r.withoutRate,
        sortable: true,
        align: 'right',
        className: 'tabular-nums',
        cell: (r) => (r.withoutRate === null ? <span className="text-silver/60">—</span> : r.withoutRate),
      });
    }
    return cols;
  }, [cut, hasRate]);

  return (
    <DataGrid
      id={`headcount-${cut}`}
      caption={cut === 'store' ? tz('Active by store') : tz('Active by client')}
      rows={rows ?? []}
      rowKey={(r) => r.id}
      loading={loading}
      error={error ? errorMessage(error, 'Could not load the headcount.') : null}
      onRetry={onRetry}
      search={{ placeholder: cut === 'store' ? (hasClients ? tz('Search stores or clients…') : tz('Search stores…')) : tz('Search clients…') }}
      urlState={false}
      exportCsv={{ filename: cut === 'store' ? 'headcount-by-store' : 'headcount-by-client' }}
      columns={columns}
      defaultSort={{ key: 'active', direction: 'desc' }}
      filters={hasClients ? <SegmentedControl ariaLabel="Cut" options={[{ value: 'store', label: tz('By store') }, { value: 'client', label: tz('By client') }]} value={cut} onChange={onCut} /> : undefined}
      empty={{ title: 'Nobody active', description: 'No one is placed with recent work or an upcoming shift.' }}
    />
  );
}

/* ------------------------------------------------------ compact lists */

function CompactList({ title, rows }: { title: string; rows: { key: string; label: string; count: number; href?: string }[] | undefined }) {
  const max = rows ? Math.max(1, ...rows.map((r) => r.count)) : 1;
  return (
    <Card>
      <CardContent className="space-y-3">
        <SectionTitle as="h2" title={title} />
        {!rows ? (
          <p className="text-sm text-silver">—</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-silver">Nobody active.</p>
        ) : (
          <ul className="space-y-1.5">
            {rows.map((r) => {
              const inner = (
                <span className="flex items-center gap-3 text-sm">
                  <span className="w-40 truncate text-silver">{r.label}</span>
                  <span className="h-2 flex-1 overflow-hidden rounded bg-navy-secondary/40">
                    <span className="block h-full bg-gold" style={{ width: `${(r.count / max) * 100}%` }} />
                  </span>
                  <span className="w-12 text-right font-sans font-semibold tabular-nums text-white">{n(r.count)}</span>
                </span>
              );
              return (
                <li key={r.key}>
                  {r.href ? (
                    <Link to={r.href} className="block rounded px-1 py-0.5 transition hover:bg-navy-secondary/30">
                      {inner}
                    </Link>
                  ) : (
                    <div className="px-1 py-0.5">{inner}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------ the year, month by month */

const monthName = (ym: string) => fmtDate(parseYmd(`${ym}-01`)).replace(/ \d{1,2},/, ',').replace(/,\s*/, ' ');

/**
 * Twelve months of the employed count with each month's hires and
 * separations beside it. It counts everyone employed at the month's end —
 * the people-analytics definition — so it can differ from the active count
 * above, which needs recent work.
 */
function HeadcountTrend() {
  const q = useQuery({ queryKey: ['peopleAnalytics', 12], queryFn: () => getPeopleAnalytics(12), retry: false, staleTime: 5 * 60_000 });
  const rows = useMemo(() => (q.data?.headcount ?? []).map((h) => ({ month: monthName(h.month), headcount: h.headcount, hires: h.hires, separations: -h.separations })), [q.data]);
  if (q.isError || !q.data || rows.length === 0) return null;
  const first = q.data.headcount[0]!;
  const last = q.data.headcount[q.data.headcount.length - 1]!;
  const hires = q.data.headcount.reduce((n, h) => n + h.hires, 0);
  const left = q.data.headcount.reduce((n, h) => n + h.separations, 0);
  return (
    <ChartFrame
      title="Headcount, month by month"
      description="Everyone employed at each month’s end, with that month’s hires above the line and separations below. Counted from hire and separation dates — an invite who never started isn’t in it — so it can sit a little above the active count, which needs recent work."
      summary={`Employed went from ${first.headcount} to ${last.headcount} over ${q.data.headcount.length} months: ${hires} hired, ${left} left.`}
      csvName="headcount-by-month"
      columns={[
        { key: 'month', label: 'Month' },
        { key: 'headcount', label: 'Employed', numeric: true },
        { key: 'hires', label: 'Hires', numeric: true },
        { key: 'separations', label: 'Separations', numeric: true, format: (v) => String(Math.abs(Number(v))) },
      ]}
      rows={rows}
    >
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} stackOffset="sign">
          <CartesianGrid stroke={PALETTE.grid} vertical={false} />
          <XAxis dataKey="month" tick={TICK} tickLine={false} axisLine={false} />
          <YAxis yAxisId="flow" tick={TICK} tickLine={false} axisLine={false} width={48} allowDecimals={false} tickFormatter={(v: number) => String(Math.abs(v))} label={{ value: 'Hires · separations', angle: -90, position: 'insideLeft', style: { ...TICK, textAnchor: 'middle' } }} />
          <YAxis yAxisId="count" orientation="right" tick={TICK} tickLine={false} axisLine={false} width={56} allowDecimals={false} label={{ value: 'Employed', angle: 90, position: 'insideRight', style: { ...TICK, textAnchor: 'middle' } }} />
          <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL_STYLE} cursor={{ fill: PALETTE.cursor }} formatter={(v) => Math.abs(Number(v)).toLocaleString('en-US')} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar yAxisId="flow" dataKey="hires" name="Hires" stackId="flow" fill={PALETTE.good} radius={[3, 3, 0, 0]} maxBarSize={24} />
          <Bar yAxisId="flow" dataKey="separations" name="Separations" stackId="flow" fill={PALETTE.bad} radius={[0, 0, 3, 3]} maxBarSize={24} />
          <Line yAxisId="count" dataKey="headcount" name="Employed" stroke={PALETTE.series[0]} strokeWidth={2} dot={false} type="stepAfter" />
        </ComposedChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
