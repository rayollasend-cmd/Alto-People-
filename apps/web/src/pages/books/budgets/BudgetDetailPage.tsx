import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, CheckCircle2, Download, History, Plus, Save, Trash2 } from 'lucide-react';
import type { BudgetAccountOption, BudgetDetail, BudgetVsActual, BudgetVsActualCell, BudgetVsActualRow } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { budgetFromActuals, budgetVsActualXlsxUrl, getBudget, getBudgetVsActual, saveBudgetLines, updateBudget } from '@/lib/books/closeApi';
import { usePrompt } from '@/lib/confirm';
import { fmtMoney } from '@/lib/format';
import { cn } from '@/lib/cn';
import { RecordTemplate } from '@/components/templates';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { MetricCard } from '@/components/ui/MetricCard';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { toast } from '@/components/ui/Toaster';
import { BUDGET_STATUS } from './BudgetsPage';

/**
 * One budget: the grid (accounts × months, a sticky account column, totals
 * by section and the net), and budget vs actual — year to date with the
 * forecast and run rate, or month by month.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const cents = (n: number) => Math.round(n * 100);
const WHOLE = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
/** Whole dollars for the dense grid; exact amounts stay in the tables that read against actuals. */
const money0 = (n: number) => WHOLE.format(Math.round(n));

type GridRow = { key: string; accountId: string; clientId: string | null; departmentId: string | null; months: string[] };

const isIncome = (a: BudgetAccountOption | undefined) => a?.type === 'INCOME';

export function BudgetDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const { can } = useAuth();
  const qc = useQueryClient();
  const prompt = usePrompt();
  const [tab, setTab] = useState('grid');
  const q = useQuery({ queryKey: ['books', 'budgets', id], queryFn: () => getBudget(id) });
  const b = q.data?.budget;
  const editable = can('manage:books') && !!b && b.status !== 'ARCHIVED';

  const setStatus = useMutation({
    mutationFn: (status: 'ACTIVE' | 'ARCHIVED' | 'DRAFT') => updateBudget(id, { status }),
    onSuccess: ({ budget, demoted }) => {
      qc.setQueryData(['books', 'budgets', id], { budget });
      void qc.invalidateQueries({ queryKey: ['books', 'budgets'] });
      toast.success(budget.status === 'ACTIVE' ? (demoted ? `Active — ${demoted} went back to draft.` : 'Active for the year.') : budget.status === 'ARCHIVED' ? 'Archived.' : 'Back to draft.');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'That didn’t go through.'),
  });
  const fromActuals = useMutation({
    mutationFn: (growth: number) => budgetFromActuals(id, growth),
    onSuccess: ({ budget }) => {
      qc.setQueryData(['books', 'budgets', id], { budget });
      toast.success(`Rebuilt from ${budget.fiscalYear - 1} actuals.`);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not start from actuals.'),
  });

  if (q.isLoading) return <Skeleton className="h-96 w-full" />;
  if (q.error || !b) return <EmptyState title="Couldn’t load this budget" description={q.error instanceof ApiError ? q.error.message : 'Try again in a moment.'} />;

  const askFromActuals = async () => {
    const pct = await prompt({ title: `Rebuild from ${b.fiscalYear - 1} actuals?`, description: 'Replaces the grid with last year’s actuals, account by account, grown by the percentage you give.', reasonLabel: 'Grow by (%)', reasonPlaceholder: '5', confirmLabel: 'Rebuild the grid' });
    if (pct !== null) fromActuals.mutate(Number(pct.replace('%', '')) || 0);
  };

  return (
    <RecordTemplate
      breadcrumbs={[{ label: 'Books', to: '/books' }, { label: 'Budgets', to: '/books/budgets' }, { label: b.name }]}
      title={b.name}
      subtitle={`Fiscal ${b.fiscalYear}${b.notes ? ` · ${b.notes}` : ''}`}
      status={<Badge size="lg" variant={BUDGET_STATUS[b.status]?.variant ?? 'default'}>{BUDGET_STATUS[b.status]?.label ?? b.status}</Badge>}
      actions={
        can('manage:books') ? (
          <div className="flex flex-wrap gap-2">
            {b.status !== 'ACTIVE' && (
              <Button onClick={() => setStatus.mutate('ACTIVE')} loading={setStatus.isPending}>
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                Make active
              </Button>
            )}
            {b.status !== 'ARCHIVED' && (
              <Button variant="secondary" onClick={() => void askFromActuals()} loading={fromActuals.isPending}>
                <History className="h-4 w-4" aria-hidden="true" />
                From last year
              </Button>
            )}
            {b.status === 'ACTIVE' && (
              <Button variant="ghost" onClick={() => setStatus.mutate('ARCHIVED')}>
                <Archive className="h-4 w-4" aria-hidden="true" />
                Archive
              </Button>
            )}
          </div>
        ) : undefined
      }
      summary={
        <div className="grid gap-3 sm:grid-cols-3">
          <MetricCard label="Income" value={fmtMoney(b.totalIncome)} />
          <MetricCard label="Costs and expenses" value={fmtMoney(b.totalExpense)} />
          <MetricCard label="Net" value={fmtMoney(b.net)} accent={b.net < 0} />
        </div>
      }
      activeTab={tab}
      onTabChange={setTab}
      tabs={[
        { key: 'grid', label: 'Budget', content: <BudgetGrid budget={b} editable={editable} /> },
        { key: 'actual', label: 'Budget vs actual', content: <VsActual budget={b} /> },
      ]}
    />
  );
}

