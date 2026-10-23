import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, CircleAlert, CircleCheck, Download } from 'lucide-react';
import type { BooksCompareKind, BooksDimensionsFilter, BooksPnlSections, BooksPnlTotals, BooksProfitAndLoss, BooksReportRow } from '@alto-people/shared';
import { downloadReport, getBalanceSheet, getCashFlow, getProfitAndLoss, getTrialBalance, type ReportKind, type ReportParams } from '@/lib/books/ledgerApi';
import { fmtDate, fmtDateOnlyRange, fmtMoney, ymdLocal } from '@/lib/format';
import { useUrlWriter } from '@/lib/useUrlState';
import { useMinWidth } from '@/lib/useViewport';
import { ListTemplate } from '@/components/templates';
import { Card, CardContent } from '@/components/ui/Card';
import { FilterBar } from '@/components/ui/FilterBar';
import { Input } from '@/components/ui/Input';
import { QueryError } from '@/components/ui/QueryError';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { toast } from '@/components/ui/Toaster';
import { cn } from '@/lib/cn';
import { Amount, DimensionFilters, dimsQuery, monthEnd, yearStart } from '../ledger/ledgerKit';
import { PnlMonthBars, PnlWaterfall } from './PnlCharts';

/**
 * The financial statements: profit and loss (by month or by client beside
 * the total), balance sheet, cash flow and trial balance — for the whole
 * company or a client, site or department — with every amount opening the
 * account's entries for the same range, each statement beside the period
 * (or year) before it, and each as a PDF or a workbook.
 *
 * The statement tabs come first, then one filter row: the period (a preset
 * or dates), the part of the company, and the comparison. On a phone the
 * period stays in view and the rest fold into a sheet.
 */

const TABS: Array<{ key: ReportKind; label: string }> = [
  { key: 'profit-and-loss', label: 'Profit and loss' },
  { key: 'balance-sheet', label: 'Balance sheet' },
  { key: 'cash-flow', label: 'Cash flow' },
  { key: 'trial-balance', label: 'Trial balance' },
];

const FILTER_KEYS = ['from', 'to', 'asOf', 'clientId', 'siteId', 'departmentId', 'columns', 'compare'] as const;

/** A period preset and the dates it means today. */
interface Preset {
  key: string;
  label: string;
  from: string;
  to: string;
}
const ymdOf = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** This month, last month, quarter to date, year to date, last year — as of `today`. */
export function periodPresets(today: string): Preset[] {
  const [y, m] = today.split('-').map(Number) as [number, number];
  const [ly, lm] = m === 1 ? [y - 1, 12] : [y, m - 1];
  const q = Math.floor((m - 1) / 3) * 3 + 1;
  return [
    { key: 'month', label: 'This month', from: ymdOf(y, m, 1), to: monthEnd(today) },
    { key: 'last-month', label: 'Last month', from: ymdOf(ly, lm, 1), to: ymdOf(ly, lm, lastDay(ly, lm)) },
    { key: 'qtd', label: 'Quarter to date', from: ymdOf(y, q, 1), to: today },
    { key: 'ytd', label: 'Year to date', from: yearStart(today), to: today },
    { key: 'last-year', label: 'Last year', from: ymdOf(y - 1, 1, 1), to: ymdOf(y - 1, 12, 31) },
  ];
}

/** Today, and the ends of last month, last quarter and last year — for the point-in-time statements. */
export function asOfPresets(today: string): Array<{ key: string; label: string; asOf: string }> {
  const [y, m] = today.split('-').map(Number) as [number, number];
  const [ly, lm] = m === 1 ? [y - 1, 12] : [y, m - 1];
  const qEndMonth = Math.floor((m - 1) / 3) * 3; // the month before this quarter began (0 = last December)
  const [qy, qm] = qEndMonth === 0 ? [y - 1, 12] : [y, qEndMonth];
  return [
    { key: 'today', label: 'Today', asOf: today },
    { key: 'month-end', label: 'End of last month', asOf: ymdOf(ly, lm, lastDay(ly, lm)) },
    { key: 'quarter-end', label: 'End of last quarter', asOf: ymdOf(qy, qm, lastDay(qy, qm)) },
    { key: 'year-end', label: 'End of last year', asOf: ymdOf(y - 1, 12, 31) },
  ];
}

