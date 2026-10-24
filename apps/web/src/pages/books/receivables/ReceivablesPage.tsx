import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { HandCoins, Plus, RotateCcw } from '@/components/ui/icons';
import {
  AGING_BUCKET_KEYS,
  AGING_BUCKET_LABELS,
  CLIENT_PAYMENT_METHOD_LABELS,
  type AgingBucketKey,
  type ClientPaymentRow,
  type ReceivableStatement,
  type ReceivablesAgingRow,
} from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { usePrompt } from '@/lib/confirm';
import { fmtDate, fmtMoney, fmtStatementNo, ymdLocal } from '@/lib/format';
import { cn } from '@/lib/cn';
import {
  RECEIVABLES_KEY,
  getCollectionsWorklist,
  getDsoTrend,
  getReceivablesAging,
  listClientPayments,
  undoClientPayment,
} from '@/lib/books/receivablesApi';
import { ListTemplate } from '@/components/templates';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { toast } from '@/components/ui/Toaster';
import { PaymentDialog, useWho } from './receivablesKit';
import { AgingByClientChart, CollectionActions, CollectionsGrid, DsoTrendChart, PromiseDialog, ReminderLine, useCollectionActions } from './collections';
import type { CollectionItem } from '@/lib/books/receivablesApi';

/**
 * Receivables: what clients owe, by how late (the aging, with the picture
 * by client and days to collect), the collections worklist (finance walk
 * 7), the money they paid and the statements it paid, and the catch-up that
 * posts history to the books. Contract: packages/shared/src/books/receivables.ts.
 */

type View = 'aging' | 'collections' | 'payments';
const VIEWS: View[] = ['aging', 'collections', 'payments'];
const money = (n: number) => fmtMoney(n, { precise: true });


