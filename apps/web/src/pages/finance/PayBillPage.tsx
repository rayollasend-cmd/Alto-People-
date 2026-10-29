import { useEffect, useMemo, useState } from 'react';
import { fmtMoneyAxis } from '@/components/ui/charts/axes';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtDateOnlyRange, fmtMoney, fmtStatementNo, ymdLocal } from '@/lib/format';
import { useStoreScope } from '@/lib/storeScope';
import { useUrlParam } from '@/lib/useUrlState';
import { cn } from '@/lib/cn';
import { decideApprovalRequest } from '@/lib/approvalRequestsApi';
import {
  PREMIUM_KEYS,
  PREMIUM_LABEL,
  draftAdjustmentStatement,
  getBillingAdjustments,
  getBillingClients,
  getClientTerms,
  getPayPeriods,
  getReconciliation,
  getRunningCost,
  saveClientTerms,
  type BillingAdjustmentRow,
  type PaycheckMargin,
  type PremiumKey,
  type PremiumRule,
  type StoreRunningCost,
  type TermsInput,
  type UnbilledRow,
  type BilledNotPaidRow,
} from '@/lib/payBillApi';
import { ListTemplate } from '@/components/templates';
import { ChartFrame } from '@/components/ui/ChartFrame';
import { PALETTE, StackedBarChart } from '@/components/ui/charts';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { QueryError } from '@/components/ui/QueryError';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { AssociateLink, Badge, Button, Card, CardContent, EmptyState, Field, Input, MetricCard, SegmentedControl, Select, Skeleton } from '@/components/ui';

/**
 * Pay and bill (BEYOND): every paycheck against the bill it should reach.
 *   Reconciliation  hours, premiums and retro pay — paid against billed —
 *                   and every dollar of billable pay on no bill, with why.
 *   Margin          per paycheck and client: billed, employer cost, margin.
 *   Adjustments     premium and retro lines payroll sent to client bills;
 *                   rebills waiting on review are approved here.
 *   Contract terms  per client, from a date: retro rebill, overtime, which
 *                   premiums bill and at what markup.
 *   This week       the running payroll cost per store.
 */

type Tab = 'reconciliation' | 'margin' | 'adjustments' | 'terms' | 'week';
const TABS: Array<{ value: Tab; label: string }> = [
  { value: 'reconciliation', label: 'Reconciliation' },
  { value: 'margin', label: 'Margin' },
  { value: 'adjustments', label: 'Adjustments' },
  { value: 'terms', label: 'Contract terms' },
  { value: 'week', label: 'This week' },
];

const GAP_REASONS = new Set(['NO_STATEMENT', 'AWAITING_REVIEW', 'NO_RATE']);
const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);
/** One statement number format everywhere (lib/format): "No. 0004", or "Draft". */
const statementLabel = (n: number | null) => fmtStatementNo(n);
/** A statement opens in the statements list, where it is read, marked paid or voided. */
const statementHref = (id: string) => `/clients/statements?statement=${id}`;
const TAB_KEYS = TABS.map((t) => t.value);

export function PayBillPage() {
  const [tab, setTab] = useUrlParam<Tab>('tab', 'reconciliation', TAB_KEYS, { history: 'push' });

  return (
    <ListTemplate
      title="Pay and bill"
      topbarTitle="Pay and bill"
      subtitle="Every paycheck against the bill it should reach: margin per check, billable pay on no statement, and premiums and retro pay rebilled by contract."
      filters={<SegmentedControl ariaLabel="Section" value={tab} onChange={setTab} options={TABS} />}
    >
      {tab === 'reconciliation' && <PeriodScoped render={(p) => <Reconciliation {...p} />} />}
      {tab === 'margin' && <PeriodScoped render={(p) => <Margin {...p} />} />}
      {tab === 'adjustments' && <Adjustments />}
      {tab === 'terms' && <ContractTerms />}
      {tab === 'week' && <ThisWeek />}
    </ListTemplate>
  );
}

/* ----- Period picker -------------------------------------------------------- */

/**
 * The pay period is in the URL (?period=2026-09-05:2026-09-18), so a link
 * to one period's reconciliation is that period. With none, the oldest
 * period holding billable pay on no statement — where the sidebar badge's
 * money is (deep audit MONEY-2: it opened on the newest, which said "No
 * gaps") — else the newest finalized payroll; the picker says which.
 */
