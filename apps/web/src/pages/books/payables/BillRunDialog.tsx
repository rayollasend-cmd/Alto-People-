import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BooksBill, BooksVendorPaymentMethod } from '@alto-people/shared';
import { fmtDate, ymdLocal } from '@/lib/format';
import { cn } from '@/lib/cn';
import { PAYABLES_KEY, listBills, listVendors, payBillsBatch } from '@/lib/books/payablesApi';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { toast } from '@/components/ui/Toaster';
import { errText, invalidatePayables, money, usePayablesOptions } from './payablesKit';

/**
 * Finance walk 8 — pay several vendors in one bill run: every approved bill
 * due by a date (or the bills picked on the grid), grouped by vendor, each
 * vendor in or out with one tick; one method, account and date for the run;
 * the total, and the cash left afterwards. One request: every vendor's
 * payment lands, or none does.
 */

/** This Friday (or today, on a Friday) — when a bill run usually goes out. */
export function nextFriday(today: string = ymdLocal()): string {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + ((5 - d.getUTCDay() + 7) % 7));
  return d.toISOString().slice(0, 10);
}

const payable = (b: BooksBill) => (b.status === 'APPROVED' || b.status === 'PARTIALLY_PAID') && b.balance > 0;

export function BillRunDialog({ open, onOpenChange, preselected }: { open: boolean; onOpenChange: (o: boolean) => void; preselected?: BooksBill[] }) {
  const qc = useQueryClient();
  const opts = usePayablesOptions();
  const [dueBy, setDueBy] = useState(nextFriday());
  const [method, setMethod] = useState<BooksVendorPaymentMethod>('ACH');
  const [from, setFrom] = useState('');
  const [paidOn, setPaidOn] = useState(ymdLocal());
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const unpaid = useQuery({ queryKey: [...PAYABLES_KEY, 'bills', 'unpaid'], queryFn: () => listBills({ tab: 'unpaid' }), enabled: open && !preselected });
  const vendors = useQuery({ queryKey: [...PAYABLES_KEY, 'vendors', 'all'], queryFn: () => listVendors({ active: 'all' }), enabled: open });
  useEffect(() => {
    if (open) setSkipped(new Set());
  }, [open, dueBy]);

  const bills = useMemo(() => (preselected ?? (unpaid.data?.bills ?? []).filter((b) => b.dueDate <= dueBy)).filter(payable), [preselected, unpaid.data, dueBy]);
  const groups = useMemo(() => {
    const m = new Map<string, { vendorId: string; vendorName: string; bills: BooksBill[]; total: number }>();
    for (const b of bills) {
      const g = m.get(b.vendorId) ?? { vendorId: b.vendorId, vendorName: b.vendorName, bills: [], total: 0 };
      g.bills.push(b);
      g.total = Math.round((g.total + b.balance) * 100) / 100;
      m.set(b.vendorId, g);
    }
    return [...m.values()].sort((a, b) => a.vendorName.localeCompare(b.vendorName));
  }, [bills]);
  const included = groups.filter((g) => !skipped.has(g.vendorId));
  // The total is the sum of the vendor rows shown as included.
  const total = Math.round(included.reduce((s, g) => s + g.total * 100, 0)) / 100;
  const cash = opts.data?.cashOnHand ?? null;
  const left = cash === null ? null : Math.round((cash - total) * 100) / 100;
  const vendorById = new Map((vendors.data?.vendors ?? []).map((v) => [v.id, v]));
  const payFrom = (opts.data?.payFrom ?? []).filter((a) => (method === 'CARD' ? a.subtype === 'CREDIT_CARD' : a.subtype === 'BANK'));
  useEffect(() => {
    if (!payFrom.some((a) => a.id === from)) setFrom(payFrom[0]?.id ?? '');
  }, [payFrom, from]);
  const canAch = !!opts.data?.ownAch && method === 'ACH' && included.length > 0 && included.every((g) => vendorById.get(g.vendorId)?.hasBank);

  const run = useMutation({
    mutationFn: () =>
      payBillsBatch({
        paidOn,
        method,
        bankAccountId: from,
        sendAch: canAch,
        vendors: included.map((g) => ({ vendorId: g.vendorId, applications: g.bills.map((b) => ({ billId: b.id, amount: b.balance })) })),
      }),
    onSuccess: (r) => {
      toast.success(`${r.payments.length} ${r.payments.length === 1 ? 'vendor' : 'vendors'} paid — ${money(r.payments.reduce((s, p) => s + p.amount, 0))}${r.cashAfter !== null ? `; ${money(r.cashAfter)} left in the bank` : ''}.`);
      invalidatePayables(qc);
      void qc.invalidateQueries({ queryKey: ['books'] });
      onOpenChange(false);
    },
    onError: (err) => toast.error(errText(err, 'The run didn’t go through — nothing was paid.')),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{preselected ? `Pay ${groups.length} ${groups.length === 1 ? 'vendor' : 'vendors'}` : 'Pay bills due'}</DialogTitle>
          <DialogDescription>Every bill paid in full, one payment per vendor, in one run — it all goes through or none of it does.</DialogDescription>
        </DialogHeader>
        {!preselected && (
          <Field label="Pay bills due by">{(p) => <Input type="date" value={dueBy} onChange={(e) => setDueBy(e.target.value)} className="w-44" {...p} />}</Field>
        )}
        {groups.length === 0 ? (
          <p className="rounded-lg border border-line px-3 py-6 text-center text-sm text-ink-muted">{unpaid.isLoading ? 'Loading the bills…' : `No approved bill is due by ${fmtDate(dueBy)}.`}</p>
        ) : (
          <ul className="max-h-72 divide-y divide-line overflow-y-auto rounded-lg border border-line" aria-label="Vendors in this run">
            {groups.map((g) => {
              const on = !skipped.has(g.vendorId);
              const v = vendorById.get(g.vendorId);
              return (
                <li key={g.vendorId} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-gold"
                    checked={on}
                    aria-label={`Pay ${g.vendorName}`}
                    onChange={(e) =>
                      setSkipped((cur) => {
                        const next = new Set(cur);
                        if (e.target.checked) next.delete(g.vendorId);
                        else next.add(g.vendorId);
                        return next;
                      })
                    }
                  />
                  <span className="min-w-0 flex-1">
                    <span className={cn('block font-medium', on ? 'text-ink' : 'text-ink-muted line-through')}>{g.vendorName}</span>
                    <span className="block text-xs text-ink-muted">
                      {g.bills.length} {g.bills.length === 1 ? 'bill' : 'bills'} · {g.bills.map((b) => b.billNumber ?? fmtDate(b.billDate)).join(', ')}
                      {v ? ` · usually ${v.paymentMethod.toLowerCase()}${method === 'ACH' && !v.hasBank ? ' · no bank on file' : ''}` : ''}
                    </span>
                  </span>
                  <span className="shrink-0 tabular-nums text-ink">{money(g.total)}</span>
                </li>
              );
            })}
          </ul>
        )}
        <div className="grid gap-3 sm:grid-cols-3 [&>*]:min-w-0">
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
        </div>
        {method === 'ACH' && (
          <p className="text-sm text-ink-muted">{canAch ? 'Goes out as ACH credits in today’s file, one per vendor.' : !opts.data?.ownAch ? 'Payroll banking isn’t sending its own ACH, so this records ACH payments you send from the bank.' : 'A vendor in this run has no bank on file, so this records ACH payments you send from the bank.'}</p>
        )}
        <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-line bg-line text-center text-sm" aria-label="This run">
          <div className="bg-surface px-3 py-2">
            <dt className="text-2xs uppercase tracking-wider text-ink-muted">Vendors</dt>
            <dd className="tabular-nums text-ink">{included.length}</dd>
          </div>
          <div className="bg-surface px-3 py-2">
            <dt className="text-2xs uppercase tracking-wider text-ink-muted">Total</dt>
            <dd className="font-semibold tabular-nums text-ink">{money(total)}</dd>
          </div>
          <div className="bg-surface px-3 py-2">
            <dt className="text-2xs uppercase tracking-wider text-ink-muted">Cash left after</dt>
            <dd className={cn('tabular-nums', left !== null && left < 0 ? 'font-semibold text-alert' : 'text-ink')}>{left === null ? 'No bank in the books' : money(left)}</dd>
          </div>
        </dl>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => run.mutate()} loading={run.isPending} disabled={included.length === 0 || !from || !paidOn}>
            {canAch ? `Send ${money(total)}` : `Pay ${included.length} ${included.length === 1 ? 'vendor' : 'vendors'} · ${money(total)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
