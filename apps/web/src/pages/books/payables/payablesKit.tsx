import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from '@/components/ui/icons';
import type { BooksBill, BooksBillLineInput, BooksBillStatus, BooksVendorPaymentMethod } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth, useTenant, useTerm } from '@/lib/auth';
import { fmtDate, fmtMoney, ymdLocal } from '@/lib/format';
import { PAYABLES_KEY, payBills, payablesOptions } from '@/lib/books/payablesApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { toast } from '@/components/ui/Toaster';
import { useMoneyConfirm } from '@/components/payroll/MoneyConfirm';
import { cn } from '@/lib/cn';

/** Shared pieces of the payables pages: status words, pickers, the lines editor, the Pay dialog. */

export const money = (n: number) => fmtMoney(n);

const STATUS: Record<BooksBillStatus, { label: string; variant: 'default' | 'pending' | 'success' | 'destructive' | 'info' | 'accent' }> = {
  DRAFT: { label: 'Draft', variant: 'default' },
  PENDING_APPROVAL: { label: 'Waiting for approval', variant: 'pending' },
  APPROVED: { label: 'Approved · unpaid', variant: 'info' },
  PARTIALLY_PAID: { label: 'Partly paid', variant: 'accent' },
  PAID: { label: 'Paid', variant: 'success' },
  VOID: { label: 'Void', variant: 'destructive' },
};

export function billStatusLabel(s: string): string {
  return STATUS[s as BooksBillStatus]?.label ?? s;
}

export function BillStatusBadge({ bill, size }: { bill: Pick<BooksBill, 'status' | 'daysPastDue' | 'balance'>; size?: 'sm' }) {
  const s = STATUS[bill.status] ?? { label: bill.status, variant: 'default' as const };
  const overdue = (bill.status === 'APPROVED' || bill.status === 'PARTIALLY_PAID') && bill.daysPastDue > 0 && bill.balance > 0;
  return (
    <Badge size={size} variant={overdue ? 'destructive' : s.variant}>
      {overdue ? `${bill.daysPastDue} ${bill.daysPastDue === 1 ? 'day' : 'days'} late` : s.label}
    </Badge>
  );
}

/** "Due in 3 days", "Due today", "12 days late". */
export function dueWords(bill: Pick<BooksBill, 'dueDate' | 'daysPastDue' | 'status'>): string {
  if (bill.status === 'PAID' || bill.status === 'VOID') return `Due ${fmtDate(bill.dueDate)}`;
  if (bill.daysPastDue === 0) return 'Due today';
  if (bill.daysPastDue < 0) return `Due in ${-bill.daysPastDue} ${bill.daysPastDue === -1 ? 'day' : 'days'}`;
  return `${bill.daysPastDue} ${bill.daysPastDue === 1 ? 'day' : 'days'} late`;
}

export const METHOD_LABEL: Record<BooksVendorPaymentMethod, string> = { ACH: 'ACH', CHECK: 'Check', CARD: 'Card', OTHER: 'Other' };

export function useBooksWrite(): boolean {
  return useAuth().can('manage:books');
}

export function usePayablesOptions() {
  return useQuery({ queryKey: [...PAYABLES_KEY, 'options'], queryFn: payablesOptions, staleTime: 5 * 60_000 });
}

export function invalidatePayables(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: PAYABLES_KEY });
  void qc.invalidateQueries({ queryKey: ['inbox'] });
  void qc.invalidateQueries({ queryKey: ['approvals'] });
}

export const errText = (err: unknown, fallback: string) => (err instanceof ApiError || err instanceof Error ? err.message : fallback);

/* ---- The lines editor ----------------------------------------------------- */

export interface DraftLine {
  key: string;
  accountId: string;
  description: string;
  amount: string;
  clientId: string;
  siteId: string;
}

let lineSeq = 0;
export const blankLine = (accountId = ''): DraftLine => ({ key: `l${++lineSeq}`, accountId, description: '', amount: '', clientId: '', siteId: '' });

export function toLineInputs(lines: DraftLine[]): BooksBillLineInput[] {
  return lines
    .filter((l) => l.accountId && Number(l.amount) > 0)
    .map((l) => ({
      accountId: l.accountId,
      description: l.description.trim() || null,
      amount: Math.round(Number(l.amount) * 100) / 100,
      clientId: l.clientId || null,
      siteId: l.siteId || null,
    }));
}