/* ---- The grid ------------------------------------------------------------ */

function toRows(b: BudgetDetail): GridRow[] {
  return b.lines.map((l) => ({ key: `${l.accountId}|${l.clientId ?? ''}|${l.departmentId ?? ''}`, accountId: l.accountId, clientId: l.clientId, departmentId: l.departmentId, months: l.months.map((m) => (m ? String(m) : '')) }));
}

function BudgetGrid({ budget: b, editable }: { budget: BudgetDetail; editable: boolean }) {
  const qc = useQueryClient();
  const [rows, setRows] = useState<GridRow[]>(() => toRows(b));
  const [dirty, setDirty] = useState(false);
  const [adding, setAdding] = useState('');
  useEffect(() => {
    setRows(toRows(b));
    setDirty(false);
  }, [b]);
  const byId = useMemo(() => new Map(b.accounts.map((a) => [a.id, a])), [b.accounts]);
  const save = useMutation({
    mutationFn: () => saveBudgetLines(b.id, { lines: rows.map((r) => ({ accountId: r.accountId, clientId: r.clientId, departmentId: r.departmentId, months: r.months.map((m) => Number(m) || 0) })) }),
    onSuccess: ({ budget }) => {
      qc.setQueryData(['books', 'budgets', b.id], { budget });
      void qc.invalidateQueries({ queryKey: ['books', 'budgets'] });
      toast.success('Budget saved.');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save the budget.'),
  });

  const edit = (key: string, i: number, v: string) => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, months: r.months.map((m, j) => (j === i ? v : m)) } : r)));
    setDirty(true);
  };
  /** Type an annual total: it spreads evenly, the rounding in the last months. */
  const spreadTotal = (key: string, v: string) => {
    const total = cents(Number(v) || 0);
    const base = Math.trunc(total / 12);
    const rest = total - base * 12;
    const months = Array.from({ length: 12 }, (_, i) => String((base + (i >= 12 - Math.abs(rest) ? Math.sign(rest) : 0)) / 100));
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, months } : r)));
    setDirty(true);
  };
  const remove = (key: string) => {
    setRows((rs) => rs.filter((r) => r.key !== key));
    setDirty(true);
  };
  const add = (accountId: string) => {
    if (!accountId || rows.some((r) => r.key === `${accountId}||`)) return;
    setRows((rs) => [...rs, { key: `${accountId}||`, accountId, clientId: null, departmentId: null, months: Array(12).fill('') }]);
    setAdding('');
    setDirty(true);
  };

  const rowTotal = (r: GridRow) => r.months.reduce((s, m) => s + cents(Number(m) || 0), 0) / 100;
  const groups = [
    { label: 'Income', rows: rows.filter((r) => isIncome(byId.get(r.accountId))) },
    { label: 'Costs and expenses', rows: rows.filter((r) => !isIncome(byId.get(r.accountId))) },
  ];
  const colTotal = (rs: GridRow[], i: number) => rs.reduce((s, r) => s + cents(Number(r.months[i]) || 0), 0) / 100;
  const net = (i: number) => colTotal(groups[0]!.rows, i) - colTotal(groups[1]!.rows, i);
  const netTotal = groups[0]!.rows.reduce((s, r) => s + rowTotal(r), 0) - groups[1]!.rows.reduce((s, r) => s + rowTotal(r), 0);
  const unused = b.accounts.filter((a) => !rows.some((r) => r.accountId === a.id && !r.clientId && !r.departmentId));
  const label = (r: GridRow) => {
    const a = byId.get(r.accountId);
    return a ? `${a.code} ${a.name}` : 'An account';
  };

  return (
    <Card>
      <CardContent className="space-y-3 pt-[var(--d-tile)]">
        {editable && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <Select size="sm" aria-label="Add an account" value={adding} onChange={(e) => add(e.target.value)} className="w-72">
                <option value="">Add an account…</option>
                {unused.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} {a.name}
                  </option>
                ))}
              </Select>
              <Plus className="h-4 w-4 text-ink-muted" aria-hidden="true" />
            </div>
            <div className="flex items-center gap-3">
              {dirty && <span className="text-xs text-warning">Unsaved changes</span>}
              <Button size="sm" onClick={() => save.mutate()} disabled={!dirty} loading={save.isPending}>
                <Save className="h-4 w-4" aria-hidden="true" />
                Save budget
              </Button>
            </div>
          </div>
        )}
        {rows.length === 0 ? (
          <EmptyState title="An empty grid" description={editable ? 'Add an account above, or start from last year’s actuals.' : 'This budget has no lines.'} />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="min-w-max text-sm">
              <thead className="bg-surface-raised">
                <tr>
                  <th className="sticky left-0 z-10 min-w-64 bg-surface-raised px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-ink-muted">Account</th>
                  {MONTHS.map((m) => (
                    <th key={m} className="px-2 py-2 text-right text-xs font-medium uppercase tracking-wide text-ink-muted">
                      {m}
                    </th>
                  ))}
                  <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-ink-muted">Year</th>
                  {editable && <th className="px-2 py-2" aria-label="Remove" />}
                </tr>
              </thead>
              {groups.map((g) =>
                g.rows.length ? (
                  <tbody key={g.label} className="divide-y divide-line">
                    <tr>
                      <th colSpan={editable ? 15 : 14} className="sticky left-0 bg-surface px-3 pb-1 pt-3 text-left text-2xs font-semibold uppercase tracking-widest text-ink-muted">
                        {g.label}
                      </th>
                    </tr>
                    {g.rows.map((r) => (
                      <tr key={r.key}>
                        <th scope="row" className="sticky left-0 z-10 max-w-72 truncate bg-surface px-3 py-1.5 text-left font-normal text-ink">
                          {label(r)}
                          {(r.clientId || r.departmentId) && <span className="ml-1 text-xs text-ink-muted">(one {r.clientId ? 'client' : 'department'})</span>}
                        </th>
                        {r.months.map((m, i) => (
                          <td key={i} className="px-1 py-1">
                            {editable ? (
                              <input
                                aria-label={`${label(r)}, ${MONTHS[i]}`}
                                inputMode="decimal"
                                className="w-24 rounded-md border border-line bg-surface px-2 py-1 text-right tabular-nums text-ink focus:border-gold focus:outline-none"
                                value={m}
                                onChange={(e) => edit(r.key, i, e.target.value)}
                              />
                            ) : (
                              <span className="block w-24 px-2 text-right tabular-nums text-ink">{m ? money0(Number(m)) : '—'}</span>
                            )}
                          </td>
                        ))}
                        <td className="px-3 py-1 text-right">
                          {editable ? (
                            <input
                              aria-label={`${label(r)}, year total (spreads evenly)`}
                              title="Type a year total to spread it evenly"
                              inputMode="decimal"
                              className="w-28 rounded-md border border-line bg-surface-raised px-2 py-1 text-right font-medium tabular-nums text-ink focus:border-gold focus:outline-none"
                              defaultValue={rowTotal(r) || ''}
                              key={`${r.key}:${rowTotal(r)}`}
                              onBlur={(e) => Number(e.target.value) !== rowTotal(r) && spreadTotal(r.key, e.target.value)}
                            />
                          ) : (
                            <span className="font-medium tabular-nums text-ink">{money0(rowTotal(r))}</span>
                          )}
                        </td>
                        {editable && (
                          <td className="px-2">
                            <Button size="icon-sm" variant="ghost" aria-label={`Remove ${label(r)}`} onClick={() => remove(r.key)}>
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </td>
                        )}
                      </tr>
                    ))}
                    <tr className="bg-surface-raised/60">
                      <th scope="row" className="sticky left-0 bg-surface-raised px-3 py-1.5 text-left text-xs font-semibold text-ink">
                        Total {g.label.toLowerCase()}
                      </th>
                      {MONTHS.map((_, i) => (
                        <td key={i} className="px-3 py-1.5 text-right text-xs font-semibold tabular-nums text-ink">
                          {money0(colTotal(g.rows, i))}
                        </td>
                      ))}
                      <td className="px-3 py-1.5 text-right text-xs font-semibold tabular-nums text-ink">{money0(g.rows.reduce((s, r) => s + rowTotal(r), 0))}</td>
                      {editable && <td />}
                    </tr>
                  </tbody>
                ) : null,
              )}
              <tfoot>
                <tr className="border-t-2 border-ink/40">
                  <th scope="row" className="sticky left-0 bg-surface px-3 py-2 text-left font-semibold text-ink">
                    Net
                  </th>
                  {MONTHS.map((_, i) => (
                    <td key={i} className={cn('px-3 py-2 text-right font-semibold tabular-nums', net(i) < 0 ? 'text-alert' : 'text-ink')}>
                      {money0(net(i))}
                    </td>
                  ))}
                  <td className={cn('px-3 py-2 text-right font-semibold tabular-nums', netTotal < 0 ? 'text-alert' : 'text-ink')}>{money0(netTotal)}</td>
                  {editable && <td />}
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ---- Budget vs actual ---------------------------------------------------- */

function lastEndedMonth(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getFullYear(), d.getMonth() - 1, 1)).toISOString().slice(0, 7);
}