const COMPARE_LABEL: Record<BooksCompareKind, string> = { prior: 'Previous period', yoy: 'Same period last year' };

export function BooksReportsPage() {
  const [params] = useSearchParams();
  const write = useUrlWriter();
  const tab = (TABS.find((t) => t.key === params.get('report'))?.key ?? 'profit-and-loss') as ReportKind;
  const today = ymdLocal();
  const from = params.get('from') ?? yearStart(today);
  const to = params.get('to') ?? today;
  const asOf = params.get('asOf') ?? today;
  const columnsParam = params.get('columns');
  const columns: NonNullable<ReportParams['columns']> = columnsParam === 'month' || columnsParam === 'client' ? columnsParam : 'none';
  const compareParam = params.get('compare');
  const compare: BooksCompareKind | undefined = compareParam === 'prior' || compareParam === 'yoy' ? compareParam : undefined;
  const dims: BooksDimensionsFilter = {
    clientId: params.get('clientId') ?? undefined,
    siteId: params.get('siteId') ?? undefined,
    departmentId: params.get('departmentId') ?? undefined,
  };
  const set = (patch: Record<string, string | undefined>, history: 'push' | 'replace' = 'replace') =>
    write((p) => {
      for (const [k, v] of Object.entries(patch)) {
        if (v) p.set(k, v);
        else p.delete(k);
      }
    }, { history });
  const pointInTime = tab === 'balance-sheet' || tab === 'trial-balance';
  // Split columns are their own comparison; the trial balance is a check, not a comparison.
  const canCompare = tab !== 'trial-balance' && !(tab === 'profit-and-loss' && columns !== 'none');
  const reportParams: ReportParams = {
    ...dims,
    ...(pointInTime ? { asOf } : { from, to }),
    ...(tab === 'profit-and-loss' ? { columns } : {}),
    ...(canCompare && compare ? { compare } : {}),
  };
  const [downloading, setDownloading] = useState(false);
  const download = async (format: 'pdf' | 'xlsx') => {
    setDownloading(true);
    try {
      await downloadReport(tab, format, reportParams);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'The download failed.');
    } finally {
      setDownloading(false);
    }
  };

  const presets = periodPresets(today);
  const preset = presets.find((p) => p.from === from && p.to === to)?.key ?? 'custom';
  const pointPresets = asOfPresets(today);
  const pointPreset = pointPresets.find((p) => p.asOf === asOf)?.key ?? 'custom';
  // The period leads the filter row; on a phone it stays in view (full width) and the rest fold into the sheet.
  const roomy = useMinWidth(768);
  const periodPicker = pointInTime ? (
    <Select
      size="sm"
      aria-label="As of"
      value={pointPreset}
      onChange={(e) => {
        const p = pointPresets.find((x) => x.key === e.target.value);
        if (p) set({ asOf: p.key === 'today' ? undefined : p.asOf });
      }}
      className={roomy ? 'w-auto' : undefined}
    >
      {pointPresets.map((p) => (
        <option key={p.key} value={p.key}>
          {p.label}
        </option>
      ))}
      {pointPreset === 'custom' && <option value="custom">As of {fmtDate(asOf)}</option>}
    </Select>
  ) : (
    <Select
      size="sm"
      aria-label="Period"
      value={preset}
      onChange={(e) => {
        const p = presets.find((x) => x.key === e.target.value);
        if (p) set({ from: p.key === 'ytd' ? undefined : p.from, to: p.key === 'ytd' ? undefined : p.to });
      }}
      className={roomy ? 'w-auto' : undefined}
    >
      {presets.map((p) => (
        <option key={p.key} value={p.key}>
          {p.label}
        </option>
      ))}
      {preset === 'custom' && <option value="custom">{fmtDateOnlyRange(from, to)}</option>}
    </Select>
  );

  return (
    <ListTemplate
      title="Financial statements"
      subtitle="Accrual basis, straight from the books. Every amount opens the entries behind it."
      actions={[
        { key: 'pdf', label: 'Download PDF', icon: Download, loading: downloading, onSelect: () => void download('pdf') },
        { key: 'xlsx', label: 'Download Excel', icon: Download, loading: downloading, onSelect: () => void download('xlsx') },
      ]}
    >
      <Tabs value={tab} onValueChange={(v) => set({ report: v === 'profit-and-loss' ? undefined : v }, 'push')}>
        <TabsList>
          {TABS.map((t) => (
            <TabsTrigger key={t.key} value={t.key}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <FilterBar urlKey={FILTER_KEYS.filter((k) => k !== 'from' && k !== 'to' && k !== 'asOf')} search={roomy ? undefined : periodPicker} sheetDescription="The dates, the part of the company, and what to compare with.">
        {roomy && periodPicker}
        {pointInTime ? (
          <label className="flex items-center gap-1.5 text-xs text-ink-muted">
            As of
            <Input size="sm" type="date" value={asOf} onChange={(e) => set({ asOf: e.target.value || undefined })} aria-label="As of date" className="w-auto" />
          </label>
        ) : (
          <>
            <label className="flex items-center gap-1.5 text-xs text-ink-muted">
              From
              <Input size="sm" type="date" value={from} max={to} onChange={(e) => set({ from: e.target.value || undefined })} aria-label="From" className="w-auto" />
            </label>
            <label className="flex items-center gap-1.5 text-xs text-ink-muted">
              To
              <Input size="sm" type="date" value={to} min={from} onChange={(e) => set({ to: e.target.value || undefined })} aria-label="To" className="w-auto" />
            </label>
          </>
        )}
        <DimensionFilters compact value={dims} onChange={(d) => set({ clientId: d.clientId, siteId: d.siteId, departmentId: d.departmentId })} />
        {tab === 'profit-and-loss' && (
          <SegmentedControl<'none' | 'month' | 'client'>
            ariaLabel="Columns"
            value={columns}
            onChange={(v) => set({ columns: v === 'none' ? undefined : v })}
            options={[
              { value: 'none', label: 'Total' },
              { value: 'month', label: 'By month' },
              { value: 'client', label: 'By client' },
            ]}
          />
        )}
        {canCompare && (
          <Select size="sm" aria-label="Compare with" value={compare ?? ''} onChange={(e) => set({ compare: e.target.value || undefined })} className="w-auto">
            <option value="">No comparison</option>
            <option value="prior">Compare: {COMPARE_LABEL.prior.toLowerCase()}</option>
            <option value="yoy">Compare: {COMPARE_LABEL.yoy.toLowerCase()}</option>
          </Select>
        )}
      </FilterBar>
      {tab === 'profit-and-loss' && <ProfitAndLossView p={reportParams} />}
      {tab === 'balance-sheet' && <BalanceSheetView p={reportParams} />}
      {tab === 'cash-flow' && <CashFlowView p={reportParams} />}
      {tab === 'trial-balance' && <TrialBalanceView p={reportParams} />}
    </ListTemplate>
  );
}

/** A link to an account's entries for the report's range and filter. */
function useDetailLink(p: ReportParams) {
  const dims = dimsQuery({ clientId: p.clientId, siteId: p.siteId, departmentId: p.departmentId });
  return (accountId: string) => {
    if (accountId.length !== 36) return null;
    const range = p.asOf ? `from=${p.asOf.slice(0, 4)}-01-01&to=${p.asOf}` : `from=${p.from}&to=${p.to}`;
    return `/books/accounts/${accountId}?${range}${dims}`;
  };
}

/** The comparison beside a statement: the two column headings. */
interface Comparison {
  /** This statement's own column ("Sep 1 – 30, 2026"). */
  current: string;
  /** What the comparison column covers ("Aug 1 – 31, 2026"). */
  label: string;
}

const signedChange = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmtMoney(Math.abs(v))}`;

const rowGrid = (compared: boolean) =>
  compared ? 'grid grid-cols-[minmax(0,1fr)_5.75rem_5.75rem] items-baseline gap-2 sm:grid-cols-[minmax(0,1fr)_8rem_8rem_8rem]' : 'grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-2';

/** The heading over a statement with a comparison: the two columns and the change. */
function CompareHeading({ c }: { c: Comparison }) {
  return (
    <div className={cn('border-b border-line pb-2 pl-3 pr-2 text-right text-2xs uppercase tracking-wider text-ink-muted sm:pl-6', rowGrid(true))} aria-hidden="true">
      <span />
      <span className="break-words">{c.current}</span>
      <span className="break-words">{c.label}</span>
      <span className="hidden sm:block">Change</span>
    </div>
  );
}

/** One row's amounts: this period, and with a comparison, the other period and the change (from sm up). */
function Cells({ value, compared, link, strong }: { value: number; compared?: number; link?: string | null; strong?: boolean }) {
  const amount = link ? (
    <Link to={link} className="hover:underline">
      <Amount value={value} strong={strong} />
    </Link>
  ) : (
    <Amount value={value} strong={strong} />
  );
  if (compared === undefined) return <span className="text-right">{amount}</span>;
  return (
    <>
      <span className="text-right">{amount}</span>
      <span className="text-right">
        <Amount value={compared} strong={strong} />
      </span>
      <span className="hidden text-right tabular-nums text-ink-muted sm:block">{signedChange(value - compared)}</span>
    </>
  );
}

function Section({
  title,
  rows,
  total,
  totalLabel,
  link,
  compared,
  defaultOpen = true,
}: {
  title: string;
  rows: BooksReportRow[];
  total: number;
  totalLabel: string;
  link: (id: string) => string | null;
  /** The same section in the comparison range. */
  compared?: { rows: BooksReportRow[]; total: number };
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  // With a comparison, an account that only moved in the other range still gets its line (at zero here).
  const shown = compared ? [...rows, ...compared.rows.filter((c) => !rows.some((r) => r.accountId === c.accountId)).map((c) => ({ ...c, amount: 0 }))] : rows;
  const before = (id: string) => compared?.rows.find((c) => c.accountId === id)?.amount ?? 0;
  return (
    <div className="border-b border-line last:border-b-0">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className={cn('w-full py-3 pr-2 text-left text-sm font-semibold text-ink', rowGrid(!!compared))}>
        <span className="flex items-center gap-2">
          {open ? <ChevronDown className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden="true" /> : <ChevronRight className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden="true" />}
          {title}
        </span>
        {!open && <Cells value={total} compared={compared?.total} />}
      </button>
      {open && (
        <div className="pb-1 text-sm">
          {shown.length === 0 && <p className="py-1.5 pl-3 text-ink-muted sm:pl-6">None in this range.</p>}
          {shown.map((r) => (
            <div key={r.accountId + r.name} className={cn('py-1.5 pl-3 pr-2 hover:bg-surface-raised/60 sm:pl-6', rowGrid(!!compared))}>
              <span className="min-w-0 break-words">
                {r.code && r.code !== '—' && <span className="mr-2 tabular-nums text-ink-muted">{r.code}</span>}
                <span className="text-ink">{r.name}</span>
              </span>
              <Cells value={r.amount} compared={compared ? before(r.accountId) : undefined} link={link(r.accountId)} />
            </div>
          ))}
          <div className={cn('border-t border-line py-2 pl-3 pr-2 sm:pl-6', rowGrid(!!compared))}>
            <span className="font-medium text-ink">{totalLabel}</span>
            <Cells value={total} compared={compared?.total} strong />
          </div>
        </div>
      )}
    </div>
  );
}

function Line({ label, value, compared, emphasis }: { label: string; value: number; compared?: number; emphasis?: boolean }) {
  return (
    <div className={cn('border-b border-line py-3 pr-2 text-sm', rowGrid(compared !== undefined), emphasis && 'border-b-0 border-t-2 border-t-ink/60 text-base')}>
      <span className={cn('font-semibold text-ink', emphasis && 'text-lg')}>{label}</span>
      {compared === undefined ? (
        <span className="text-right">
          <Amount value={value} strong className={emphasis ? 'text-lg' : undefined} />
        </span>
      ) : (
        <Cells value={value} compared={compared} strong />
      )}
    </div>
  );
}

function Loading() {
  return <Skeleton className="h-96" />;
}

/** "Sep 1 – 30, 2026" for a range, "As of Sep 30, 2026" for a date. */
const rangeLabel = (from: string, to: string) => fmtDateOnlyRange(from, to);
const asOfLabel = (asOf: string) => `As of ${fmtDate(asOf)}`;

function ProfitAndLossView({ p }: { p: ReportParams }) {
  const q = useQuery({ queryKey: ['books', 'report', 'pnl', p], queryFn: () => getProfitAndLoss(p) });
  const link = useDetailLink(p);
  if (q.isError) return <QueryError what="the profit and loss" query={q} />;
  if (!q.data) return <Loading />;
  const r = q.data;
  const c = r.compare ?? null;
  return (
    <div className="space-y-[var(--d-stack)]">
      <div className={cn('grid gap-[var(--d-stack)]', p.columns === 'month' && r.columns.length > 1 && 'xl:grid-cols-2')}>
        <PnlWaterfall totals={r.totals} />
        {p.columns === 'month' && r.columns.length > 1 && <PnlMonthBars r={r} />}
      </div>
      <Card>
        <CardContent className="p-4 md:p-6">
          {c ? <CompareHeading c={{ current: rangeLabel(r.from, r.to), label: rangeLabel(c.from, c.to) }} /> : <p className="mb-2 text-xs text-ink-muted">{rangeLabel(r.from, r.to)}</p>}
          <PnlBody sections={r.sections} totals={r.totals} link={link} compare={c ? { sections: c.sections, totals: c.totals } : undefined} />
        </CardContent>
      </Card>
      {r.columns.length > 0 && <PnlColumns r={r} />}
    </div>
  );
}

function PnlBody({ sections, totals, link, compare }: { sections: BooksPnlSections; totals: BooksPnlTotals; link: (id: string) => string | null; compare?: { sections: BooksPnlSections; totals: BooksPnlTotals } }) {
  const cs = compare?.sections;
  const ct = compare?.totals;
  const other = (k: keyof BooksPnlSections, t: keyof BooksPnlTotals) => (cs && ct ? { rows: cs[k], total: ct[t] as number } : undefined);
  return (
    <>
      <Section title="Income" rows={sections.income} total={totals.income} totalLabel="Total income" link={link} compared={other('income', 'income')} />
      <Section title="Cost of services" rows={sections.costOfServices} total={totals.costOfServices} totalLabel="Total cost of services" link={link} compared={other('costOfServices', 'costOfServices')} />
      <Line label={`Gross profit${totals.grossMarginPct == null ? '' : ` · ${totals.grossMarginPct}%`}`} value={totals.grossProfit} compared={ct?.grossProfit} />
      <Section title="Operating expenses" rows={sections.expenses} total={totals.expenses} totalLabel="Total operating expenses" link={link} compared={other('expenses', 'expenses')} />
      <Line label="Operating income" value={totals.operatingIncome} compared={ct?.operatingIncome} />
      {(sections.otherIncome.length > 0 || (cs?.otherIncome.length ?? 0) > 0) && <Section title="Other income" rows={sections.otherIncome} total={totals.otherIncome} totalLabel="Total other income" link={link} compared={other('otherIncome', 'otherIncome')} />}
      {(sections.otherExpenses.length > 0 || (cs?.otherExpenses.length ?? 0) > 0) && <Section title="Other expenses" rows={sections.otherExpenses} total={totals.otherExpenses} totalLabel="Total other expenses" link={link} compared={other('otherExpenses', 'otherExpenses')} />}
      <Line label="Net income" value={totals.netIncome} compared={ct?.netIncome} emphasis />
    </>
  );
}

const PNL_LINES: Array<{ key: keyof BooksPnlTotals; label: string; strong?: boolean }> = [
  { key: 'income', label: 'Income' },
  { key: 'costOfServices', label: 'Cost of services' },
  { key: 'grossProfit', label: 'Gross profit', strong: true },
  { key: 'expenses', label: 'Operating expenses' },
  { key: 'operatingIncome', label: 'Operating income', strong: true },
  { key: 'netIncome', label: 'Net income', strong: true },
];

function PnlColumns({ r }: { r: BooksProfitAndLoss }) {
  return (
    <Card>
      <CardContent className="overflow-x-auto p-4">
        <table className="w-full min-w-[40rem] text-sm">
          <caption className="sr-only">Profit and loss by column</caption>
          <thead>
            <tr className="border-b border-line text-left text-xs text-ink-muted">
              <th className="py-2 pr-4 font-medium" scope="col">
                &nbsp;
              </th>
              {r.columns.map((c) => (
                <th key={c.key} className="py-2 pl-4 text-right font-medium" scope="col">
                  {c.label}
                </th>
              ))}
              <th className="py-2 pl-4 text-right font-medium" scope="col">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {PNL_LINES.map((l) => (
              <tr key={l.key} className={cn('border-b border-line', l.strong && 'font-semibold')}>
                <th scope="row" className="py-2 pr-4 text-left font-medium text-ink">
                  {l.label}
                </th>
                {r.columns.map((c) => (
                  <td key={c.key} className="py-2 pl-4 text-right">
                    <Amount value={c.totals[l.key] as number} strong={l.strong} />
                  </td>
                ))}
                <td className="py-2 pl-4 text-right">
                  <Amount value={r.totals[l.key] as number} strong />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

function Check({ ok, good, bad }: { ok: boolean; good: string; bad: string }) {
  return (
    <p className={cn('flex items-center gap-2 text-sm', ok ? 'text-success' : 'text-alert')}>
      {ok ? <CircleCheck className="h-4 w-4" aria-hidden="true" /> : <CircleAlert className="h-4 w-4" aria-hidden="true" />}
      {ok ? good : bad}
    </p>
  );
}

function BalanceSheetView({ p }: { p: ReportParams }) {
  const q = useQuery({ queryKey: ['books', 'report', 'bs', p], queryFn: () => getBalanceSheet(p) });
  const link = useDetailLink(p);
  if (q.isError) return <QueryError what="the balance sheet" query={q} />;
  if (!q.data) return <Loading />;
  const r = q.data;
  const c = r.compare ?? null;
  return (
    <Card>
      <CardContent className="p-4 md:p-6">
        {c ? <CompareHeading c={{ current: asOfLabel(r.asOf), label: asOfLabel(c.asOf) }} /> : <p className="mb-2 text-xs text-ink-muted">{asOfLabel(r.asOf)}</p>}
        <Section title="Assets" rows={r.assets} total={r.totals.assets} totalLabel="Total assets" link={link} compared={c ? { rows: c.assets, total: c.totals.assets } : undefined} />
        <Section title="Liabilities" rows={r.liabilities} total={r.totals.liabilities} totalLabel="Total liabilities" link={link} compared={c ? { rows: c.liabilities, total: c.totals.liabilities } : undefined} />
        <Section title="Equity" rows={r.equity} total={r.totals.equity} totalLabel="Total equity" link={link} compared={c ? { rows: c.equity, total: c.totals.equity } : undefined} />
        <Line label="Total liabilities and equity" value={r.totals.liabilitiesAndEquity} compared={c?.totals.liabilitiesAndEquity} emphasis />
        <Check ok={r.totals.balanced} good="Assets equal liabilities and equity." bad={`Out of balance by ${fmtMoney(Math.abs(r.totals.assets - r.totals.liabilitiesAndEquity))}.`} />
      </CardContent>
    </Card>
  );
}

function CashFlowView({ p }: { p: ReportParams }) {
  const q = useQuery({ queryKey: ['books', 'report', 'cf', p], queryFn: () => getCashFlow(p) });
  const link = useDetailLink(p);
  if (q.isError) return <QueryError what="the cash flow" query={q} />;
  if (!q.data) return <Loading />;
  const r = q.data;
  const c = r.compare ?? null;
  const netIncomeRow = (amount: number): BooksReportRow => ({ accountId: 'net-income', code: '', name: 'Net income', type: '', subtype: '', amount });
  const ops: BooksReportRow[] = [netIncomeRow(r.netIncome), ...r.operating];
  return (
    <Card>
      <CardContent className="p-4 md:p-6">
        {c ? <CompareHeading c={{ current: rangeLabel(r.from, r.to), label: rangeLabel(c.from, c.to) }} /> : <p className="mb-2 text-xs text-ink-muted">{rangeLabel(r.from, r.to)}</p>}
        <Section title="Operating activities" rows={ops} total={r.totals.operating} totalLabel="Cash from operations" link={link} compared={c ? { rows: [netIncomeRow(c.netIncome), ...c.operating], total: c.totals.operating } : undefined} />
        <Section title="Investing activities" rows={r.investing} total={r.totals.investing} totalLabel="Cash from investing" link={link} compared={c ? { rows: c.investing, total: c.totals.investing } : undefined} />
        <Section title="Financing activities" rows={r.financing} total={r.totals.financing} totalLabel="Cash from financing" link={link} compared={c ? { rows: c.financing, total: c.totals.financing } : undefined} />
        <Line label="Net change in cash" value={r.totals.netChange} compared={c?.totals.netChange} emphasis />
        <Check ok={r.totals.reconciles} good={`Ties out to the bank accounts (${fmtMoney(r.totals.cashChange)}).`} bad={`The bank accounts changed by ${fmtMoney(r.totals.cashChange)} — the statement doesn’t tie out.`} />
      </CardContent>
    </Card>
  );
}

function TrialBalanceView({ p }: { p: ReportParams }) {
  const q = useQuery({ queryKey: ['books', 'report', 'tb', p], queryFn: () => getTrialBalance(p) });
  const link = useDetailLink(p);
  if (q.isError) return <QueryError what="the trial balance" query={q} />;
  if (!q.data) return <Loading />;
  const r = q.data;
  return (
    <Card>
      <CardContent className="overflow-x-auto p-4 md:p-6">
        <table className="w-full text-sm">
          <caption className="sr-only">Trial balance as of {r.asOf}</caption>
          <thead>
            <tr className="border-b border-line text-left text-xs text-ink-muted">
              <th className="py-2 font-medium" scope="col">
                Account
              </th>
              <th className="py-2 text-right font-medium" scope="col">
                Debit
              </th>
              <th className="py-2 text-right font-medium" scope="col">
                Credit
              </th>
            </tr>
          </thead>
          <tbody>
            {r.rows.map((x) => (
              <tr key={x.accountId} className="border-b border-line hover:bg-surface-raised/60">
                <td className="py-1.5">
                  <Link to={link(x.accountId) ?? '#'} className="hover:underline">
                    <span className="mr-2 tabular-nums text-ink-muted">{x.code}</span>
                    <span className="text-ink">{x.name}</span>
                  </Link>
                </td>
                <td className="py-1.5 text-right">
                  <Amount value={x.debit} blankZero />
                </td>
                <td className="py-1.5 text-right">
                  <Amount value={x.credit} blankZero />
                </td>
              </tr>
            ))}
            <tr>
              <th scope="row" className="py-2 text-left font-semibold text-ink">
                Total
              </th>
              <td className="py-2 text-right">
                <Amount value={r.totals.debit} strong />
              </td>
              <td className="py-2 text-right">
                <Amount value={r.totals.credit} strong />
              </td>
            </tr>
          </tbody>
        </table>
        <div className="mt-3">
          <Check ok={r.totals.balanced} good="Debits equal credits." bad="Debits and credits don’t match." />
        </div>
      </CardContent>
    </Card>
  );
}
