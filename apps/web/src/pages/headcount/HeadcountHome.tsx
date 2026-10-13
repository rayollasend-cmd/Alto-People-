import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowDown, ArrowUp, Scale, TrendingDown, TrendingUp } from 'lucide-react';
import { toast } from 'sonner';
import type { HeadcountOverview, HeadcountRow, ReconciliationSummary } from '@alto-people/shared';
import { getHeadcountOverview, getTurnover } from '@/lib/headcount110Api';
import { patchOrgBranding } from '@/lib/brandingApi';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtDateTime, fmtHours, fmtMoney } from '@/lib/format';
import { EMPLOYMENT_LABEL } from '@/lib/employmentLabels';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { MetricCard } from '@/components/ui/MetricCard';
import { QueryError } from '@/components/ui/QueryError';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Input } from '@/components/ui/Input';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';

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

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError && err.message ? err.message : fallback;
}

const n = (v: number) => v.toLocaleString('en-US');

export function HeadcountHome() {
  const { can } = useAuth();
  const canManage = can('manage:org');
  const [days, setDays] = useState<TurnoverDays>(90);
  const [cut, setCut] = useState<Cut>('store');

  const overview = useQuery({ queryKey: ['headcount', 'overview'], queryFn: getHeadcountOverview });
  const turnover = useQuery({ queryKey: ['headcount', 'turnover', days], queryFn: () => getTurnover(days) });

  const o = overview.data;
  const t = turnover.data;
  const loading = overview.isLoading;

  const payrollHint = o
    ? o.onPayrollLastPeriod
      ? `${fmtDate(o.onPayrollLastPeriod.periodStart)} – ${fmtDate(o.onPayrollLastPeriod.periodEnd)}`
      : 'No closed pay run'
    : undefined;

  return (
    <div className="space-y-6">
      <PageHeader title="Headcount" subtitle={definitionSentence(o?.windowDays)} breadcrumbs={[{ label: 'Headcount' }]} />

      {overview.isError && <QueryError what="the headcount" query={overview} />}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="Active associates"
          value={loading || !o ? '—' : n(o.active)}
          hint={o ? `Worked in the last ${o.windowDays} days or scheduled ahead` : undefined}
        />
        <MetricCard label="Scheduled this week" value={loading || !o ? '—' : n(o.scheduledThisWeek)} hint="On an assigned shift in the current workweek" />
        <MetricCard label="On payroll last period" value={loading || !o ? '—' : o.onPayrollLastPeriod ? n(o.onPayrollLastPeriod.count) : '—'} hint={payrollHint} />
        <MetricCard label="In housing" value={loading || !o ? '—' : o.inHousing === null ? '—' : n(o.inHousing)} hint={o && o.inHousing === null ? 'No housing link yet' : undefined} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ReconciliationCard summary={o?.reconciliation} loaded={Boolean(o)} />
        <NotActiveCard notActive={o?.notActive} windowDays={o?.windowDays} />
      </div>

      <ActivityWindowCard windowDays={o?.windowDays} canManage={canManage} />

      <CutGrid overview={o} cut={cut} onCut={setCut} loading={loading} error={overview.error} onRetry={() => overview.refetch()} />

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
        <div className="grid gap-4 sm:grid-cols-3">
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
        </div>
      </section>
    </div>
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
      <CardContent className="space-y-4 pt-5">
        <SectionTitle as="h2" title="Reconciliation" icon={Scale} description="Platform against the payroll export, last run." />
        {!loaded ? (
          <p className="text-sm text-silver">—</p>
        ) : !summary ? (
          <p className="text-sm text-silver">
            No reconciliation run yet. Run <code className="rounded bg-navy-secondary/60 px-1 py-0.5 text-xs text-white">scripts/reconcile-payroll.ts --persist</code> against production after the payroll export arrives.
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
        { label: 'Onboarding', hint: 'Application open, not placed yet', value: notActive.onboarding },
        { label: 'Placed, no recent work', hint: `No clock-in in ${windowDays ?? 'N'} days and nothing scheduled`, value: notActive.placedNoRecentWork },
        { label: 'Employed, not placed', hint: 'No open assignment or approved application', value: notActive.employedNotPlaced },
        { label: 'Separated', hint: 'Left the company', value: notActive.separated },
        { label: 'Deactivated', hint: 'Account switched off', value: notActive.deactivated },
      ]
    : null;
  const total = rows ? rows.reduce((s, r) => s + r.value, 0) : 0;
  return (
    <Card>
      <CardContent className="space-y-3 pt-5">
        <SectionTitle as="h2" title="Not active" description={rows ? `${n(total)} on file who do not count.` : 'On file but not counted, by reason.'} />
        {!rows ? (
          <p className="text-sm text-silver">—</p>
        ) : (
          <table className="w-full text-sm">
            <caption className="sr-only">People on file who are not active, by reason</caption>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label} className="border-t border-navy-secondary/60 first:border-t-0">
                  <th scope="row" className="py-1.5 pr-3 text-left font-normal">
                    <span className="text-white">{r.label}</span>
                    <span className="block text-xs2 text-silver/70">{r.hint}</span>
                  </th>
                  <td className="py-1.5 text-right font-sans font-semibold tabular-nums text-white">{n(r.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

/* ---------------------------------------------------- activity window */

function ActivityWindowCard({ windowDays, canManage }: { windowDays: number | undefined; canManage: boolean }) {
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
    } catch (err) {
      toast.error(errorMessage(err, 'Could not save the activity window.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-4 pt-5">
        <div className="min-w-0">
          <h2 className="text-base font-medium text-white">Activity window (days)</h2>
          <p className="text-sm text-silver">How many trailing days of work keep a placed associate active. Changing it changes every headcount on the platform.</p>
        </div>
        {canManage ? (
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
              {WINDOW_MIN}–{WINDOW_MAX}
            </span>
            <Button type="submit" size="sm" disabled={!dirty || saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </form>
        ) : (
          <p className="font-sans text-2xl font-semibold tracking-tight tabular-nums text-white" data-testid="window-readonly">
            {windowDays === undefined ? '—' : `${windowDays} ${windowDays === 1 ? 'day' : 'days'}`}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/* ---------------------------------------------------- store / client */

function CutGrid({ overview, cut, onCut, loading, error, onRetry }: { overview: HeadcountOverview | undefined; cut: Cut; onCut: (c: Cut) => void; loading: boolean; error: unknown; onRetry: () => void }) {
  const rows = cut === 'store' ? overview?.byStore : overview?.byClient;
  const hasRate = (rows ?? []).some((r) => r.withoutRate !== null);

  const columns = useMemo<GridColumn<HeadcountRow>[]>(() => {
    const cols: GridColumn<HeadcountRow>[] = [
      {
        key: 'name',
        header: cut === 'store' ? 'Store' : 'Client',
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
    if (cut === 'store') {
      cols.push({ key: 'client', header: 'Client', accessor: (r) => r.clientName ?? '', sortable: true, searchable: true, cardMeta: true });
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
      caption={cut === 'store' ? 'Active by store' : 'Active by client'}
      rows={rows ?? []}
      rowKey={(r) => r.id}
      loading={loading}
      error={error ? errorMessage(error, 'Could not load the headcount.') : null}
      onRetry={onRetry}
      search={{ placeholder: cut === 'store' ? 'Search stores or clients…' : 'Search clients…' }}
      urlState={false}
      exportCsv={{ filename: cut === 'store' ? 'headcount-by-store' : 'headcount-by-client' }}
      columns={columns}
      defaultSort={{ key: 'active', direction: 'desc' }}
      filters={<SegmentedControl ariaLabel="Cut" options={[{ value: 'store', label: 'By store' }, { value: 'client', label: 'By client' }]} value={cut} onChange={onCut} />}
      empty={{ title: 'Nobody active', description: 'No one is placed with recent work or an upcoming shift.' }}
    />
  );
}

/* ------------------------------------------------------ compact lists */

function CompactList({ title, rows }: { title: string; rows: { key: string; label: string; count: number; href?: string }[] | undefined }) {
  const max = rows ? Math.max(1, ...rows.map((r) => r.count)) : 1;
  return (
    <Card>
      <CardContent className="space-y-3 pt-5">
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
