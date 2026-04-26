import { useEffect, useState } from 'react';
import type { PayrollItem } from '@alto-people/shared';
import { listMyPayrollItems } from '@/lib/payrollApi';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';

const fmtMoney = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

function statusBadge(status: PayrollItem['status']): { label: string; cls: string } {
  switch (status) {
    case 'PENDING':
      return { label: 'Pending', cls: 'bg-silver/10 text-silver border-silver/30' };
    case 'DISBURSED':
      return { label: 'Paid', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' };
    case 'FAILED':
      return { label: 'Failed', cls: 'bg-alert/15 text-alert border-alert/30' };
    case 'HELD':
      return { label: 'Held', cls: 'bg-gold/20 text-gold border-gold/40' };
  }
}

export function AssociatePayrollView() {
  const [items, setItems] = useState<PayrollItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await listMyPayrollItems();
        setItems(res.items);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Failed to load.');
      }
    })();
  }, []);

  return (
    <div className="max-w-3xl mx-auto">
      <header className="mb-6">
        <h1 className="font-display text-4xl md:text-5xl text-white mb-2 leading-tight">
          My pay
        </h1>
        <p className="text-silver">Recent paystubs and disbursement status.</p>
      </header>

      {error && (
        <p role="alert" className="text-sm text-alert mb-4">
          {error}
        </p>
      )}
      {!items && <p className="text-silver">Loading…</p>}
      {items && items.length === 0 && (
        <p className="text-silver">No paystubs yet.</p>
      )}

      {items && items.length > 0 && (
        <ul className="space-y-3">
          {items.map((it) => {
            const badge = statusBadge(it.status);
            return (
              <li
                key={it.id}
                className="p-4 bg-navy border border-navy-secondary rounded-lg"
              >
                <div className="flex items-center justify-between gap-4 mb-2">
                  <div className="text-sm text-silver">
                    {it.hoursWorked.toFixed(2)} hrs × {fmtMoney(it.hourlyRate)}/hr
                  </div>
                  <span
                    className={cn(
                      'shrink-0 text-xs uppercase tracking-widest px-2 py-1 rounded border',
                      badge.cls
                    )}
                  >
                    {badge.label}
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-3 text-sm">
                  <div>
                    <div className="text-xs uppercase tracking-widest text-silver/60">Gross</div>
                    <div className="text-white tabular-nums">{fmtMoney(it.grossPay)}</div>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-widest text-silver/60">Federal tax</div>
                    <div className="text-white tabular-nums">
                      −{fmtMoney(it.federalWithholding)}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-widest text-gold">Net</div>
                    <div className="font-display text-xl text-gold tabular-nums">
                      {fmtMoney(it.netPay)}
                    </div>
                  </div>
                </div>
                {it.disbursementRef && (
                  <div className="text-xs text-silver/60 mt-2">
                    Ref: {it.disbursementRef}
                  </div>
                )}
                {it.failureReason && (
                  <div className="text-xs text-alert mt-2">{it.failureReason}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