function VarianceCell({ c, income }: { c: BudgetVsActualCell; income: boolean }) {
  const favorable = income ? c.variance >= 0 : c.variance <= 0;
  if (c.budget === 0 && c.actual === 0) return <span className="text-ink-muted">—</span>;
  return (
    <span className={cn('tabular-nums', c.variance === 0 ? 'text-ink-muted' : favorable ? 'text-success' : 'text-alert')}>
      {c.variance > 0 ? '+' : ''}
      {fmtMoney(c.variance)}
      {c.variancePct !== null && <span className="ml-1 text-xs opacity-80">({c.variancePct > 0 ? '+' : ''}{c.variancePct}%)</span>}
    </span>
  );
}

function VsActual({ budget: b }: { budget: BudgetDetail }) {
  const fallback = lastEndedMonth();
  const defaultThrough = fallback < `${b.fiscalYear}-01` ? `${b.fiscalYear}-01` : fallback > `${b.fiscalYear}-12` ? `${b.fiscalYear}-12` : fallback;
  const [through, setThrough] = useState(defaultThrough);
  const [view, setView] = useState<'ytd' | 'months'>('ytd');
  const q = useQuery({ queryKey: ['books', 'budgets', b.id, 'vs', through], queryFn: () => getBudgetVsActual(b.id, through) });
  const r = q.data;
  return (
    <Card>
      <CardContent className="space-y-4 pt-[var(--d-tile)]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <Select size="sm" aria-label="Through" value={through} onChange={(e) => setThrough(e.target.value)} className="w-44">
              {b.periods.map((p, i) => (
                <option key={p} value={p}>
                  Through {MONTHS[i]} {b.fiscalYear}
                </option>
              ))}
            </Select>
            <SegmentedControl
              ariaLabel="View"
              value={view}
              onChange={(v) => setView(v as 'ytd' | 'months')}
              options={[
                { value: 'ytd', label: 'Year to date' },
                { value: 'months', label: 'By month' },
              ]}
            />
          </div>
          <Button asChild size="sm" variant="secondary">
            <a href={budgetVsActualXlsxUrl(b.id, through)}>
              <Download className="h-4 w-4" aria-hidden="true" />
              Excel
            </a>
          </Button>
        </div>
        {q.isLoading || !r ? (
          <Skeleton className="h-64 w-full" />
        ) : r.sections.length === 0 ? (
          <EmptyState title="Nothing to compare yet" description="Add lines to the budget, or wait for the books to have activity in the year." />
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <MetricCard label="Net income, year to date" value={fmtMoney(r.netIncome.ytd.actual)} hint={`Budget ${fmtMoney(r.netIncome.ytd.budget)}`} accent={r.netIncome.ytd.variance < 0} />
              <MetricCard label="Forecast to year end" value={fmtMoney(r.netIncome.forecast)} hint="Actual so far + the budget left" />
              <MetricCard label="At the current pace" value={fmtMoney(r.netIncome.runRate)} hint={`Annual budget ${fmtMoney(r.netIncome.annualBudget)}`} />
            </div>
            {view === 'ytd' ? <YtdTable report={r} /> : <MonthTable report={r} />}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function YtdTable({ report: r }: { report: BudgetVsActual }) {
  const head = ['Budget YTD', 'Actual YTD', 'Variance', 'Annual budget', 'Forecast', 'Run rate'];
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="w-full min-w-[56rem] text-sm">
        <thead className="bg-surface-raised">
          <tr>
            <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-ink-muted">Account</th>
            {head.map((h) => (
              <th key={h} className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-ink-muted">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        {r.sections.map((s) => {
          const income = s.key === 'income' || s.key === 'otherIncome';
          return (
            <tbody key={s.key} className="divide-y divide-line">
              <tr>
                <th colSpan={7} className="px-3 pb-1 pt-3 text-left text-2xs font-semibold uppercase tracking-widest text-ink-muted">
                  {s.label}
                </th>
              </tr>
              {s.rows.map((row) => (
                <AccountRow key={row.accountId} row={row} income={income} />
              ))}
              <tr className="bg-surface-raised/60 font-semibold">
                <th scope="row" className="px-3 py-1.5 text-left text-xs text-ink">
                  Total {s.label.toLowerCase()}
                </th>
                <td className="px-3 py-1.5 text-right tabular-nums text-ink">{fmtMoney(s.ytd.budget)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-ink">{fmtMoney(s.ytd.actual)}</td>
                <td className="px-3 py-1.5 text-right">
                  <VarianceCell c={s.ytd} income={income} />
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums text-ink">{fmtMoney(s.annualBudget)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-ink">{fmtMoney(s.forecast)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-ink">{fmtMoney(s.runRate)}</td>
              </tr>
            </tbody>
          );
        })}
        <tfoot>
          <tr className="border-t-2 border-ink/40 font-semibold">
            <th scope="row" className="px-3 py-2 text-left text-ink">
              Net income
            </th>
            <td className="px-3 py-2 text-right tabular-nums text-ink">{fmtMoney(r.netIncome.ytd.budget)}</td>
            <td className="px-3 py-2 text-right tabular-nums text-ink">{fmtMoney(r.netIncome.ytd.actual)}</td>
            <td className="px-3 py-2 text-right">
              <VarianceCell c={r.netIncome.ytd} income />
            </td>
            <td className="px-3 py-2 text-right tabular-nums text-ink">{fmtMoney(r.netIncome.annualBudget)}</td>
            <td className="px-3 py-2 text-right tabular-nums text-ink">{fmtMoney(r.netIncome.forecast)}</td>
            <td className="px-3 py-2 text-right tabular-nums text-ink">{fmtMoney(r.netIncome.runRate)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function AccountRow({ row, income }: { row: BudgetVsActualRow; income: boolean }) {
  return (
    <tr>
      <th scope="row" className="px-3 py-1.5 text-left font-normal">
        <Link to={`/books/accounts/${row.accountId}`} className="text-ink hover:text-gold hover:underline">
          <span className="tabular-nums text-ink-muted">{row.code}</span> {row.name}
        </Link>
      </th>
      <td className="px-3 py-1.5 text-right tabular-nums text-ink-muted">{fmtMoney(row.ytd.budget)}</td>
      <td className="px-3 py-1.5 text-right tabular-nums text-ink">{fmtMoney(row.ytd.actual)}</td>
      <td className="px-3 py-1.5 text-right">
        <VarianceCell c={row.ytd} income={income} />
      </td>
      <td className="px-3 py-1.5 text-right tabular-nums text-ink-muted">{fmtMoney(row.annualBudget)}</td>
      <td className="px-3 py-1.5 text-right tabular-nums text-ink">{fmtMoney(row.forecast)}</td>
      <td className="px-3 py-1.5 text-right tabular-nums text-ink-muted">{fmtMoney(row.runRate)}</td>
    </tr>
  );
}

function MonthTable({ report: r }: { report: BudgetVsActual }) {
  const elapsed = r.monthsElapsed;
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="min-w-max text-sm">
        <thead className="bg-surface-raised">
          <tr>
            <th className="sticky left-0 z-10 min-w-64 bg-surface-raised px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-ink-muted">Account</th>
            {MONTHS.map((m, i) => (
              <th key={m} className={cn('px-3 py-2 text-right text-xs font-medium uppercase tracking-wide', i < elapsed ? 'text-ink-muted' : 'text-ink-muted/50')}>
                {m}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {r.sections.flatMap((s) =>
            s.rows.map((row) => {
              const income = s.key === 'income' || s.key === 'otherIncome';
              return (
                <tr key={row.accountId}>
                  <th scope="row" className="sticky left-0 z-10 max-w-72 truncate bg-surface px-3 py-1.5 text-left font-normal text-ink">
                    <span className="tabular-nums text-ink-muted">{row.code}</span> {row.name}
                  </th>
                  {row.months.map((c, i) => {
                    const fav = income ? c.variance >= 0 : c.variance <= 0;
                    return (
                      <td key={i} className="px-3 py-1.5 text-right">
                        {i < elapsed ? (
                          <span className={cn('block tabular-nums', c.budget === 0 && c.actual === 0 ? 'text-ink-muted' : fav ? 'text-ink' : 'text-alert')}>{money0(c.actual)}</span>
                        ) : (
                          <span className="block tabular-nums text-ink-muted">—</span>
                        )}
                        <span className="block text-2xs tabular-nums text-ink-muted">of {money0(c.budget)}</span>
                      </td>
                    );
                  })}
                </tr>
              );
            }),
          )}
        </tbody>
      </table>
    </div>
  );
}