export function linesTotal(lines: DraftLine[]): number {
  return Math.round(lines.reduce((s, l) => s + (Number(l.amount) > 0 ? Math.round(Number(l.amount) * 100) : 0), 0)) / 100;
}

/**
 * The bill's lines: what each part of it is for (the account), how much,
 * and — when it belongs to one — the client and site, so the cost lands on
 * that client's P&L. A live total underneath.
 */
export function LinesEditor({ lines, onChange, disabled }: { lines: DraftLine[]; onChange: (next: DraftLine[]) => void; disabled?: boolean }) {
  const opts = usePayablesOptions();
  const accounts = useMemo(() => opts.data?.accounts ?? [], [opts.data]);
  const clients = opts.data?.clients ?? [];
  const sites = opts.data?.sites ?? [];
  // A tenant with clients charges a line to a client (and its site); one
  // without picks a site of its own, in its own word for it.
  const hasClients = useTenant().moduleOn('clientPortal');
  const term = useTerm();
  const set = (key: string, patch: Partial<DraftLine>) => onChange(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const groups = useMemo(() => {
    const out = new Map<string, typeof accounts>();
    for (const a of accounts) {
      const g = a.type === 'EXPENSE' ? (a.subtype === 'COST_OF_SERVICES' ? 'Cost of services' : 'Expenses') : a.type === 'ASSET' ? 'Assets' : a.type === 'LIABILITY' ? 'Liabilities' : a.type === 'INCOME' ? 'Income' : 'Equity';
      out.set(g, [...(out.get(g) ?? []), a]);
    }
    return [...out.entries()];
  }, [accounts]);
  return (
    <div className="space-y-3">
      <ol className="space-y-3">
        {lines.map((l, i) => {
          // Every site belongs to a client, so the site picker can carry the
          // client: with no client chosen it lists every site, and picking
          // one sets both. ("Choose a client first" was a step for nothing.)
          const siteChoices = hasClients ? (l.clientId ? sites.filter((s) => s.clientId === l.clientId) : sites) : sites;
          return (
            <li key={l.key} className="rounded-lg border border-line p-3">
              <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] [&>*]:min-w-0">
                <Field label={`Line ${i + 1} — account`}>
                  {(p) => (
                    <Select value={l.accountId} onChange={(e) => set(l.key, { accountId: e.target.value })} disabled={disabled || opts.isPending} {...p}>
                      <option value="">{opts.isPending ? 'Getting the accounts…' : 'Choose what it’s for…'}</option>
                      {groups.map(([g, list]) => (
                        <optgroup key={g} label={g}>
                          {list.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.code} {a.name}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </Select>
                  )}
                </Field>
                <Field label="Amount">
                  {(p) => (
                    <Input type="number" inputMode="decimal" min="0" step="0.01" value={l.amount} onChange={(e) => set(l.key, { amount: e.target.value })} disabled={disabled} className="tabular-nums" {...p} />
                  )}
                </Field>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-3 [&>*]:min-w-0">
                <Field label="Description">{(p) => <Input value={l.description} maxLength={300} onChange={(e) => set(l.key, { description: e.target.value })} disabled={disabled} {...p} />}</Field>
                {hasClients && (
                  <Field label="Client" hint="Optional — charges it to that client’s P&L.">
                    {(p) => (
                      <Select value={l.clientId} onChange={(e) => set(l.key, { clientId: e.target.value, siteId: '' })} disabled={disabled} {...p}>
                        <option value="">Company</option>
                        {clients.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                )}
                <Field label={term('site')}>
                  {(p) => (
                    <Select
                      value={l.siteId}
                      onChange={(e) => {
                        const picked = sites.find((s) => s.id === e.target.value);
                        set(l.key, { siteId: e.target.value, ...(hasClients && picked?.clientId ? { clientId: picked.clientId } : {}) });
                      }}
                      disabled={disabled}
                      {...p}
                    >
                      <option value="">All</option>
                      {siteChoices.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              </div>
              {lines.length > 1 && !disabled && (
                <div className="mt-2 flex justify-end">
                  <Button type="button" size="sm" variant="ghost" onClick={() => onChange(lines.filter((x) => x.key !== l.key))}>
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                    Remove line {i + 1}
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {!disabled ? (
          <Button type="button" size="sm" variant="secondary" onClick={() => onChange([...lines, blankLine()])}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add a line
          </Button>
        ) : (
          <span />
        )}
        <p className="text-sm text-ink-muted">
          Total <span className="ml-1 text-base font-semibold tabular-nums text-ink">{money(linesTotal(lines))}</span>
        </p>
      </div>
    </div>
  );
}

/* ---- Paying bills --------------------------------------------------------- */

/**
 * Pay one vendor's open bills: how much of each (in full by default), how,
 * from which account and when. Over the company's own ACH when payroll
 * banking sends it and the vendor's bank is on file; otherwise it records a
 * payment made elsewhere.
 */
export function PayBillsDialog({
  open,
  onOpenChange,
  vendor,
  bills,
  onPaid,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  vendor: { id: string; name: string; hasBank: boolean; paymentMethod: BooksVendorPaymentMethod };
  bills: BooksBill[];
  onPaid?: () => void;
}) {
  const qc = useQueryClient();
  const confirmMoney = useMoneyConfirm();
  const opts = usePayablesOptions();
  const [method, setMethod] = useState<BooksVendorPaymentMethod>(vendor.paymentMethod);
  const [from, setFrom] = useState('');
  const [paidOn, setPaidOn] = useState(ymdLocal());
  const [reference, setReference] = useState('');
  const [checkNumber, setCheckNumber] = useState('');
  const [sendAch, setSendAch] = useState(false);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!open) return;
    setAmounts(Object.fromEntries(bills.map((b) => [b.id, b.balance.toFixed(2)])));
    setMethod(vendor.paymentMethod);
  }, [open, bills, vendor.paymentMethod]);
  const payFrom = (opts.data?.payFrom ?? []).filter((a) => (method === 'CARD' ? a.subtype === 'CREDIT_CARD' : a.subtype === 'BANK'));
  useEffect(() => {
    if (!payFrom.some((a) => a.id === from)) setFrom(payFrom[0]?.id ?? '');
  }, [payFrom, from]);
  const canAch = !!opts.data?.ownAch && method === 'ACH' && vendor.hasBank;
  useEffect(() => setSendAch(canAch), [canAch]);
  const apps = bills.map((b) => ({ billId: b.id, amount: Math.round(Number(amounts[b.id] ?? 0) * 100) / 100 })).filter((a) => a.amount > 0);
  const total = Math.round(apps.reduce((s, a) => s + a.amount * 100, 0)) / 100;
  const over = bills.find((b) => Number(amounts[b.id] ?? 0) > b.balance + 0.0001);
  const pay = useMutation({
    mutationFn: () =>
      payBills({
        vendorId: vendor.id,
        paidOn,
        method,
        bankAccountId: from,
        reference: reference.trim() || null,
        checkNumber: method === 'CHECK' && checkNumber ? Number(checkNumber) : null,
        sendAch: canAch && sendAch,
        applications: apps,
      }),
    onSuccess: (r) => {
      toast.success(r.payment.achFileId ? `${money(r.payment.amount)} to ${vendor.name} is in an ACH file for the bank.` : `${money(r.payment.amount)} to ${vendor.name} recorded.`);
      invalidatePayables(qc);
      onOpenChange(false);
      onPaid?.();
    },
    onError: (err) => toast.error(errText(err, 'Could not record the payment.')),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Pay {vendor.name}</DialogTitle>
          <DialogDescription>
            {bills.length === 1 ? 'One bill' : `${bills.length} bills`}, paid in full unless you change an amount. The payment comes off the books’ payables and out of the account you choose.
          </DialogDescription>
        </DialogHeader>
        <ul className="divide-y divide-line rounded-lg border border-line">
          {bills.map((b) => (
            <li key={b.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 text-sm">
              <span className="min-w-0">
                <span className="block font-medium text-ink">{b.billNumber ? `Invoice ${b.billNumber}` : `Bill of ${fmtDate(b.billDate)}`}</span>
                <span className="block text-xs text-ink-muted">
                  {money(b.balance)} owed · {dueWords(b)}
                </span>
              </span>
              <Input
                aria-label={`Amount for ${b.billNumber ?? fmtDate(b.billDate)}`}
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                value={amounts[b.id] ?? ''}
                onChange={(e) => setAmounts((a) => ({ ...a, [b.id]: e.target.value }))}
                className={cn('w-32 text-right tabular-nums', Number(amounts[b.id] ?? 0) > b.balance + 0.0001 && 'border-alert')}
              />
            </li>
          ))}
        </ul>
        <div className="grid gap-3 sm:grid-cols-2 [&>*]:min-w-0">
          <Field label="How">
            {(p) => (
              <Select value={method} onChange={(e) => setMethod(e.target.value as BooksVendorPaymentMethod)} {...p}>
                <option value="ACH">ACH (bank transfer)</option>
                <option value="CHECK">Check</option>
                <option value="CARD">Company card</option>
                <option value="OTHER">Other</option>
              </Select>
            )}
          </Field>
          <Field label={method === 'CARD' ? 'From card' : 'From account'}>
            {(p) => (
              <Select value={from} onChange={(e) => setFrom(e.target.value)} {...p}>
                {payFrom.length === 0 && <option value="">{method === 'CARD' ? 'No card account on the books' : 'No bank account on the books'}</option>}
                {payFrom.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} {a.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Paid on">{(p) => <Input type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} {...p} />}</Field>
          {method === 'CHECK' ? (
            <Field label="Check number">{(p) => <Input type="number" inputMode="numeric" min="1" value={checkNumber} onChange={(e) => setCheckNumber(e.target.value)} {...p} />}</Field>
          ) : (
            <Field label="Reference" hint="Optional — what the bank or vendor calls it.">
              {(p) => <Input value={reference} maxLength={80} onChange={(e) => setReference(e.target.value)} {...p} />}
            </Field>
          )}
        </div>
        {method === 'ACH' && (
          <div className="rounded-lg border border-line bg-surface-raised p-3 text-sm">
            {canAch ? (
              <label className="flex cursor-pointer items-start gap-3">
                <input type="checkbox" className="mt-0.5 h-4 w-4 accent-gold" checked={sendAch} onChange={(e) => setSendAch(e.target.checked)} />
                <span>
                  <span className="block font-medium text-ink">Send it over the company’s ACH</span>
                  <span className="block text-ink-muted">An ACH credit to {vendor.name}’s bank goes in today’s file. Leave this off if you already paid from the bank’s own site.</span>
                </span>
              </label>
            ) : (
              <p className="text-ink-muted">
                {!opts.data?.ownAch
                  ? 'Payroll banking isn’t sending its own ACH, so this records an ACH you send from the bank.'
                  : `${vendor.name} has no bank details on file, so this records an ACH you send from the bank.`}
              </p>
            )}
          </div>
        )}
        <DialogFooter className="items-center sm:justify-between">
          <p className="text-sm text-ink-muted">
            Total <span className="ml-1 text-base font-semibold tabular-nums text-ink">{money(total)}</span>
          </p>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              onClick={async () => {
                // One click never moves money (deep audit MONEY-10/21): the amount, the account and the day, first.
                const acct = payFrom.find((a) => a.id === from);
                const sending = canAch && sendAch;
                if (
                  !(await confirmMoney({
                    title: sending ? `Send ${money(total)} to ${vendor.name}?` : `Record ${money(total)} paid to ${vendor.name}?`,
                    amount: total,
                    from: acct ? `${acct.code} ${acct.name}` : null,
                    to: vendor.name,
                    when: sending ? `In today’s ACH file · paid ${fmtDate(paidOn)}` : `Paid ${fmtDate(paidOn)}`,
                    confirmLabel: sending ? `Send ${money(total)}` : `Record ${money(total)}`,
                  }))
                )
                  return;
                pay.mutate();
              }}
              loading={pay.isPending}
              disabled={apps.length === 0 || !from || !!over || !paidOn}
            >
              {canAch && sendAch ? `Send ${money(total)}` : `Record ${money(total)}`}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