export function ReceivablesPage() {
  const who = useWho();
  const { can } = useAuth();
  const manage = can('manage:books');
  const [params, setParams] = useSearchParams();
  const asked = params.get('view') as View | null;
  const view: View = asked && VIEWS.includes(asked) ? asked : 'aging';
  const setView = (v: View) =>
    setParams((p) => {
      p.set('view', v);
      return p;
    }, { replace: true });
  const [paying, setPaying] = useState<{ clientId: string | null } | null>(null);
  const aging = useQuery({ queryKey: [...RECEIVABLES_KEY, 'aging'], queryFn: () => getReceivablesAging() });
  const payments = useQuery({ queryKey: [...RECEIVABLES_KEY, 'payments'], queryFn: () => listClientPayments(), enabled: view === 'payments' });
  // The worklist also feeds each client's expanded statements (reminder stage, last sent, next).
  const worklist = useQuery({ queryKey: [...RECEIVABLES_KEY, 'worklist'], queryFn: getCollectionsWorklist });

  const dso = useQuery({ queryKey: [...RECEIVABLES_KEY, 'dso'], queryFn: () => getDsoTrend(6) });

  const trendDrawn = (dso.data?.months.filter((m) => m.days !== null).length ?? 0) >= 3;
  const totals = aging.data?.totals;
  const late = totals ? totals.open - totals.buckets.current : 0;
  const over60 = totals ? totals.buckets.days61to90 + totals.buckets.over90 : 0;

  return (
    <ListTemplate
      title="Receivables"
      topbarTitle="Receivables"
      subtitle={`What ${who.many} owe, how late it is, and the money they’ve paid.`}
      actions={[{ label: 'Record a payment', icon: Plus, primary: true, hidden: !manage, onSelect: () => setPaying({ clientId: null }) }]}
      summary={
        <MetricStrip label="Receivables at a glance" empty={aging.isSuccess && dso.isSuccess && !totals?.open && !dso.data.last90.statements && !dso.data.collectedThisMonth.payments}>
          <MetricCard label="Owed to you" value={totals ? money(totals.open) : '—'} hint={aging.data ? `${aging.data.statements.length} open ${aging.data.statements.length === 1 ? 'statement' : 'statements'}` : undefined} href="/books/receivables?view=aging" nothing={totals && !totals.open ? 'Nothing owed' : undefined} />
          <MetricCard label="Past due" value={totals ? money(late) : '—'} hint={totals && totals.open ? `${Math.round((late / totals.open) * 100)}% of what’s owed` : undefined} tone={late > 0 ? 'warning' : 'default'} href="/books/receivables?view=collections" nothing={totals && !late ? 'Nothing late' : undefined} />
          <MetricCard label="Over 60 days" value={totals ? money(over60) : '—'} hint={over60 > 0 ? 'Call these first' : undefined} tone={over60 > 0 ? 'alert' : 'default'} href="/books/receivables?view=collections" nothing={totals && !over60 ? 'Nothing over 60 days' : undefined} />
          <MetricCard
            label="Days to collect"
            value={dso.data?.last90.days ?? '—'}
            unit={dso.data?.last90.days != null ? (dso.data.last90.days === 1 ? 'day' : 'days') : undefined}
            hint={dso.data ? `Last 90 days · ${dso.data.last90.statements} ${dso.data.last90.statements === 1 ? 'statement' : 'statements'} paid` : undefined}
            tone="neutral"
            nothing={dso.data && dso.data.last90.days === null ? 'No statements paid in 90 days' : undefined}
          />
          <MetricCard
            label="Collected this month"
            value={dso.data ? money(dso.data.collectedThisMonth.amount) : '—'}
            hint={dso.data ? `${dso.data.collectedThisMonth.payments} ${dso.data.collectedThisMonth.payments === 1 ? 'payment' : 'payments'}` : undefined}
            tone="good"
            href="/books/receivables?view=payments"
            nothing={dso.data && !dso.data.collectedThisMonth.payments ? 'Nothing collected yet this month' : undefined}
          />
        </MetricStrip>
      }
      filters={
        <SegmentedControl
          ariaLabel="Receivables view"
          value={view}
          onChange={setView}
          options={[
            { value: 'aging', label: `By ${who.one}` },
            { value: 'collections', label: `Collections${worklist.data ? ` · ${worklist.data.items.filter((i) => i.nextActionOn <= ymdLocal()).length} today` : ''}` },
            { value: 'payments', label: 'Payments' },
          ]}
        />
      }
    >
      {view === 'aging' ? (
        // On a phone the clients come first and the pictures after them;
        // from lg the charts lead, side by side.
        <div className="flex flex-col gap-[var(--d-stack)]">
          {(aging.data?.rows.length ?? 0) > 0 && (
            <div className={cn('order-last grid gap-[var(--d-stack)] lg:order-first', trendDrawn && 'lg:grid-cols-2')}>
              <AgingByClientChart rows={aging.data!.rows} />
              <DsoTrendChart />
            </div>
          )}
          <AgingGrid rows={aging.data?.rows ?? []} statements={aging.data?.statements ?? []} reminders={worklist.data?.items ?? []} manage={manage} loading={aging.isLoading} error={aging.isError ? `Couldn’t load what ${who.many} owe.` : null} onRetry={() => void aging.refetch()} onPay={manage ? (clientId) => setPaying({ clientId }) : null} />
        </div>
      ) : view === 'collections' ? (
        <CollectionsGrid items={worklist.data?.items ?? []} loading={worklist.isLoading} error={worklist.isError ? 'Couldn’t load the collections worklist.' : null} onRetry={() => void worklist.refetch()} manage={manage} />
      ) : (
        <PaymentsGrid rows={payments.data?.payments ?? []} loading={payments.isLoading} error={payments.isError ? 'Couldn’t load payments.' : null} onRetry={() => void payments.refetch()} manage={manage} />
      )}
      {paying && <PaymentDialog open onOpenChange={(o) => !o && setPaying(null)} initialClientId={paying.clientId} rows={aging.data?.rows ?? []} statements={aging.data?.statements ?? []} />}
    </ListTemplate>
  );
}

/* ---- By client --------------------------------------------------------- */

