import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, CheckCircle2, Download, History, Pencil, Plus, Save, Trash2 } from '@/components/ui/icons';
import type { BudgetAccountOption, BudgetDetail, BudgetVsActual, BudgetVsActualCell, BudgetVsActualRow } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { budgetFromActuals, budgetVsActualXlsxUrl, getBudget, getBudgetVsActual, saveBudgetLines, updateBudget } from '@/lib/books/closeApi';
import { usePrompt } from '@/lib/confirm';
import { fmtMoneyWhole } from '@/lib/format';
import { useUrlParam } from '@/lib/useUrlState';
import { cn } from '@/lib/cn';
import { RecordTemplate } from '@/components/templates';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { toast } from '@/components/ui/Toaster';
import { BudgetCharts } from './BudgetCharts';
import { BUDGET_STATUS } from './BudgetsPage';

/**
 * One budget: the grid (accounts × months, a sticky account column, totals
 * by section and the net), and budget vs actual — year to date with the
 * forecast and run rate, or month by month.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const cents = (n: number) => Math.round(n * 100);
/**
 * Whole dollars across the page — the grid, the tiles and budget vs actual
 * alike. A budget is a plan; three formats on one screen (330000 / $330,000 /
 * $3,960,000.00) read as three kinds of number.
 */
const money0 = (n: number) => fmtMoneyWhole(n);
const NUM = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
/** What a person typed, as a number: "24,000", "$24000" and "24000" are the same. */
export const parseAmount = (s: string): number => Number(s.replace(/[$,\s]/g, '')) || 0;
/** An amount in an input that isn't being edited: "330,000". */
export const amountShown = (s: string): string => (s.trim() === '' ? '' : NUM.format(Math.round(parseAmount(s))));

type BudgetTab = 'auto' | 'grid' | 'actual';
const BUDGET_TABS: BudgetTab[] = ['auto', 'grid', 'actual'];

/**
 * A money input that reads formatted ("330,000") and edits raw: focus shows
 * what's stored, blur formats it again.
 */
function AmountInput({ value, onChange, onCommit, className, ...rest }: { value: string; onChange?: (v: string) => void; onCommit?: (v: string) => void; className?: string; 'aria-label': string; title?: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      {...rest}
      inputMode="decimal"
      className={className}
      value={draft ?? amountShown(value)}
      onFocus={() => setDraft(value)}
      onChange={(e) => {
        setDraft(e.target.value);
        onChange?.(e.target.value);
      }}
      onBlur={() => {
        if (draft !== null) onCommit?.(draft);
        setDraft(null);
      }}
    />
  );
}

type GridRow = { key: string; accountId: string; clientId: string | null; departmentId: string | null; months: string[] };

const isIncome = (a: BudgetAccountOption | undefined) => a?.type === 'INCOME';

