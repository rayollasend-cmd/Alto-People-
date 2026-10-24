import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Landmark } from '@/components/ui/icons';
import {
  CLIENT_PAYMENT_METHOD_LABELS,
  CLIENT_PAYMENT_METHODS,
  type BankTxnView,
  type ClientPaymentMethodKind,
  type ClientPaymentRow,
  type ReceivableStatement,
  type ReceivablesAgingRow,
} from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useTenant } from '@/lib/auth';
import { fmtDate, fmtMoney, fmtStatementNo, ymdLocal } from '@/lib/format';
import { cn } from '@/lib/cn';
import { RECEIVABLES_KEY, autoApply, listDepositAccounts, recordClientPayment } from '@/lib/books/receivablesApi';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { toast } from '@/components/ui/Toaster';

/**
 * Receivables pieces shared with the bank review: the payment dialog (from
 * Receivables, or prefilled from a bank deposit — "Record as payment from …"
 * — which matches the deposit once it's recorded) and the tenant's word for
 * who pays.
 */

const money = (n: number) => fmtMoney(n, { precise: true });
const cents = (n: number) => Math.round(n * 100);

/** Who owes the money in this tenant's words: clients for a staffing company, customers otherwise. */
export function useWho() {
  const has = useTenant().moduleOn('clientPortal');
  return has
    ? { one: 'client', many: 'clients', One: 'Client', Many: 'Clients' }
    : { one: 'customer', many: 'customers', One: 'Customer', Many: 'Customers' };
}

/** A bank deposit the payment is: its amount, date and account are fixed; it's matched once recorded. */
export interface DepositSeed {
  transaction: BankTxnView;
  /** The deposit's bank account in the books. */
  ledgerAccountId: string;
  ledgerLabel: string;
}