function AgingGrid({
  rows,
  statements,
  reminders,
  manage,
  loading,
  error,
  onRetry,
  onPay,
}: {
  rows: ReceivablesAgingRow[];
  statements: ReceivableStatement[];
  reminders: CollectionItem[];
  manage: boolean;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onPay: ((clientId: string) => void) | null;
}) {
  const who = useWho();
  const bucketCol = (k: AgingBucketKey): GridColumn<ReceivablesAgingRow> => ({
    key: k,
    header: AGING_BUCKET_LABELS[k],
    accessor: (r) => r.buckets[k],
    csv: (r) => r.buckets[k].toFixed(2),
    sortable: true,
    searchable: false,
    align: 'right',
    className: 'tabular-nums',
    cell: (r) => (r.buckets[k] ? <span className={cn(k === 'over90' || k === 'days61to90' ? 'text-alert' : k !== 'current' ? 'text-warning' : 'text-ink')}>{money(r.buckets[k])}</span> : <span className="text-silver">—</span>),
  });
  const columns: GridColumn<ReceivablesAgingRow>[] = [
    { key: 'client', header: 'Client', accessor: (r) => r.clientName, sortable: true, primary: true, cell: (r) => <Link to={`/clients/${r.clientId}?tab=statements`} className="font-medium text-ink hover:text-gold hover:underline">{r.clientName}</Link> },
    ...AGING_BUCKET_KEYS.map(bucketCol),
    { key: 'open', header: 'Total owed', accessor: (r) => r.open, csv: (r) => r.open.toFixed(2), sortable: true, searchable: false, align: 'right', cardMeta: true, className: 'tabular-nums font-medium', cell: (r) => money(r.open) },
    {
      key: 'credit',
      header: 'Credit on file',
      accessor: (r) => r.unapplied,
      csv: (r) => r.unapplied.toFixed(2),
      searchable: false,
      align: 'right',
      defaultHidden: true,
      className: 'tabular-nums',
      cell: (r) => (r.unapplied ? <span className="text-success">{money(r.unapplied)}</span> : '—'),
    },
    ...(onPay
      ? [
          {
            key: 'actions',
            header: '',
            accessor: () => null,
            searchable: false,
            csv: () => '',
            align: 'right' as const,
            stopRowClick: true,
            cell: (r: ReceivablesAgingRow) => (
              <Button size="xs" variant="ghost" onClick={() => onPay(r.clientId)}>
                Record payment
              </Button>
            ),
          },
        ]
      : []),
  ];
  const byClient = useMemo(() => {
    const m = new Map<string, ReceivableStatement[]>();
    for (const s of statements) m.set(s.clientId, [...(m.get(s.clientId) ?? []), s]);
    return m;
  }, [statements]);
  return (
    <DataGrid
      id="books-receivables-aging"
      caption={`What ${who.many} owe, by age`}
      rows={rows}
      columns={columns}
      rowKey={(r) => r.clientId}
      loading={loading}
      error={error}
      onRetry={onRetry}
      noun={{ one: who.one, many: who.many }}
      exportCsv={{ filename: `receivables-aging-${ymdLocal()}` }}
      defaultSort={{ key: 'open', direction: 'desc' }}
      expandable={{
        label: (r) => `${r.clientName}’s open statements`,
        render: (r) => <StatementList statements={byClient.get(r.clientId) ?? []} reminders={reminders} manage={manage} />,
      }}
      empty={{ icon: HandCoins, title: 'Nothing owed', description: 'Every finalized statement is paid.' }}
      footnote="Days late count from each statement’s due date; a statement with no due date counts from the day it was finalized."
    />
  );
}

function StatementList({ statements, reminders, manage }: { statements: ReceivableStatement[]; reminders: CollectionItem[]; manage: boolean }) {
  const actions = useCollectionActions();
  const byId = new Map(reminders.map((r) => [r.statementId, r]));
  return (
    <>
    <ul className="divide-y divide-navy-secondary text-sm">
      {statements.map((s) => {
        const rem = byId.get(s.statementId);
        return (
        <li key={s.statementId} className="flex flex-wrap items-center justify-between gap-2 py-2">
          <span className="min-w-0">
            <span className="text-ink">Statement {fmtStatementNo(s.number, '')}</span>
            <span className="text-silver"> · {fmtDate(s.periodStart)} – {fmtDate(s.periodEnd)}</span>
            {rem && (
              <span className="block">
                <ReminderLine item={rem} />
              </span>
            )}
          </span>
          <span className="flex items-center gap-3 tabular-nums">
            <span className="text-xs text-silver">due {fmtDate(s.dueOn)}</span>
            {s.daysPastDue > 0 ? <Badge size="sm" variant={s.daysPastDue > 60 ? 'destructive' : 'pending'}>{s.daysPastDue} days late</Badge> : <Badge size="sm" variant="outline">Not yet due</Badge>}
            {s.applied > 0 && <span className="text-xs text-silver">{money(s.applied)} paid of {money(s.total)}</span>}
            <span className="font-medium text-ink">{money(s.open)}</span>
            {rem && manage && <CollectionActions item={rem} actions={actions} />}
          </span>
        </li>
        );
      })}
    </ul>
    {actions.promising && <PromiseDialog item={actions.promising} onClose={() => actions.setPromising(null)} onSaved={actions.refresh} />}
    </>
  );
}