export function BudgetDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const { can } = useAuth();
  const qc = useQueryClient();
  const prompt = usePrompt();
  // An active budget opens on how it's going; a draft on its lines. The tab is in the URL.
  const [tabParam, setTabParam] = useUrlParam<BudgetTab>('tab', 'auto', BUDGET_TABS, { history: 'push' });
  const q = useQuery({ queryKey: ['books', 'budgets', id], queryFn: () => getBudget(id) });
  const b = q.data?.budget;
  const editable = can('manage:books') && !!b && b.status !== 'ARCHIVED';
  const tab = tabParam === 'auto' ? (b?.status === 'DRAFT' ? 'grid' : 'actual') : tabParam;

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

  const manage = can('manage:books');
  return (
    <RecordTemplate
      title={b.name}
      subtitle={`Fiscal ${b.fiscalYear}${b.notes ? ` · ${b.notes}` : ''}`}
      status={<Badge size="lg" variant={BUDGET_STATUS[b.status]?.variant ?? 'default'}>{BUDGET_STATUS[b.status]?.label ?? b.status}</Badge>}
      actions={
        manage
          ? [
              { label: 'Make active', icon: CheckCircle2, primary: true, hidden: b.status === 'ACTIVE', loading: setStatus.isPending, onSelect: () => setStatus.mutate('ACTIVE') },
              { label: 'Fill from last year’s actuals…', icon: History, hidden: b.status === 'ARCHIVED', loading: fromActuals.isPending, onSelect: () => void askFromActuals() },
              {
                label: 'Archive',
                icon: Archive,
                destructive: true,
                hidden: b.status !== 'ACTIVE',
                confirm: { title: `Archive ${b.name}?`, description: 'It stops being the year’s active budget; the books overview no longer reads against it. You can make it active again later.', confirmLabel: 'Archive' },
                onSelect: () => setStatus.mutate('ARCHIVED'),
              },
            ]
          : undefined
      }
      summary={
        <MetricStrip label={`${b.name} at a glance`}>
          <MetricCard label="Income" value={money0(b.totalIncome)} tone="neutral" />
          <MetricCard label="Costs and expenses" value={money0(b.totalExpense)} tone="neutral" />
          <MetricCard label="Net" value={money0(b.net)} tone={b.net < 0 ? 'alert' : 'default'} />
        </MetricStrip>
      }
      activeTab={tab}
      onTabChange={(k) => setTabParam(k as BudgetTab)}
      tabs={[
        { key: 'actual', label: 'Budget vs actual', content: <VsActual budget={b} /> },
        { key: 'grid', label: 'Budget', content: <BudgetGrid budget={b} editable={editable} /> },
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
  // Read first: the grid is figures until someone chooses to change them. An empty draft opens ready to fill.
  const [editing, setEditing] = useState(() => editable && b.lines.length === 0);
  useEffect(() => {
    setRows(toRows(b));
    setDirty(false);
  }, [b]);
  const editingNow = editable && editing;
  const byId = useMemo(() => new Map(b.accounts.map((a) => [a.id, a])), [b.accounts]);
  const save = useMutation({
    mutationFn: () => saveBudgetLines(b.id, { lines: rows.map((r) => ({ accountId: r.accountId, clientId: r.clientId, departmentId: r.departmentId, months: r.months.map((m) => parseAmount(m)) })) }),
    onSuccess: ({ budget }) => {
      qc.setQueryData(['books', 'budgets', b.id], { budget });
      void qc.invalidateQueries({ queryKey: ['books', 'budgets'] });
      toast.success('Budget saved.');
      setEditing(false);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save the budget.'),
  });

  const edit = (key: string, i: number, v: string) => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, months: r.months.map((m, j) => (j === i ? v : m)) } : r)));
    setDirty(true);
  };
  /** Type an annual total: it spreads evenly, the rounding in the last months. */
  const spreadTotal = (key: string, v: string) => {
    const total = cents(parseAmount(v));
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

  const rowTotal = (r: GridRow) => r.months.reduce((s, m) => s + cents(parseAmount(m)), 0) / 100;
  const groups = [
    { label: 'Income', rows: rows.filter((r) => isIncome(byId.get(r.accountId))) },
    { label: 'Costs and expenses', rows: rows.filter((r) => !isIncome(byId.get(r.accountId))) },
  ];
  const colTotal = (rs: GridRow[], i: number) => rs.reduce((s, r) => s + cents(parseAmount(r.months[i] ?? '')), 0) / 100;
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
        {editable && !editingNow && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-ink-muted">Each account’s plan by month, in whole dollars.</p>
            <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
              <Pencil className="h-4 w-4" aria-hidden="true" />
              Edit budget
            </Button>
          </div>
        )}
        {editingNow && (
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
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setRows(toRows(b));
                  setDirty(false);
                  setEditing(false);
                }}
              >
                {dirty ? 'Discard changes' : 'Done'}
              </Button>
              <Button size="sm" onClick={() => save.mutate()} disabled={!dirty} loading={save.isPending}>
                <Save className="h-4 w-4" aria-hidden="true" />
                Save budget
              </Button>
            </div>
          </div>
        )}
        {rows.length === 0 ? (
          <EmptyState title="An empty grid" description={editable ? 'Add an account above, or fill it from last year’s actuals.' : 'This budget has no lines.'} />
        ) : (
          <>
          {!editingNow && <PhoneLines groups={groups} label={label} rowTotal={rowTotal} netTotal={netTotal} />}
          {/* The account column and the year total stay put while the months scroll between them. */}
          <div className={cn('overflow-x-auto rounded-lg border border-line', !editingNow && 'hidden sm:block')}>
            <table className="min-w-max text-sm">
              <thead className="bg-surface-raised">
                <tr>
                  <th className="sticky left-0 z-10 min-w-48 bg-surface-raised px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-ink-muted lg:min-w-56">Account</th>
                  {MONTHS.map((m) => (
                    <th key={m} className="px-2 py-2 text-right text-xs font-medium uppercase tracking-wide text-ink-muted">
                      {m}
                    </th>
                  ))}
                  <th className="sticky right-0 z-10 bg-surface-raised px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-ink-muted shadow-[-1px_0_0_var(--color-line,rgba(255,255,255,0.08))]">Year</th>
                  {editingNow && <th className="px-2 py-2" aria-label="Remove" />}
                </tr>
              </thead>
              {groups.map((g) =>
                g.rows.length ? (
                  <tbody key={g.label} className="divide-y divide-line">
                    <tr>
                      <th colSpan={editingNow ? 15 : 14} className="sticky left-0 bg-surface px-3 pb-1 pt-3 text-left text-2xs font-semibold uppercase tracking-widest text-ink-muted">
                        {g.label}
                      </th>
                    </tr>
                    {g.rows.map((r) => (
                      <tr key={r.key}>
                        <th scope="row" className="sticky left-0 z-10 max-w-64 truncate bg-surface px-3 py-1.5 text-left font-normal text-ink" title={label(r)}>
                          {label(r)}
                          {(r.clientId || r.departmentId) && <span className="ml-1 text-xs text-ink-muted">(one {r.clientId ? 'client' : 'department'})</span>}
                        </th>
                        {r.months.map((m, i) => (
                          <td key={i} className="px-1 py-1">
                            {editingNow ? (
                              <AmountInput
                                aria-label={`${label(r)}, ${MONTHS[i]}`}
                                className="w-[5.5rem] rounded-md border border-line bg-surface px-2 py-1 text-right tabular-nums text-ink focus:border-gold focus:outline-none"
                                value={m}
                                onChange={(v) => edit(r.key, i, v)}
                              />
                            ) : (
                              <span className="block w-[5.5rem] px-2 text-right tabular-nums text-ink">{m ? money0(parseAmount(m)) : '—'}</span>
                            )}
                          </td>
                        ))}
                        <td className="sticky right-0 z-10 bg-surface px-3 py-1 text-right shadow-[-1px_0_0_var(--color-line,rgba(255,255,255,0.08))]">
                          {editingNow ? (
                            <AmountInput
                              aria-label={`${label(r)}, year total (spreads evenly)`}
                              title="Type a year total to spread it evenly"
                              className="w-28 rounded-md border border-line bg-surface-raised px-2 py-1 text-right font-medium tabular-nums text-ink focus:border-gold focus:outline-none"
                              value={rowTotal(r) ? String(rowTotal(r)) : ''}
                              onCommit={(v) => parseAmount(v) !== rowTotal(r) && spreadTotal(r.key, v)}
                            />
                          ) : (
                            <span className="font-medium tabular-nums text-ink">{money0(rowTotal(r))}</span>
                          )}
                        </td>
                        {editingNow && (
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
                      <td className="sticky right-0 bg-surface-raised px-3 py-1.5 text-right text-xs font-semibold tabular-nums text-ink">{money0(g.rows.reduce((s, r) => s + rowTotal(r), 0))}</td>
                      {editingNow && <td />}
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
                  <td className={cn('sticky right-0 bg-surface px-3 py-2 text-right font-semibold tabular-nums', netTotal < 0 ? 'text-alert' : 'text-ink')}>{money0(netTotal)}</td>
                  {editingNow && <td />}
                </tr>
              </tfoot>
            </table>
          </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Below sm the read-only grid is a list: each account with its year total,
 * and its twelve months in a 3-by-4 grid — every month readable without
 * scrolling sideways past a sticky column (one month showed at a time).
 */
function PhoneLines({ groups, label, rowTotal, netTotal }: { groups: Array<{ label: string; rows: GridRow[] }>; label: (r: GridRow) => string; rowTotal: (r: GridRow) => number; netTotal: number }) {
  return (
    <div className="space-y-4 sm:hidden" data-testid="budget-phone-lines">
      {groups.map((g) =>
        g.rows.length ? (
          <section key={g.label} aria-label={g.label} className="space-y-2">
            <h3 className="text-2xs font-semibold uppercase tracking-widest text-ink-muted">{g.label}</h3>
            <ul className="divide-y divide-line rounded-lg border border-line">
              {g.rows.map((r) => (
                <li key={r.key} className="space-y-2 px-3 py-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <span className="min-w-0 break-words text-sm text-ink">{label(r)}</span>
                    <span className="shrink-0 text-sm font-medium tabular-nums text-ink">{money0(rowTotal(r))}</span>
                  </div>
                  <dl className="grid grid-cols-4 gap-x-2 gap-y-1 text-2xs">
                    {r.months.map((m, i) => (
                      <div key={i} className="min-w-0">
                        <dt className="text-ink-muted">{MONTHS[i]}</dt>
                        <dd className="truncate tabular-nums text-ink">{m ? money0(parseAmount(m)) : '—'}</dd>
                      </div>
                    ))}
                  </dl>
                </li>
              ))}
            </ul>
          </section>
        ) : null,
      )}
      <p className={cn('flex justify-between border-t-2 border-ink/40 pt-2 text-sm font-semibold', netTotal < 0 ? 'text-alert' : 'text-ink')}>
        <span>Net for the year</span>
        <span className="tabular-nums">{money0(netTotal)}</span>
      </p>
    </div>
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
      {money0(c.variance)}
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
            <MetricStrip label="Net income against the budget">
              <MetricCard label="Net income, year to date" value={money0(r.netIncome.ytd.actual)} hint={`Budget ${money0(r.netIncome.ytd.budget)}`} tone={r.netIncome.ytd.variance < 0 ? 'warning' : 'default'} />
              <MetricCard label="Forecast to year end" value={money0(r.netIncome.forecast)} hint="Actual so far + the budget left" tone="neutral" />
              <MetricCard label="At the current pace" value={money0(r.netIncome.runRate)} hint={`Annual budget ${money0(r.netIncome.annualBudget)}`} tone="neutral" />
            </MetricStrip>
            <BudgetCharts report={r} />
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
      <table className="w-full min-w-[48rem] text-sm">
        <thead className="bg-surface-raised">
          <tr>
            <th className="sticky left-0 z-10 bg-surface-raised px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-ink-muted">Account</th>
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
                <td className="px-3 py-1.5 text-right tabular-nums text-ink">{money0(s.ytd.budget)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-ink">{money0(s.ytd.actual)}</td>
                <td className="px-3 py-1.5 text-right">
                  <VarianceCell c={s.ytd} income={income} />
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums text-ink">{money0(s.annualBudget)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-ink">{money0(s.forecast)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-ink">{money0(s.runRate)}</td>
              </tr>
            </tbody>
          );
        })}
        <tfoot>
          <tr className="border-t-2 border-ink/40 font-semibold">
            <th scope="row" className="px-3 py-2 text-left text-ink">
              Net income
            </th>
            <td className="px-3 py-2 text-right tabular-nums text-ink">{money0(r.netIncome.ytd.budget)}</td>
            <td className="px-3 py-2 text-right tabular-nums text-ink">{money0(r.netIncome.ytd.actual)}</td>
            <td className="px-3 py-2 text-right">
              <VarianceCell c={r.netIncome.ytd} income />
            </td>
            <td className="px-3 py-2 text-right tabular-nums text-ink">{money0(r.netIncome.annualBudget)}</td>
            <td className="px-3 py-2 text-right tabular-nums text-ink">{money0(r.netIncome.forecast)}</td>
            <td className="px-3 py-2 text-right tabular-nums text-ink">{money0(r.netIncome.runRate)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function AccountRow({ row, income }: { row: BudgetVsActualRow; income: boolean }) {
  return (
    <tr>
      <th scope="row" className="sticky left-0 z-10 max-w-48 bg-surface px-3 py-1.5 text-left font-normal sm:max-w-none">
        <Link to={`/books/accounts/${row.accountId}`} className="text-ink hover:text-gold hover:underline">
          <span className="tabular-nums text-ink-muted">{row.code}</span> {row.name}
        </Link>
      </th>
      <td className="px-3 py-1.5 text-right tabular-nums text-ink-muted">{money0(row.ytd.budget)}</td>
      <td className="px-3 py-1.5 text-right tabular-nums text-ink">{money0(row.ytd.actual)}</td>
      <td className="px-3 py-1.5 text-right">
        <VarianceCell c={row.ytd} income={income} />
      </td>
      <td className="px-3 py-1.5 text-right tabular-nums text-ink-muted">{money0(row.annualBudget)}</td>
      <td className="px-3 py-1.5 text-right tabular-nums text-ink">{money0(row.forecast)}</td>
      <td className="px-3 py-1.5 text-right tabular-nums text-ink-muted">{money0(row.runRate)}</td>
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
            <th className="sticky left-0 z-10 min-w-36 bg-surface-raised px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-ink-muted sm:min-w-56">Account</th>
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
