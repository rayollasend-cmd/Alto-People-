import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HandCoins, History, Plus, RotateCcw } from 'lucide-react';
import {
  AGING_BUCKET_KEYS,
  AGING_BUCKET_LABELS,
  CLIENT_PAYMENT_METHOD_LABELS,
  CLIENT_PAYMENT_METHODS,
  type AgingBucketKey,
  type ClientPaymentMethodKind,
  type ClientPaymentRow,
  type ReceivableStatement,
  type ReceivablesAgingRow,
} from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth, useTenant } from '@/lib/auth';
import { usePrompt } from '@/lib/confirm';
import { fmtDate, fmtMoney, ymdLocal } from '@/lib/format';
import { cn } from '@/lib/cn';
import {
  RECEIVABLES_KEY,
  autoApply,
  backfillPosting,
  getReceivablesAging,
  listClientPayments,
  listDepositAccounts,
  recordClientPayment,
  undoClientPayment,
} from '@/lib/books/receivablesApi';
import { ListTemplate } from '@/components/templates';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { MetricCard } from '@/components/ui/MetricCard';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
import { toast } from '@/components/ui/Toaster';

/**
 * Receivables: what clients owe, by how late (the aging), the money they
 * paid and the statements it paid, and the catch-up that posts history to
 * the books. Contract: packages/shared/src/books/receivables.ts.
 */

type View = 'aging' | 'payments';
const money = (n: number) => fmtMoney(n, { precise: true });
const cents = (n: number) => Math.round(n * 100);


/** Who owes the money in this tenant's words: clients for a staffing company, customers otherwise. */
function useWho() {
  const has = useTenant().moduleOn('clientPortal');
  return has
    ? { one: 'client', many: 'clients', One: 'Client', Many: 'Clients' }
    : { one: 'customer', many: 'customers', One: 'Customer', Many: 'Customers' };
}