/* ---- Payments ---------------------------------------------------------- */

function PaymentsGrid({ rows, loading, error, onRetry, manage }: { rows: ClientPaymentRow[]; loading: boolean; error: string | null; onRetry: () => void; manage: boolean }) {
  const who = useWho();
  const qc = useQueryClient();
  const prompt = usePrompt();
  const undo = async (p: ClientPaymentRow) => {
    const reason = await prompt({
      title: `Undo ${money(p.amount)} from ${p.clientName}?`,
      description: 'It comes off the books, and the statements it paid are open again.',
      reasonLabel: 'Why',
      reasonPlaceholder: 'The check bounced',
      confirmLabel: 'Undo payment',
      destructive: true,
    });
    if (!reason) return;
    try {
      await undoClientPayment(p.id, reason);
      toast.success('Payment undone — its statements are open again.');
      void qc.invalidateQueries({ queryKey: ['books'] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not undo the payment.');
    }
  };
  const columns: GridColumn<ClientPaymentRow>[] = [
    { key: 'date', header: 'Received', accessor: (p) => p.receivedOn, sortable: true, cardMeta: true, className: 'whitespace-nowrap tabular-nums', cell: (p) => fmtDate(p.receivedOn) },
    { key: 'client', header: who.One, accessor: (p) => p.clientName, sortable: true, primary: true },
    { key: 'method', header: 'How', accessor: (p) => CLIENT_PAYMENT_METHOD_LABELS[p.method] ?? p.method, sortable: true, cell: (p) => <span>{CLIENT_PAYMENT_METHOD_LABELS[p.method] ?? p.method}{p.reference ? <span className="text-silver"> · {p.reference}</span> : null}</span> },
    { key: 'deposit', header: 'Deposited to', accessor: (p) => p.depositAccount?.name ?? '', defaultHidden: true },
    {
      key: 'paid',
      header: 'Paid',
      accessor: (p) => p.applications.map((a) => a.number).join(' '),
      searchable: true,
      cell: (p) =>
        p.applications.length ? (
          <span className="text-sm text-silver">{p.applications.map((a) => fmtStatementNo(a.number)).join(', ')}</span>
        ) : (
          <span className="text-sm text-silver">Credit on account</span>
        ),
    },
    {
      key: 'amount',
      header: 'Amount',
      accessor: (p) => p.amount,
      csv: (p) => p.amount.toFixed(2),
      sortable: true,
      searchable: false,
      align: 'right',
      className: 'tabular-nums',
      cell: (p) => (
        <span className={cn(p.undone && 'text-silver line-through')}>
          {money(p.amount)}
          {p.unapplied > 0 && !p.undone && <span className="block text-2xs text-success no-underline">{money(p.unapplied)} unapplied</span>}
        </span>
      ),
    },
    ...(manage
      ? [
          {
            key: 'actions',
            header: '',
            accessor: () => null,
            searchable: false,
            csv: () => '',
            align: 'right' as const,
            stopRowClick: true,
            cell: (p: ClientPaymentRow) =>
              p.undone ? (
                <Badge size="sm" variant="outline">Undone</Badge>
              ) : (
                <Button size="xs" variant="ghost" onClick={() => void undo(p)}>
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                  Undo
                </Button>
              ),
          },
        ]
      : []),
  ];
  return (
    <DataGrid
      id="books-receivables-payments"
      caption={`${who.One} payments`}
      rows={rows}
      columns={columns}
      rowKey={(p) => p.id}
      loading={loading}
      error={error}
      onRetry={onRetry}
      noun={{ one: 'payment', many: 'payments' }}
      exportCsv={{ filename: `client-payments-${ymdLocal()}` }}
      defaultSort={{ key: 'date', direction: 'desc' }}
      empty={{ icon: HandCoins, title: 'No payments yet', description: 'Payments recorded here, or with “Mark paid” on a statement, land in the books and close the statements they pay.' }}
    />
  );
}
