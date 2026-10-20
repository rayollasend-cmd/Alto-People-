import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, CircleAlert, CircleCheck, Download } from 'lucide-react';
import type { BooksDimensionsFilter, BooksPnlSections, BooksPnlTotals, BooksProfitAndLoss, BooksReportRow } from '@alto-people/shared';
import { downloadReport, getBalanceSheet, getCashFlow, getProfitAndLoss, getTrialBalance, type ReportKind, type ReportParams } from '@/lib/books/ledgerApi';
import { fmtDate, fmtMoney, ymdLocal } from '@/lib/format';
import { ListTemplate } from '@/components/templates';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/DropdownMenu';
import { Input } from '@/components/ui/Input';
import { QueryError } from '@/components/ui/QueryError';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Skeleton } from '@/components/ui/Skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { toast } from '@/components/ui/Toaster';
import { cn } from '@/lib/cn';
import { Amount, DimensionFilters, dimsQuery, yearStart } from '../ledger/ledgerKit';

/**
 * The financial statements: profit and loss (by month or by client beside
 * the total), balance sheet, cash flow and trial balance — for the whole
 * company or a client, site or department — with every amount opening the
 * account's entries for the same range, and each statement as a PDF or a
 * workbook.
 */

const TABS: Array<{ key: ReportKind; label: string }> = [
  { key: 'profit-and-loss', label: 'Profit and loss' },
  { key: 'balance-sheet', label: 'Balance sheet' },
  { key: 'cash-flow', label: 'Cash flow' },
  { key: 'trial-balance', label: 'Trial balance' },
];