function PeriodScoped({ render }: { render: (p: { periodStart: string; periodEnd: string }) => React.ReactNode }) {
  const q = useQuery({ queryKey: ['pay-bill', 'periods'], queryFn: getPayPeriods });
  const [picked, setPicked] = useUrlParam<string>('period', '');
  const periods = q.data?.periods ?? [];
  const gapPeriods = q.data?.gapPeriods ?? [];
  const latest = periods[0] ? `${periods[0].periodStart}:${periods[0].periodEnd}` : null;
  const valid = /^\d{4}-\d{2}-\d{2}:\d{4}-\d{2}-\d{2}$/.test(picked) ? picked : '';
  const opening = gapPeriods[0] ?? latest;
  const value = valid || opening;
  if (q.isLoading) return <Skeleton className="h-40" />;
  if (q.isError) return <QueryError what="pay periods" query={q} />;
  if (!value) return <EmptyState title="No finalized payroll yet" description="Once a payroll is finalized, its paychecks are reconciled against client bills here." />;
  const [periodStart, periodEnd] = value.split(':') as [string, string];
  // A linked period that has no finalized run any more still shows as itself.
  const options = periods.some((p) => `${p.periodStart}:${p.periodEnd}` === value) ? periods : [{ periodStart, periodEnd, runs: 0 }, ...periods];
  return (
    <div className="space-y-4">
      <div className="max-w-sm">
        <Field label="Pay period" hint={periodHint(value, latest, gapPeriods)}>
          <Select value={value} onChange={(e) => setPicked(e.target.value === opening ? '' : e.target.value)}>
            {options.map((p) => (
              <option key={`${p.periodStart}:${p.periodEnd}`} value={`${p.periodStart}:${p.periodEnd}`}>
                {fmtDateOnlyRange(p.periodStart, p.periodEnd)}
                {gapPeriods.includes(`${p.periodStart}:${p.periodEnd}`) ? ' · pay not billed' : ''}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {render({ periodStart, periodEnd })}
    </div>
  );
}

/** What the picker's hint says: which period this is, and how many hold pay on no statement. */
export function periodHint(value: string, latest: string | null, gapPeriods: string[]): string | undefined {
  const gaps = gapPeriods.length;
  if (gaps > 0 && gapPeriods.includes(value)) {
    return gaps === 1 ? 'Billable pay on no statement is in this period.' : `${gaps} periods have billable pay on no statement — ${value === gapPeriods[0] ? 'this is the oldest' : 'pick one marked “pay not billed”'}.`;
  }
  if (gaps > 0) return `${gaps} ${gaps === 1 ? 'period has' : 'periods have'} billable pay on no statement — marked “pay not billed”.`;
  return value === latest ? 'The newest finalized payroll.' : undefined;
}

/* ----- Reconciliation ------------------------------------------------------- */

function Reconciliation({ periodStart, periodEnd }: { periodStart: string; periodEnd: string }) {
  const q = useQuery({ queryKey: ['pay-bill', 'recon', periodStart, periodEnd], queryFn: () => getReconciliation(periodStart, periodEnd) });
  const d = q.data;
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.isError || !d) return <QueryError what="the reconciliation" query={q} />;

  const chartRows = [
    { line: 'Premiums', paid: d.premiums.paid, billed: d.premiums.billed, waiting: d.premiums.queued + d.premiums.awaitingReview, notBilled: d.premiums.notBillable + d.premiums.unbilled },
    { line: 'Retro pay', paid: d.retro.paid, billed: d.retro.rebilled, waiting: d.retro.queued + d.retro.awaitingReview, notBilled: d.retro.notRebilled },
  ];
  const nothingPaid = d.runs.length === 0 || d.paychecks.length === 0;
  const billedCols: GridColumn<BilledNotPaidRow>[] = [
    { key: 'worker', header: 'Worker', accessor: (r) => r.associateName, cell: (r) => <AssociateLink associateId={r.associateId}>{r.associateName}</AssociateLink>, primary: true },
    { key: 'client', header: 'Client', accessor: (r) => r.clientName, cardMeta: true },
    { key: 'week', header: 'Week of', accessor: (r) => r.weekStart, cell: (r) => fmtDate(r.weekStart), sortable: true },
    { key: 'hours', header: 'Hours billed', accessor: (r) => r.hours, cell: (r) => `${r.hours.toFixed(2)}h`, align: 'right', sortable: true, className: 'tabular-nums text-alert' },
    {
      key: 'statement',
      header: 'Statement',
      accessor: (r) => r.statementNumber ?? 0,
      csv: (r) => statementLabel(r.statementNumber),
      cell: (r) => (
        <Link to={statementHref(r.statementId)} className="text-accent underline-offset-2 hover:underline">
          {statementLabel(r.statementNumber)}
        </Link>
      ),
      cardMeta: true,
      stopRowClick: true,
    },
  ];
  const unbilledCols: GridColumn<UnbilledRow>[] = [
    { key: 'worker', header: 'Worker', accessor: (r) => r.associateName, cell: (r) => <AssociateLink associateId={r.associateId}>{r.associateName}</AssociateLink>, primary: true },
    { key: 'client', header: 'Client', accessor: (r) => r.clientName, cardMeta: true },
    { key: 'what', header: 'What', accessor: (r) => r.label, cell: (r) => <span>{r.label}{r.hours ? <span className="text-ink-muted"> · {r.hours.toFixed(2)}h</span> : null}</span> },
    { key: 'days', header: 'Days', accessor: (r) => r.workFrom ?? '', cell: (r) => (r.workFrom ? (r.workFrom === r.workTo ? fmtDate(r.workFrom) : `${fmtDate(r.workFrom)} – ${fmtDate(r.workTo)}`) : '—'), defaultHidden: true },
    { key: 'pay', header: 'Pay', accessor: (r) => r.payAmount, cell: (r) => fmtMoney(r.payAmount), align: 'right', sortable: true, className: 'tabular-nums' },
    {
      key: 'reason',
      header: 'Why',
      accessor: (r) => r.reasonText,
      cell: (r) => (
        <span className="flex items-start gap-2">
          <Badge variant={GAP_REASONS.has(r.reason) ? 'destructive' : r.reason === 'NOT_YET_BILLED' ? 'pending' : 'default'} size="sm">
            {GAP_REASONS.has(r.reason) ? 'Gap' : r.reason === 'NOT_YET_BILLED' ? 'Not yet' : 'By contract'}
          </Badge>
          <span className="text-xs text-ink-muted">{r.reasonText}</span>
        </span>
      ),
    },
  ];

  // Billing here is counted against paychecks. Hours a final statement
  // billed with no paycheck sit outside that count — say so above it, by
  // statement, instead of "Billed $0.00" beside "136.00h billed, not paid".
  const billedNoPay = d.billedNotPaid ?? [];
  const byStatement = [...billedNoPay.reduce((m, r) => {
    const cur = m.get(r.statementId) ?? { id: r.statementId, number: r.statementNumber, hours: 0 };
    cur.hours = Math.round((cur.hours + r.hours) * 100) / 100;
    return m.set(r.statementId, cur);
  }, new Map<string, { id: string; number: number | null; hours: number }>()).values()];
  const noChecks = nothingPaid ? 'No paychecks in this period' : undefined;

  return (
    <div className="space-y-4">
      {byStatement.length > 0 && (
        <div role="status" className="rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-ink">
          <p className="font-medium">
            {(d.billedNotPaidHours ?? 0).toFixed(2)} hours billed on{' '}
            {byStatement.map((st, i) => (
              <span key={st.id}>
                {i > 0 && (i === byStatement.length - 1 ? ' and ' : ', ')}
                <Link to={statementHref(st.id)} className="text-accent underline-offset-2 hover:underline">
                  {statementLabel(st.number)}
                </Link>
              </span>
            ))}{' '}
            with no paycheck.
          </p>
          <p className="mt-0.5 text-ink-muted">
            The client was charged for work nobody was paid for, so it isn’t in the billed and margin numbers below — they count what was billed against paychecks.{' '}
            <a href="#billed-not-paid" className="text-accent underline-offset-2 hover:underline">
              See who
            </a>
          </p>
        </div>
      )}

      <MetricStrip label="This period at a glance">
        <MetricCard label="Billed against paychecks" value={fmtMoney(d.totals.billed)} hint={d.totals.pending ? `${fmtMoney(d.totals.pending)} more on drafts and queued` : 'Nothing waiting on a draft'} nothing={noChecks} />
        <MetricCard label="Employer cost" value={fmtMoney(d.totals.cost)} hint={`${fmtMoney(d.totals.wages)} of it wages`} tone="neutral" nothing={noChecks} />
        <MetricCard
          label="Margin on paychecks"
          value={fmtMoney(d.totals.margin)}
          tone={d.totals.margin < 0 ? 'alert' : 'default'}
          hint={d.totals.marginPct != null ? `${d.totals.marginPct.toFixed(1)}% of what’s billed and pending` : 'Nothing billed against them yet'}
          href="/finance/pay-bill?tab=margin"
          nothing={noChecks}
        />
        <MetricCard
          label="Billable pay on no statement"
          value={fmtMoney(d.totals.gapPay)}
          tone={d.totals.gapPay > 0 ? 'alert' : 'default'}
          hint={d.totals.gapPay > 0 ? 'Gaps to close — listed below' : undefined}
          nothing={nothingPaid ? noChecks : d.totals.gapPay > 0 ? undefined : 'No gaps this period'}
        />
      </MetricStrip>

      <div className="grid gap-3 md:grid-cols-3">
        <PaidBilled title="Hours" unit="h" rows={[['Paid', d.hours.paid], ['Paid and on a final statement', d.hours.billed], ['Paid and on a draft', d.hours.onDraft], ['Paid, on no statement', d.hours.unbilled], ['Billed, not paid', d.billedNotPaidHours ?? 0]]} />
        <PaidBilled title="Premiums" rows={[['Paid', d.premiums.paid], ['Billed', d.premiums.billed], ['Queued or in review', d.premiums.queued + d.premiums.awaitingReview], ['Not billable by contract', d.premiums.notBillable], ['Not billed', d.premiums.unbilled]]} />
        <PaidBilled title="Retro pay" rows={[['Paid', d.retro.paid], ['Rebilled', d.retro.rebilled], ['Queued or in review', d.retro.queued + d.retro.awaitingReview], ['Not rebilled', d.retro.notRebilled]]} />
      </div>

      <ChartFrame
        title="Paid against billed"
        description="Premium and retro dollars this period: what payroll paid, what reached a bill, what is waiting, and what was not billed."
        summary={`Premiums: ${fmtMoney(d.premiums.paid)} paid, ${fmtMoney(d.premiums.billed)} billed. Retro pay: ${fmtMoney(d.retro.paid)} paid, ${fmtMoney(d.retro.rebilled)} rebilled.`}
        columns={[
          { key: 'line', label: 'Line' },
          { key: 'paid', label: 'Paid', numeric: true, format: (v) => fmtMoney(v as number) },
          { key: 'billed', label: 'Billed', numeric: true, format: (v) => fmtMoney(v as number) },
          { key: 'waiting', label: 'Waiting', numeric: true, format: (v) => fmtMoney(v as number) },
          { key: 'notBilled', label: 'Not billed', numeric: true, format: (v) => fmtMoney(v as number) },
        ]}
        rows={d.premiums.paid === 0 && d.retro.paid === 0 ? [] : chartRows}
        csvName={`paid-vs-billed-${periodStart}`}
        height={220}
        empty={<EmptyState title="No premiums or retro pay this period" size="sm" />}
      >
        <StackedBarChart
          data={chartRows}
          x="line"
          stacked={false}
          format={fmtMoneyAxis}
          series={[
            { key: 'paid', name: 'Paid', color: PALETTE.primary },
            { key: 'billed', name: 'Billed', color: PALETTE.good },
            { key: 'waiting', name: 'Waiting', color: PALETTE.warn },
            { key: 'notBilled', name: 'Not billed', color: PALETTE.bad },
          ]}
        />
      </ChartFrame>

      <section className="space-y-2" aria-labelledby="pay-bill-unbilled-title">
        <SectionTitle
          title={<span id="pay-bill-unbilled-title">Billable pay on no bill{d.unbilled.length ? ` · ${d.unbilled.length}` : ''}</span>}
          description="Pay for client work that reached no statement, with why — a gap to close, or the contract working as written."
        />
        <DataGrid
          id="pay-bill-unbilled"
          caption="Billable pay on no bill"
          rows={d.unbilled}
          columns={unbilledCols}
          rowKey={(r) => `${r.payrollItemId}:${r.kind}:${r.clientId}:${r.label}:${r.reason}`}
          noun={{ one: 'line', many: 'lines' }}
          defaultSort={{ key: 'pay', direction: 'desc' }}
          empty={
            nothingPaid
              ? // Nothing paid is nothing to check — not "all clear" (finance walk 11).
                { title: 'Nothing paid to check', description: 'No finalized paychecks in this period, so there is no pay to match to a bill. Billed hours with no paycheck are listed below.' }
              : { title: 'Everything paid is on a bill', description: 'Every billable hour, premium and retro dollar this period reached a client statement.' }
          }
        />
      </section>

      <section id="billed-not-paid" className="scroll-mt-24 space-y-2" aria-labelledby="pay-bill-bnp-title">
        <SectionTitle
          title={<span id="pay-bill-bnp-title">Billed, not paid{billedNoPay.length ? ` · ${(d.billedNotPaidHours ?? 0).toFixed(2)}h` : ''}</span>}
          description="Hours a final statement billed that no paycheck covers, by person and week."
        />
        <DataGrid
          id="pay-bill-billed-not-paid"
          caption="Billed, not paid"
          rows={billedNoPay}
          columns={billedCols}
          rowKey={(r) => `${r.associateId}:${r.clientId}:${r.weekStart}`}
          noun={{ one: 'week', many: 'weeks' }}
          defaultSort={{ key: 'hours', direction: 'desc' }}
          empty={
            billedNoPay.length === 0 && d.hours.billed === 0
              ? { title: 'No final statements to check', description: 'Nothing was billed on a final statement in this period yet.' }
              : { title: 'Every billed hour was paid', description: 'Each person-week on a final statement has a paystub.' }
          }
        />
      </section>
    </div>
  );
}

function PaidBilled({ title, rows, unit }: { title: string; rows: Array<[string, number]>; unit?: 'h' }) {
  return (
    <Card>
      <CardContent>
        <div className="text-2xs font-medium uppercase tracking-[0.14em] text-ink-muted">{title}</div>
        <dl className="mt-2 space-y-1 text-sm tabular-nums">
          {rows.map(([label, v], i) => (
            <div key={label} className="flex justify-between gap-3">
              <dt className={cn('text-ink-muted', i === 0 && 'text-ink')}>{label}</dt>
              <dd className={cn(i === 0 ? 'font-medium text-ink' : 'text-ink')}>{unit === 'h' ? `${v.toFixed(2)}h` : fmtMoney(v)}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

/* ----- Margin per paycheck -------------------------------------------------- */

function Margin({ periodStart, periodEnd }: { periodStart: string; periodEnd: string }) {
  const q = useQuery({ queryKey: ['pay-bill', 'recon', periodStart, periodEnd], queryFn: () => getReconciliation(periodStart, periodEnd) });
  const cols: GridColumn<PaycheckMargin>[] = [
    { key: 'worker', header: 'Worker', accessor: (r) => r.associateName, cell: (r) => <AssociateLink associateId={r.associateId}>{r.associateName}</AssociateLink>, primary: true },
    { key: 'client', header: 'Client', accessor: (r) => r.clientName, cardMeta: true },
    { key: 'hours', header: 'Hours', accessor: (r) => r.hours, cell: (r) => r.hours.toFixed(2), align: 'right', className: 'tabular-nums' },
    { key: 'wages', header: 'Wages', accessor: (r) => r.wages, cell: (r) => fmtMoney(r.wages), align: 'right', className: 'tabular-nums', defaultHidden: true },
    { key: 'taxes', header: 'Employer taxes', accessor: (r) => r.employerTaxes, cell: (r) => fmtMoney(r.employerTaxes), align: 'right', className: 'tabular-nums', defaultHidden: true },
    { key: 'burden', header: 'Other burden', accessor: (r) => r.burden + r.overhead, cell: (r) => fmtMoney(r.burden + r.overhead), align: 'right', className: 'tabular-nums', defaultHidden: true },
    { key: 'cost', header: 'Employer cost', accessor: (r) => r.cost, cell: (r) => fmtMoney(r.cost), align: 'right', sortable: true, className: 'tabular-nums' },
    { key: 'billed', header: 'Billed', accessor: (r) => r.billed, cell: (r) => (r.pending ? <span>{fmtMoney(r.billed)}<span className="block text-2xs text-ink-muted">+{fmtMoney(r.pending)} pending</span></span> : fmtMoney(r.billed)), align: 'right', sortable: true, className: 'tabular-nums' },
    {
      key: 'margin',
      header: 'Margin',
      accessor: (r) => r.margin,
      cell: (r) => (
        <span className={cn(r.margin < 0 ? 'text-alert' : 'text-ink')}>
          {fmtMoney(r.margin)}
          {r.marginPct != null && <span className="block text-2xs text-ink-muted">{r.marginPct.toFixed(1)}%</span>}
        </span>
      ),
      align: 'right',
      sortable: true,
      className: 'tabular-nums',
    },
    {
      key: 'statements',
      header: 'Statements',
      accessor: (r) => r.statements.map((s) => s.number ?? '').join(' '),
      cell: (r) =>
        r.statements.length ? (
          <span className="flex flex-wrap gap-1">
            {r.statements.map((s) => (
              <Link key={s.id} to={statementHref(s.id)} className="text-xs text-accent underline-offset-2 hover:underline">
                {statementLabel(s.number)}
              </Link>
            ))}
          </span>
        ) : (
          <span className="text-xs text-ink-muted">{r.clientId ? 'None yet' : '—'}</span>
        ),
      stopRowClick: true,
    },
  ];
  return (
    <DataGrid
      id="pay-bill-margin"
      caption="Margin per paycheck"
      rows={q.data?.paychecks}
      columns={cols}
      rowKey={(r) => `${r.payrollItemId}:${r.clientId}`}
      loading={q.isLoading}
      error={q.isError ? errText(q.error, 'Could not load margin.') : null}
      onRetry={() => void q.refetch()}
      noun={{ one: 'paycheck', many: 'paychecks' }}
      defaultSort={{ key: 'margin', direction: 'asc' }}
      empty={{ title: 'No paychecks in this period', description: 'Once this period’s payroll is finalized, each paycheck’s cost is set against what its hours billed.' }}
    />
  );
}

/* ----- Adjustments ---------------------------------------------------------- */

const ADJ_STATUS: Record<BillingAdjustmentRow['status'], { label: string; tone: 'pending' | 'info' | 'success' | 'default' }> = {
  PENDING_REVIEW: { label: 'Waiting for review', tone: 'pending' },
  READY: { label: 'On the next statement', tone: 'info' },
  BILLED: { label: 'Billed', tone: 'success' },
  VOID: { label: 'Not billed', tone: 'default' },
};

function Adjustments() {
  const { can } = useAuth();
  const canWrite = can('process:payroll');
  const qc = useQueryClient();
  const [status, setStatus] = useUrlParam<BillingAdjustmentRow['status'] | 'ALL'>('status', 'PENDING_REVIEW', ['PENDING_REVIEW', 'READY', 'BILLED', 'VOID', 'ALL']);
  const q = useQuery({ queryKey: ['pay-bill', 'adjustments', status], queryFn: () => getBillingAdjustments(status === 'ALL' ? undefined : status) });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['pay-bill'] });
  const decide = useMutation({
    mutationFn: ({ row, decision }: { row: BillingAdjustmentRow; decision: 'APPROVE' | 'REJECT' }) => decideApprovalRequest(row.approvalId!, { decision }),
    onSuccess: (_r, { row, decision }) => {
      toast.success(decision === 'APPROVE' ? `${fmtMoney(row.amount)} rebilled to ${row.clientName} — it goes on their next statement.` : `${fmtMoney(row.amount)} will not be billed to ${row.clientName}.`);
      refresh();
    },
    onError: (e) => toast.error(errText(e, 'Could not record the decision.')),
  });
  const billNow = useMutation({
    mutationFn: (row: BillingAdjustmentRow) => draftAdjustmentStatement(row.clientId),
    onSuccess: (r, row) => {
      toast.success(`${fmtMoney(r.amount)} for ${row.clientName} is on its own draft statement (${r.adjustments} ${r.adjustments === 1 ? 'line' : 'lines'}). Finalize it from the client's statements.`);
      refresh();
    },
    onError: (e) => toast.error(errText(e, 'Could not draft the statement.')),
  });

  const cols: GridColumn<BillingAdjustmentRow>[] = [
    { key: 'client', header: 'Client', accessor: (r) => r.clientName, primary: true },
    {
      key: 'what',
      header: 'What',
      accessor: (r) => r.label,
      cell: (r) => (
        <span className="block min-w-0">
          <span className="block text-sm text-ink">{r.label}</span>
          {r.basis && <span className="block text-2xs text-ink-muted">{r.basis}</span>}
          {r.originalStatements.length > 0 && (
            <span className="block text-2xs text-ink-muted">Corrects {r.originalStatements.map((s) => statementLabel(s.number)).join(', ')}</span>
          )}
          {r.reason && <span className="block text-2xs text-ink-muted">{r.reason}</span>}
        </span>
      ),
    },
    { key: 'pay', header: 'Pay', accessor: (r) => r.payAmount, cell: (r) => fmtMoney(r.payAmount), align: 'right', className: 'tabular-nums', defaultHidden: true },
    { key: 'amount', header: 'Bill', accessor: (r) => r.amount, cell: (r) => fmtMoney(r.amount), align: 'right', sortable: true, className: 'tabular-nums' },
    {
      key: 'status',
      header: 'Status',
      accessor: (r) => ADJ_STATUS[r.status].label,
      cell: (r) => (
        <span className="flex flex-col items-start gap-0.5">
          <Badge variant={ADJ_STATUS[r.status].tone}>{ADJ_STATUS[r.status].label}</Badge>
          {r.billedStatement && (
            <Link to={statementHref(r.billedStatement.id)} className="text-2xs text-accent hover:underline">
              On statement {statementLabel(r.billedStatement.number)}
            </Link>
          )}
        </span>
      ),
      cardMeta: true,
    },
    {
      key: 'actions',
      header: 'Actions',
      accessor: () => '',
      searchable: false,
      stopRowClick: true,
      cell: (r) =>
        !canWrite ? null : r.status === 'PENDING_REVIEW' && r.approvalId ? (
          <span className="flex flex-wrap gap-2">
            <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate({ row: r, decision: 'APPROVE' })}>
              Rebill
            </Button>
            <Button size="sm" variant="secondary" disabled={decide.isPending} onClick={() => decide.mutate({ row: r, decision: 'REJECT' })}>
              Don't bill
            </Button>
          </span>
        ) : r.status === 'READY' ? (
          <Button size="sm" variant="secondary" disabled={billNow.isPending} onClick={() => billNow.mutate(r)}>
            Bill now on its own statement
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="space-y-3">
      <SegmentedControl
        ariaLabel="Status"
        value={status}
        onChange={setStatus}
        options={[
          { value: 'PENDING_REVIEW', label: 'Waiting for review' },
          { value: 'READY', label: 'Next statement' },
          { value: 'BILLED', label: 'Billed' },
          { value: 'VOID', label: 'Not billed' },
          { value: 'ALL', label: 'All' },
        ]}
      />
      <DataGrid
        id="pay-bill-adjustments"
        caption="Billing adjustments"
        rows={q.data?.adjustments}
        columns={cols}
        rowKey={(r) => r.id}
        loading={q.isLoading}
        error={q.isError ? errText(q.error, 'Could not load adjustments.') : null}
        onRetry={() => void q.refetch()}
        noun={{ one: 'adjustment', many: 'adjustments' }}
        defaultSort={{ key: 'amount', direction: 'desc' }}
        empty={{
          title: status === 'PENDING_REVIEW' ? 'No rebills waiting for review' : 'No adjustments here',
          description: 'When payroll pays retro pay or a billable premium for client work, the matching bill line appears here.',
        }}
      />
    </div>
  );
}

/* ----- Contract terms ------------------------------------------------------- */

// The local calendar day (CODE-14), not UTC's: a term dated "today" after 5 PM Pacific was tomorrow.
const todayYmd = () => ymdLocal();

/** "Retro: Finance reviews · Overtime: 1.5× · …" — a version of the terms in one read. */
function termsWords(h: { retroRebill: string; overtimeBilling: string; defaultMarkupPct: number | null; premiumRules: Record<PremiumKey, PremiumRule> }) {
  const retro = h.retroRebill === 'AUTO' ? 'rebill automatically' : h.retroRebill === 'REVIEW' ? 'Finance reviews' : 'never rebill';
  const billable =
    PREMIUM_KEYS.filter((k) => h.premiumRules[k].mode !== 'NOT_BILLABLE')
      .map((k) => `${PREMIUM_LABEL[k].toLowerCase()} (${h.premiumRules[k].mode === 'AT_COST' ? `at cost${h.premiumRules[k].markupPct ? ` + ${h.premiumRules[k].markupPct}%` : ''}` : 'at markup'})`)
      .join(', ') || 'no premiums';
  return { retro, overtime: h.overtimeBilling === 'STRAIGHT' ? 'straight time' : '1.5× the bill rate', markup: h.defaultMarkupPct != null ? `${h.defaultMarkupPct}%` : 'none', billable };
}

/**
 * Each client's billing terms, read first: what's in force and its
 * history. Changing them is a deliberate step ("Change terms"), not a form
 * that sits open in a report. The client follows the top bar's choice.
 */
function ContractTerms() {
  const { can } = useAuth();
  const canWrite = can('process:payroll');
  const qc = useQueryClient();
  const scope = useStoreScope();
  const clientsQ = useQuery({ queryKey: ['pay-bill', 'clients'], queryFn: getBillingClients });
  const [clientId, setClientId] = useUrlParam<string>('client', '');
  const list = clientsQ.data?.clients ?? [];
  const fromBar = scope.clientId && list.some((c) => c.id === scope.clientId) ? scope.clientId : null;
  const selected = (clientId && list.some((c) => c.id === clientId) ? clientId : null) ?? fromBar ?? list[0]?.id ?? null;
  const termsQ = useQuery({ queryKey: ['pay-bill', 'terms', selected], queryFn: () => getClientTerms(selected!), enabled: !!selected });
  const [form, setForm] = useState<TermsInput | null>(null);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    setEditing(false);
  }, [selected]);
  useEffect(() => {
    const c = termsQ.data?.current;
    if (!c) return;
    setForm({ effectiveFrom: todayYmd(), retroRebill: c.retroRebill, overtimeBilling: c.overtimeBilling, premiumRules: c.premiumRules, defaultMarkupPct: c.defaultMarkupPct, notes: c.notes });
  }, [termsQ.data]);
  const save = useMutation({
    mutationFn: (input: TermsInput) => saveClientTerms(selected!, input),
    onSuccess: (_r, input) => {
      toast.success(`${termsQ.data?.client.name ?? 'The client'}'s billing terms are saved, in force from ${fmtDate(input.effectiveFrom)}.`);
      setEditing(false);
      void qc.invalidateQueries({ queryKey: ['pay-bill'] });
    },
    onError: (e) => toast.error(errText(e, 'Could not save the terms.')),
  });

  if (clientsQ.isLoading) return <Skeleton className="h-64" />;
  if (clientsQ.isError) return <QueryError what="clients" query={clientsQ} />;
  if (!list.length) return <EmptyState title="No clients yet" description="Billing terms are set per client." />;

  const setRule = (k: PremiumKey, patch: Partial<PremiumRule>) =>
    setForm((f) => (f ? { ...f, premiumRules: { ...f.premiumRules, [k]: { ...f.premiumRules[k], ...patch } } } : f));
  const current = termsQ.data?.current;
  const now = current ? termsWords(current) : null;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <Card className="min-w-0">
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <Field label="Client" className="min-w-0 flex-1 sm:max-w-sm">
              <Select value={selected ?? ''} onChange={(e) => setClientId(e.target.value)}>
                {list.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            {canWrite && !editing && current && (
              <Button variant="secondary" onClick={() => setEditing(true)}>
                Change terms
              </Button>
            )}
          </div>
          {termsQ.isLoading || !form ? (
            <Skeleton className="h-48" />
          ) : termsQ.isError ? (
            <QueryError what="billing terms" query={termsQ} />
          ) : !editing ? (
            <dl className="grid gap-3 text-sm sm:grid-cols-2" aria-label="Terms in force">
              <div>
                <dt className="text-ink-muted">Retro pay</dt>
                <dd className="text-ink">{now?.retro}</dd>
              </div>
              <div>
                <dt className="text-ink-muted">Overtime</dt>
                <dd className="text-ink">{now?.overtime}</dd>
              </div>
              <div>
                <dt className="text-ink-muted">Default markup</dt>
                <dd className="text-ink">{now?.markup}</dd>
              </div>
              <div>
                <dt className="text-ink-muted">Premiums billed</dt>
                <dd className="text-ink">{now?.billable}</dd>
              </div>
              {current?.notes && (
                <div className="sm:col-span-2">
                  <dt className="text-ink-muted">Notes</dt>
                  <dd className="text-ink">{current.notes}</dd>
                </div>
              )}
              {selected && (
                <div className="sm:col-span-2">
                  <dd>
                    <Link to={`/clients/${selected}?section=rates`} className="text-accent underline-offset-2 hover:underline">
                      The client’s bill rates
                    </Link>
                  </dd>
                </div>
              )}
            </dl>
          ) : (
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (form) save.mutate(form);
              }}
            >
              <fieldset disabled={!canWrite} className="min-w-0 space-y-4">
                <Field label="In force from" hint="A new date starts a new version; the same date corrects that version.">
                  <Input type="date" value={form.effectiveFrom} onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })} required />
                </Field>
                <div className="space-y-1.5">
                  <span className="block text-sm font-medium text-ink" id="retro-label">Retro pay</span>
                  <SegmentedControl
                    ariaLabel="Retro pay"
                    value={form.retroRebill}
                    onChange={(v) => setForm({ ...form, retroRebill: v })}
                    options={[
                      { value: 'AUTO', label: 'Rebill automatically' },
                      { value: 'REVIEW', label: 'Finance reviews' },
                      { value: 'NEVER', label: 'Never rebill' },
                    ]}
                  />
                </div>
                <div className="space-y-1.5">
                  <span className="block text-sm font-medium text-ink">Overtime</span>
                  <SegmentedControl
                    ariaLabel="Overtime"
                    value={form.overtimeBilling}
                    onChange={(v) => setForm({ ...form, overtimeBilling: v })}
                    options={[
                      { value: 'MULTIPLIED', label: '1.5× the bill rate' },
                      { value: 'STRAIGHT', label: 'Straight time' },
                    ]}
                  />
                </div>
                <Field label="Default markup %" hint="Used to price rebills when a role has no bill rate on its rate card. Leave empty to skip those.">
                  <Input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.1"
                    value={form.defaultMarkupPct ?? ''}
                    onChange={(e) => setForm({ ...form, defaultMarkupPct: e.target.value === '' ? null : Number(e.target.value) })}
                  />
                </Field>
                <div className="space-y-2">
                  <span className="block text-sm font-medium text-ink">Premiums</span>
                  <ul className="divide-y divide-line rounded-md border border-line">
                    {PREMIUM_KEYS.map((k) => {
                      const r = form.premiumRules[k];
                      return (
                        <li key={k} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center">
                          <span className="flex-1 text-sm text-ink">{PREMIUM_LABEL[k]}</span>
                          <div className="flex gap-2">
                            <Select aria-label={`${PREMIUM_LABEL[k]} billing`} size="sm" value={r.mode} onChange={(e) => setRule(k, { mode: e.target.value as PremiumRule['mode'], markupPct: e.target.value === 'AT_COST' ? (r.markupPct ?? 0) : null })}>
                              <option value="NOT_BILLABLE">Not billable</option>
                              <option value="AT_COST">At cost</option>
                              <option value="BILL_MARKUP">At the bill-rate markup</option>
                            </Select>
                            {r.mode === 'AT_COST' && (
                              <Input
                                aria-label={`${PREMIUM_LABEL[k]} markup percent`}
                                className="w-24"
                                type="number"
                                min={0}
                                step="0.1"
                                value={r.markupPct ?? 0}
                                onChange={(e) => setRule(k, { markupPct: Number(e.target.value) })}
                              />
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
                <Field label="Notes">
                  <Input value={form.notes ?? ''} maxLength={1000} onChange={(e) => setForm({ ...form, notes: e.target.value || null })} placeholder="Contract section, signed date…" />
                </Field>
              </fieldset>
              {canWrite && (
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" disabled={save.isPending}>
                    {save.isPending ? 'Saving…' : 'Save terms'}
                  </Button>
                  <Button type="button" variant="secondary" onClick={() => setEditing(false)}>
                    Cancel
                  </Button>
                </div>
              )}
            </form>
          )}
        </CardContent>
      </Card>
      <Card className="min-w-0">
        <CardContent>
          <div className="text-2xs font-medium uppercase tracking-[0.14em] text-ink-muted">Versions</div>
          {termsQ.data?.history.length ? (
            <ol className="mt-2 space-y-3">
              {termsQ.data.history.map((h) => (
                <li key={h.id} className="text-sm">
                  <div className="font-medium text-ink">From {fmtDate(h.effectiveFrom)}</div>
                  <div className="text-xs text-ink-muted">
                    Retro: {termsWords(h).retro} · Overtime: {termsWords(h).overtime}
                    {h.defaultMarkupPct != null ? ` · Default markup ${h.defaultMarkupPct}%` : ''}
                  </div>
                  <div className="text-xs text-ink-muted">Billable: {termsWords(h).billable}</div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-2 text-sm text-ink-muted">No terms on file. Until there are, retro pay waits for Finance's review, overtime bills at 1.5×, and no premium is billed.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* ----- This week's running cost --------------------------------------------- */

function ThisWeek() {
  const q = useQuery({ queryKey: ['pay-bill', 'running-cost'], queryFn: getRunningCost, refetchInterval: 60_000 });
  const d = q.data;
  const chartRows = useMemo(() => (d?.stores ?? []).slice(0, 12).map((s) => ({ store: s.siteName, wages: s.wages, loaded: Math.round((s.loadedCost - s.wages) * 100) / 100 })), [d]);
  const cols: GridColumn<StoreRunningCost>[] = [
    { key: 'store', header: 'Store', accessor: (r) => r.siteName, cell: (r) => <span>{r.siteName}{r.clientName && <span className="block text-2xs text-ink-muted">{r.clientName}</span>}</span>, primary: true },
    { key: 'hours', header: 'Hours', accessor: (r) => r.hours, cell: (r) => (r.overtimeHours ? <span>{r.hours.toFixed(2)}<span className="block text-2xs text-warning">{r.overtimeHours.toFixed(2)}h overtime</span></span> : r.hours.toFixed(2)), align: 'right', className: 'tabular-nums' },
    { key: 'wages', header: 'Wages', accessor: (r) => r.wages, cell: (r) => fmtMoney(r.wages), align: 'right', className: 'tabular-nums' },
    { key: 'loaded', header: 'Loaded cost', accessor: (r) => r.loadedCost, cell: (r) => fmtMoney(r.loadedCost), align: 'right', sortable: true, className: 'tabular-nums' },
    { key: 'now', header: 'On the clock', accessor: (r) => r.onClockNow, align: 'right', cardMeta: true },
  ];
  if (q.isError) return <QueryError what="this week's payroll cost" query={q} />;
  const none = d && d.totals.hours === 0 ? 'No hours yet this week' : undefined;
  return (
    <div className="space-y-4">
      {d ? (
        <MetricStrip label="This week so far">
          <MetricCard label="Loaded cost so far" value={fmtMoney(d.totals.loadedCost)} hint={`Week of ${fmtDate(d.weekStart)}`} nothing={none} />
          <MetricCard label="Wages so far" value={fmtMoney(d.totals.wages)} tone="neutral" nothing={none} />
          <MetricCard label="Hours" value={d.totals.hours.toFixed(2)} tone="neutral" nothing={none} />
          <MetricCard label="On the clock now" value={d.totals.onClockNow} tone="neutral" nothing={d.totals.onClockNow ? undefined : 'No one on the clock'} />
        </MetricStrip>
      ) : (
        <Skeleton className="h-24" />
      )}
      {d && d.stores.length > 0 && (
        <ChartFrame
          title="Cost by store"
          description="Wages so far this week, with the burden and overhead on top. Updates every minute."
          summary={`${fmtMoney(d.totals.loadedCost)} loaded cost across ${d.stores.length} ${d.stores.length === 1 ? 'store' : 'stores'} so far this week.`}
          columns={[
            { key: 'store', label: 'Store' },
            { key: 'wages', label: 'Wages', numeric: true, format: (v) => fmtMoney(v as number) },
            { key: 'loaded', label: 'Burden and overhead', numeric: true, format: (v) => fmtMoney(v as number) },
          ]}
          rows={chartRows}
          csvName={`running-cost-${d.weekStart}`}
          height={Math.max(160, chartRows.length * 30 + 48)}
        >
          {/* Store names read down the side, never cut to "Walm…" under a column. */}
          <StackedBarChart
            data={chartRows}
            x="store"
            layout="horizontal"
            format={fmtMoneyAxis}
            series={[
              { key: 'wages', name: 'Wages', color: PALETTE.primary },
              { key: 'loaded', name: 'Burden and overhead', color: PALETTE.secondary },
            ]}
          />
        </ChartFrame>
      )}
      <DataGrid
        id="pay-bill-running-cost"
        caption="Running payroll cost by store"
        rows={d?.stores}
        columns={cols}
        rowKey={(r) => r.siteId ?? 'none'}
        loading={q.isLoading}
        noun={{ one: 'store', many: 'stores' }}
        defaultSort={{ key: 'loaded', direction: 'desc' }}
        empty={{ title: "No hours yet this week", description: "As people clock in, each store's cost so far shows here." }}
      />
    </div>
  );
}