export function PaymentDialog({
  open,
  onOpenChange,
  initialClientId,
  rows,
  statements,
  deposit: fromDeposit,
  extraClient,
  initialStatementId,
  onRecorded,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  initialClientId: string | null;
  rows: ReceivablesAgingRow[];
  statements: ReceivableStatement[];
  deposit?: DepositSeed;
  /** Someone to offer even with nothing owed (a deposit's likely payer): their payment is held as credit. */
  extraClient?: { id: string; name: string } | null;
  /** Start on one statement (the statement week close's "Record payment"): its open balance, applied to it. */
  initialStatementId?: string | null;
  onRecorded?: (r: { payment: ClientPaymentRow; bankTransaction?: BankTxnView | null; depositMatched?: boolean }) => void;
}) {
  const who = useWho();
  const qc = useQueryClient();
  const accounts = useQuery({ queryKey: [...RECEIVABLES_KEY, 'deposit-accounts'], queryFn: listDepositAccounts, staleTime: 5 * 60_000 });
  const seed = fromDeposit?.transaction;
  // From a deposit nobody is assumed: the likely payer, or a choice — never just whoever owes the most.
  const [clientId, setClientId] = useState(initialClientId ?? (fromDeposit ? '' : (rows[0]?.clientId ?? '')));
  const choices = useMemo(
    () => (extraClient && !rows.some((r) => r.clientId === extraClient.id) ? [...rows.map((r) => ({ id: r.clientId, name: r.clientName, open: r.open })), { id: extraClient.id, name: extraClient.name, open: 0 }] : rows.map((r) => ({ id: r.clientId, name: r.clientName, open: r.open }))),
    [rows, extraClient],
  );
  const startOn = initialStatementId ? statements.find((s) => s.statementId === initialStatementId) : undefined;
  const [amount, setAmount] = useState(seed ? seed.amount.toFixed(2) : startOn ? startOn.open.toFixed(2) : '');
  const [receivedOn, setReceivedOn] = useState(seed?.postedOn ?? ymdLocal());
  const [method, setMethod] = useState<ClientPaymentMethodKind>('ACH');
  const [reference, setReference] = useState(seed?.reference ?? '');
  const [depositId, setDepositId] = useState('');
  const [applied, setApplied] = useState<Record<string, number>>(startOn ? { [startOn.statementId]: cents(startOn.open) } : {});
  const [touched, setTouched] = useState(!!startOn);
  const open$ = useMemo(() => statements.filter((s) => s.clientId === clientId).sort((a, b) => a.dueOn.localeCompare(b.dueOn)), [statements, clientId]);
  const amountCents = cents(Number(amount) || 0);

  // Oldest first, until someone picks by hand.
  useEffect(() => {
    if (!touched) setApplied(autoApply(open$, amountCents));
  }, [open$, amountCents, touched]);
  // The deposit account follows the method until chosen.
  const defaultDeposit = accounts.data?.accounts.find((a) => (method === 'CHECK' ? a.forChecks : a.isDefault))?.id ?? '';
  const deposit = fromDeposit?.ledgerAccountId ?? (depositId || defaultDeposit);
  const owed = rows.find((r) => r.clientId === clientId)?.open ?? 0;
  const fullBalance = owed > 0 && amountCents !== cents(owed);

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
        ...(seed ? { bankTransactionId: seed.id } : {}),
        applications: Object.entries(applied)
          .filter(([, c]) => c > 0)
          .map(([statementId, c]) => ({ statementId, amount: c / 100 })),
      }),
    onSuccess: (r) => {
      const matched = r.depositMatched ?? r.bankTransaction?.status === 'MATCHED';
      const tail = seed ? (matched ? ' and the deposit matched to it' : ' — the deposit wasn’t matched; check it') : '';
      toast.success(`${money(r.payment.amount)} from ${r.payment.clientName} recorded${r.payment.unapplied ? ` — ${money(r.payment.unapplied)} held as credit` : ''}${tail}.`);
      void qc.invalidateQueries({ queryKey: ['books'] });
      onRecorded?.(r);
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
          <DialogTitle>{seed ? 'Record the deposit as a payment' : 'Record a payment'}</DialogTitle>
          <DialogDescription>
            {seed ? 'It goes into the books, closes the statements it pays in full, and the deposit is matched to it — typed once.' : 'It goes into the books and closes the statements it pays in full.'} Anything not applied stays as credit on the {who.one}’s account.
          </DialogDescription>
        </DialogHeader>
        {seed && fromDeposit && (
          <p className="flex items-start gap-2 rounded-lg border border-line bg-surface-raised px-3 py-2 text-sm text-ink">
            <Landmark className="mt-0.5 h-4 w-4 shrink-0 text-gold" aria-hidden="true" />
            <span className="min-w-0">
              <span className="block truncate">
                {seed.payee ? `${seed.payee} — ` : ''}
                {seed.description}
              </span>
              <span className="block text-xs text-silver">
                {money(seed.amount)} into {fromDeposit.ledgerLabel} · {fmtDate(seed.postedOn)}
              </span>
            </span>
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={who.One} className="sm:col-span-2">
            {(p) => (
              <Select value={clientId} onChange={(e) => { setClientId(e.target.value); setTouched(false); }} {...p}>
                {(fromDeposit || !clientId) && <option value="">{choices.length === 0 ? `No ${who.one} owes anything` : `Choose who paid…`}</option>}
                {choices.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} — {r.open > 0 ? `${money(r.open)} owed` : 'nothing owed (held as credit)'}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Amount received" hint={seed ? 'The deposit’s amount.' : undefined}>
            {(p) => <Input inputMode="decimal" value={amount} placeholder="0.00" readOnly={!!seed} onChange={(e) => { setAmount(e.target.value.replace(/[^0-9.]/g, '')); setTouched(false); }} {...p} />}
          </Field>
          <Field label="Received on">{(p) => <Input type="date" value={receivedOn} max={ymdLocal()} readOnly={!!seed} onChange={(e) => setReceivedOn(e.target.value)} {...p} />}</Field>
          {!seed && fullBalance && (
            <div className="-mt-1 sm:col-span-2">
              <Button
                type="button"
                size="xs"
                variant="secondary"
                onClick={() => {
                  setAmount(owed.toFixed(2));
                  setTouched(false);
                }}
              >
                Full balance · {money(owed)}
              </Button>
            </div>
          )}
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
          {!fromDeposit && (
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
          )}
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
                      <span className="block text-ink">{fmtStatementNo(s.number, 'Draft')} · {fmtDate(s.periodStart)} – {fmtDate(s.periodEnd)}</span>
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