export function ReceivablesPage() {
  const who = useWho();
  const { can } = useAuth();
  const manage = can('manage:books');
  const qc = useQueryClient();
  const [view, setView] = useState<View>('aging');
  const [paying, setPaying] = useState<{ clientId: string | null } | null>(null);
  const aging = useQuery({ queryKey: [...RECEIVABLES_KEY, 'aging'], queryFn: () => getReceivablesAging() });
  const payments = useQuery({ queryKey: [...RECEIVABLES_KEY, 'payments'], queryFn: () => listClientPayments(), enabled: view === 'payments' });

  const backfill = useMutation({
    mutationFn: () => backfillPosting(),
    onSuccess: (r) => {
      const posted = r.payrollRuns + r.statements + r.taxPayments + r.taxDeposits + r.garnishmentRemittances + r.wageAdvances;
      const parts = [
        r.payrollRuns && `${r.payrollRuns} payroll ${r.payrollRuns === 1 ? 'run' : 'runs'}`,
        r.statements && `${r.statements} ${r.statements === 1 ? 'statement' : 'statements'}`,
        r.taxPayments + r.taxDeposits && `${r.taxPayments + r.taxDeposits} tax ${r.taxPayments + r.taxDeposits === 1 ? 'payment' : 'payments'}`,
        r.garnishmentRemittances && `${r.garnishmentRemittances} garnishment ${r.garnishmentRemittances === 1 ? 'payment' : 'payments'}`,
        r.wageAdvances && `${r.wageAdvances} wage ${r.wageAdvances === 1 ? 'advance' : 'advances'}`,
      ].filter(Boolean);
      if (posted === 0 && r.failed.length === 0) toast.success('The books already hold everything — nothing to post.');
      else toast.success(`Posted ${parts.join(', ')}.${r.failed.length ? ` ${r.failed.length} couldn’t post: ${r.failed[0]!.error}` : ''}`);
      void qc.invalidateQueries({ queryKey: ['books'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not post history.'),
  });

  const totals = aging.data?.totals;
  const late = totals ? totals.open - totals.buckets.current : 0;
  const over60 = totals ? totals.buckets.days61to90 + totals.buckets.over90 : 0;

  return (
    <ListTemplate
      title="Receivables"
      topbarTitle="Receivables"
      subtitle={`What ${who.many} owe, how late it is, and the money they’ve paid.`}
      breadcrumbs={[{ label: 'Books', to: '/books' }, { label: 'Receivables' }]}
      primaryAction={
        manage ? (
          <Button onClick={() => setPaying({ clientId: null })}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Record a payment
          </Button>
        ) : undefined
      }
      secondaryActions={
        manage ? (
          <Button variant="secondary" loading={backfill.isPending} onClick={() => backfill.mutate()} title="Post every payroll run, statement and payment the books don’t hold yet">
            <History className="h-4 w-4" aria-hidden="true" />
            Post history
          </Button>
        ) : undefined
      }
      summary={
        <div className="grid gap-3 sm:grid-cols-3">
          <MetricCard label="Owed to you" value={totals ? money(totals.open) : '—'} hint={aging.data ? `${aging.data.statements.length} open ${aging.data.statements.length === 1 ? 'statement' : 'statements'}` : undefined} />
          <MetricCard label="Past due" value={totals ? money(late) : '—'} hint={totals && totals.open ? `${Math.round((late / totals.open) * 100)}% of what’s owed` : 'nothing late'} accent={late > 0} />
          <MetricCard label="Over 60 days" value={totals ? money(over60) : '—'} hint={over60 > 0 ? 'call these first' : 'none'} accent={over60 > 0} />
        </div>
      }
      filters={
        <SegmentedControl
          ariaLabel="Receivables view"
          value={view}
          onChange={setView}
          options={[
            { value: 'aging', label: `By ${who.one}` },
            { value: 'payments', label: 'Payments' },
          ]}
        />
      }
    >
      {view === 'aging' ? (
        <AgingGrid rows={aging.data?.rows ?? []} statements={aging.data?.statements ?? []} loading={aging.isLoading} error={aging.isError ? `Couldn’t load what ${who.many} owe.` : null} onRetry={() => void aging.refetch()} onPay={manage ? (clientId) => setPaying({ clientId }) : null} />
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
  loading,
  error,
  onRetry,
  onPay,
}: {
  rows: ReceivablesAgingRow[];
  statements: ReceivableStatement[];
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
        render: (r) => <StatementList statements={byClient.get(r.clientId) ?? []} />,
      }}
      empty={{ icon: HandCoins, title: 'Nothing owed', description: 'Every finalized statement is paid.' }}
      footnote="Days late count from each statement’s due date; a statement with no due date counts from the day it was finalized."
    />
  );
}

function StatementList({ statements }: { statements: ReceivableStatement[] }) {
  return (
    <ul className="divide-y divide-navy-secondary text-sm">
      {statements.map((s) => (
        <li key={s.statementId} className="flex flex-wrap items-center justify-between gap-2 py-2">
          <span className="min-w-0">
            <span className="text-ink">Statement {s.number !== null ? `No. ${String(s.number).padStart(4, '0')}` : ''}</span>
            <span className="text-silver"> · {fmtDate(s.periodStart)} – {fmtDate(s.periodEnd)}</span>
          </span>
          <span className="flex items-center gap-3 tabular-nums">
            <span className="text-xs text-silver">due {fmtDate(s.dueOn)}</span>
            {s.daysPastDue > 0 ? <Badge size="sm" variant={s.daysPastDue > 60 ? 'destructive' : 'pending'}>{s.daysPastDue} days late</Badge> : <Badge size="sm" variant="outline">Not yet due</Badge>}
            {s.applied > 0 && <span className="text-xs text-silver">{money(s.applied)} paid of {money(s.total)}</span>}
            <span className="font-medium text-ink">{money(s.open)}</span>
          </span>
        </li>
      ))}
    </ul>
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
          <span className="text-sm text-silver">{p.applications.map((a) => `No. ${a.number !== null ? String(a.number).padStart(4, '0') : '—'}`).join(', ')}</span>
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

/* ---- Record a payment -------------------------------------------------- */

function PaymentDialog({
  open,
  onOpenChange,
  initialClientId,
  rows,
  statements,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  initialClientId: string | null;
  rows: ReceivablesAgingRow[];
  statements: ReceivableStatement[];
}) {
  const who = useWho();
  const qc = useQueryClient();
  const accounts = useQuery({ queryKey: [...RECEIVABLES_KEY, 'deposit-accounts'], queryFn: listDepositAccounts, staleTime: 5 * 60_000 });
  const [clientId, setClientId] = useState(initialClientId ?? rows[0]?.clientId ?? '');
  const [amount, setAmount] = useState('');
  const [receivedOn, setReceivedOn] = useState(ymdLocal());
  const [method, setMethod] = useState<ClientPaymentMethodKind>('ACH');
  const [reference, setReference] = useState('');
  const [depositId, setDepositId] = useState('');
  const [applied, setApplied] = useState<Record<string, number>>({});
  const [touched, setTouched] = useState(false);
  const open$ = useMemo(() => statements.filter((s) => s.clientId === clientId).sort((a, b) => a.dueOn.localeCompare(b.dueOn)), [statements, clientId]);
  const amountCents = cents(Number(amount) || 0);

  // Oldest first, until someone picks by hand.
  useEffect(() => {
    if (!touched) setApplied(autoApply(open$, amountCents));
  }, [open$, amountCents, touched]);
  // The deposit account follows the method until chosen.
  const defaultDeposit = accounts.data?.accounts.find((a) => (method === 'CHECK' ? a.forChecks : a.isDefault))?.id ?? '';
  const deposit = depositId || defaultDeposit;

  const appliedTotal = Object.values(applied).reduce((s, n) => s + n, 0);
  const over = appliedTotal > amountCents;
  const save = useMutation({
    mutationFn: () =>
      recordClientPayment({
        clientId,
        receivedOn,
        amount: amountCents / 100,
        method,
        reference: reference.trim() || null,
        depositAccountId: deposit || null,
        applications: Object.entries(applied)
          .filter(([, c]) => c > 0)
          .map(([statementId, c]) => ({ statementId, amount: c / 100 })),
      }),
    onSuccess: (r) => {
      toast.success(`${money(r.payment.amount)} from ${r.payment.clientName} recorded${r.payment.unapplied ? ` — ${money(r.payment.unapplied)} held as credit` : ''}.`);
      void qc.invalidateQueries({ queryKey: ['books'] });
      onOpenChange(false);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not record the payment.'),
  });
  const toggle = (s: ReceivableStatement, on: boolean) => {
    setTouched(true);
    setApplied((cur) => {
      const next = { ...cur };
      if (on) next[s.statementId] = Math.min(cents(s.open), Math.max(0, amountCents - (appliedTotal - (cur[s.statementId] ?? 0)))) || cents(s.open);
      else delete next[s.statementId];
      return next;
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Record a payment</DialogTitle>
          <DialogDescription>It goes into the books and closes the statements it pays in full. Anything not applied stays as credit on the {who.one}’s account.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={who.One} className="sm:col-span-2">
            {(p) => (
              <Select value={clientId} onChange={(e) => { setClientId(e.target.value); setTouched(false); }} {...p}>
                {rows.length === 0 && <option value="">No {who.one} owes anything</option>}
                {rows.map((r) => (
                  <option key={r.clientId} value={r.clientId}>
                    {r.clientName} — {money(r.open)} owed
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Amount received">{(p) => <Input inputMode="decimal" value={amount} placeholder="0.00" onChange={(e) => { setAmount(e.target.value.replace(/[^0-9.]/g, '')); setTouched(false); }} {...p} />}</Field>
          <Field label="Received on">{(p) => <Input type="date" value={receivedOn} max={ymdLocal()} onChange={(e) => setReceivedOn(e.target.value)} {...p} />}</Field>
          <Field label="How">
            {(p) => (
              <Select value={method} onChange={(e) => setMethod(e.target.value as ClientPaymentMethodKind)} {...p}>
                {CLIENT_PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {CLIENT_PAYMENT_METHOD_LABELS[m]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Reference" hint="Check number, ACH trace, wire confirmation">{(p) => <Input value={reference} maxLength={80} onChange={(e) => setReference(e.target.value)} {...p} />}</Field>
          <Field label="Deposited to" className="sm:col-span-2" hint={method === 'CHECK' ? 'A check waits in Undeposited funds until it’s banked.' : undefined}>
            {(p) => (
              <Select value={deposit} onChange={(e) => setDepositId(e.target.value)} disabled={accounts.isLoading} {...p}>
                {(accounts.data?.accounts ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} · {a.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <fieldset className="mt-1 space-y-2">
          <legend className="text-sm font-medium text-ink">Statements it pays</legend>
          {open$.length === 0 ? (
            <p className="text-sm text-silver">This {who.one} has no open statements — the payment is credit on their account.</p>
          ) : (
            <ul className="max-h-64 divide-y divide-navy-secondary overflow-y-auto rounded-lg border border-navy-secondary">
              {open$.map((s) => {
                const on = (applied[s.statementId] ?? 0) > 0;
                return (
                  <li key={s.statementId} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <input type="checkbox" className="h-4 w-4 accent-gold" checked={on} onChange={(e) => toggle(s, e.target.checked)} aria-label={`Pay statement ${s.number ?? ''}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-ink">No. {s.number !== null ? String(s.number).padStart(4, '0') : '—'} · {fmtDate(s.periodStart)} – {fmtDate(s.periodEnd)}</span>
                      <span className="block text-xs text-silver">
                        {money(s.open)} open · due {fmtDate(s.dueOn)}
                        {s.daysPastDue > 0 ? ` · ${s.daysPastDue} days late` : ''}
                      </span>
                    </span>
                    <Input
                      className="w-28 text-right tabular-nums"
                      inputMode="decimal"
                      aria-label={`Amount for statement ${s.number ?? ''}`}
                      value={on ? ((applied[s.statementId] ?? 0) / 100).toFixed(2) : ''}
                      placeholder="0.00"
                      onChange={(e) => {
                        setTouched(true);
                        const c = Math.min(cents(Number(e.target.value.replace(/[^0-9.]/g, '')) || 0), cents(s.open));
                        setApplied((cur) => ({ ...cur, [s.statementId]: c }));
                      }}
                    />
                  </li>
                );
              })}
            </ul>
          )}
          <p className={cn('text-xs tabular-nums', over ? 'text-alert' : 'text-silver')}>
            {over
              ? `The statements add up to ${money(appliedTotal / 100)} — more than the ${money(amountCents / 100)} received.`
              : `${money(appliedTotal / 100)} applied${amountCents > appliedTotal ? ` · ${money((amountCents - appliedTotal) / 100)} as credit` : ''}`}
          </p>
        </fieldset>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!clientId || amountCents <= 0 || over || !deposit}>
            Record {amountCents > 0 ? money(amountCents / 100) : 'payment'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