export function BooksReportsPage() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((t) => t.key === params.get('report'))?.key ?? 'profit-and-loss') as ReportKind;
  const today = ymdLocal();
  const from = params.get('from') ?? yearStart(today);
  const to = params.get('to') ?? today;
  const asOf = params.get('asOf') ?? today;
  const columns = (params.get('columns') as ReportParams['columns']) ?? 'none';
  const dims: BooksDimensionsFilter = {
    clientId: params.get('clientId') ?? undefined,
    siteId: params.get('siteId') ?? undefined,
    departmentId: params.get('departmentId') ?? undefined,
  };
  const set = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };
  const pointInTime = tab === 'balance-sheet' || tab === 'trial-balance';
  const reportParams: ReportParams = { ...dims, ...(pointInTime ? { asOf } : { from, to }), ...(tab === 'profit-and-loss' ? { columns } : {}) };
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

  return (
    <ListTemplate
      title="Financial statements"
      subtitle="Accrual basis, straight from the books. Every amount opens the entries behind it."
      breadcrumbs={[{ label: 'Books', to: '/books' }, { label: 'Financial statements' }]}
      primaryAction={
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="secondary" loading={downloading}>
              <Download className="h-4 w-4" aria-hidden="true" />
              Download
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => void download('pdf')}>PDF</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void download('xlsx')}>Excel workbook</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      }
      filters={
        <Card>
          <CardContent className="flex flex-wrap items-end gap-3 p-3">
            {pointInTime ? (
              <label className="flex flex-col gap-1 text-xs text-ink-muted">
                As of
                <Input type="date" value={asOf} onChange={(e) => set({ asOf: e.target.value })} aria-label="As of" />
              </label>
            ) : (
              <>
                <label className="flex flex-col gap-1 text-xs text-ink-muted">
                  From
                  <Input type="date" value={from} max={to} onChange={(e) => set({ from: e.target.value })} aria-label="From" />
                </label>
                <label className="flex flex-col gap-1 text-xs text-ink-muted">
                  To
                  <Input type="date" value={to} min={from} onChange={(e) => set({ to: e.target.value })} aria-label="To" />
                </label>
              </>
            )}
            <DimensionFilters value={dims} onChange={(d) => set({ clientId: d.clientId, siteId: d.siteId, departmentId: d.departmentId })} />
            {tab === 'profit-and-loss' && (
              <div className="flex flex-col gap-1 text-xs text-ink-muted">
                Columns
                <SegmentedControl<'none' | 'month' | 'client'>
                  ariaLabel="Columns"
                  value={columns ?? 'none'}
                  onChange={(v) => set({ columns: v === 'none' ? undefined : v })}
                  options={[
                    { value: 'none', label: 'Total' },
                    { value: 'month', label: 'By month' },
                    { value: 'client', label: 'By client' },
                  ]}
                />
              </div>
            )}
          </CardContent>
        </Card>
      }
    >
      <Tabs value={tab} onValueChange={(v) => set({ report: v === 'profit-and-loss' ? undefined : v })}>
        <TabsList>
          {TABS.map((t) => (
            <TabsTrigger key={t.key} value={t.key}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
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

function Section({ title, rows, total, totalLabel, link, defaultOpen = true }: { title: string; rows: BooksReportRow[]; total: number; totalLabel: string; link: (id: string) => string | null; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-line last:border-b-0">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-2 py-3 text-left text-sm font-semibold text-ink">
        {open ? <ChevronDown className="h-4 w-4 text-ink-muted" aria-hidden="true" /> : <ChevronRight className="h-4 w-4 text-ink-muted" aria-hidden="true" />}
        <span className="flex-1">{title}</span>
        {!open && <Amount value={total} />}
      </button>
      {open && (
        <table className="w-full text-sm">
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td className="py-1.5 pl-6 text-ink-muted" colSpan={2}>
                  None in this range.
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const to = link(r.accountId);
              return (
                <tr key={r.accountId + r.name} className="hover:bg-surface-raised/60">
                  <td className="py-1.5 pl-6">
                    {r.code && r.code !== '—' && <span className="mr-2 tabular-nums text-ink-muted">{r.code}</span>}
                    <span className="text-ink">{r.name}</span>
                  </td>
                  <td className="py-1.5 pr-2 text-right">
                    {to ? (
                      <Link to={to} className="hover:underline">
                        <Amount value={r.amount} />
                      </Link>
                    ) : (
                      <Amount value={r.amount} />
                    )}
                  </td>
                </tr>
              );
            })}
            <tr className="border-t border-line">
              <td className="py-2 pl-6 font-medium text-ink">{totalLabel}</td>
              <td className="py-2 pr-2 text-right">
                <Amount value={total} strong />
              </td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  );
}

function Line({ label, value, emphasis }: { label: string; value: number; emphasis?: boolean }) {
  return (
    <div className={cn('flex items-center justify-between border-b border-line py-3 text-sm', emphasis && 'border-b-0 border-t-2 border-t-ink/60 text-base')}>
      <span className={cn('font-semibold text-ink', emphasis && 'text-lg')}>{label}</span>
      <Amount value={value} strong className={emphasis ? 'text-lg' : undefined} />
    </div>
  );
}

function Loading() {
  return <Skeleton className="h-96" />;
}

function ProfitAndLossView({ p }: { p: ReportParams }) {
  const q = useQuery({ queryKey: ['books', 'report', 'pnl', p], queryFn: () => getProfitAndLoss(p) });
  const link = useDetailLink(p);
  if (q.isError) return <QueryError what="the profit and loss" query={q} />;
  if (!q.data) return <Loading />;
  const r = q.data;
  return (
    <div className="space-y-[var(--d-stack)]">
      <Card>
        <CardContent className="p-4 md:p-6">
          <p className="mb-2 text-xs text-ink-muted">{`${fmtDate(r.from)} – ${fmtDate(r.to)}`}</p>
          <PnlBody sections={r.sections} totals={r.totals} link={link} />
        </CardContent>
      </Card>
      {r.columns.length > 0 && <PnlColumns r={r} />}
    </div>
  );
}

function PnlBody({ sections, totals, link }: { sections: BooksPnlSections; totals: BooksPnlTotals; link: (id: string) => string | null }) {
  return (
    <>
      <Section title="Income" rows={sections.income} total={totals.income} totalLabel="Total income" link={link} />
      <Section title="Cost of services" rows={sections.costOfServices} total={totals.costOfServices} totalLabel="Total cost of services" link={link} />
      <Line label={`Gross profit${totals.grossMarginPct == null ? '' : ` · ${totals.grossMarginPct}%`}`} value={totals.grossProfit} />
      <Section title="Operating expenses" rows={sections.expenses} total={totals.expenses} totalLabel="Total operating expenses" link={link} />
      <Line label="Operating income" value={totals.operatingIncome} />
      {sections.otherIncome.length > 0 && <Section title="Other income" rows={sections.otherIncome} total={totals.otherIncome} totalLabel="Total other income" link={link} />}
      {sections.otherExpenses.length > 0 && <Section title="Other expenses" rows={sections.otherExpenses} total={totals.otherExpenses} totalLabel="Total other expenses" link={link} />}
      <Line label="Net income" value={totals.netIncome} emphasis />
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
  return (
    <Card>
      <CardContent className="p-4 md:p-6">
        <p className="mb-2 text-xs text-ink-muted">As of {fmtDate(r.asOf)}</p>
        <Section title="Assets" rows={r.assets} total={r.totals.assets} totalLabel="Total assets" link={link} />
        <Section title="Liabilities" rows={r.liabilities} total={r.totals.liabilities} totalLabel="Total liabilities" link={link} />
        <Section title="Equity" rows={r.equity} total={r.totals.equity} totalLabel="Total equity" link={link} />
        <Line label="Total liabilities and equity" value={r.totals.liabilitiesAndEquity} emphasis />
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
  const ops: BooksReportRow[] = [{ accountId: 'net-income', code: '', name: 'Net income', type: '', subtype: '', amount: r.netIncome }, ...r.operating];
  return (
    <Card>
      <CardContent className="p-4 md:p-6">
        <p className="mb-2 text-xs text-ink-muted">{`${fmtDate(r.from)} – ${fmtDate(r.to)}`}</p>
        <Section title="Operating activities" rows={ops} total={r.totals.operating} totalLabel="Cash from operations" link={link} />
        <Section title="Investing activities" rows={r.investing} total={r.totals.investing} totalLabel="Cash from investing" link={link} />
        <Section title="Financing activities" rows={r.financing} total={r.totals.financing} totalLabel="Cash from financing" link={link} />
        <Line label="Net change in cash" value={r.totals.netChange} emphasis />
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
