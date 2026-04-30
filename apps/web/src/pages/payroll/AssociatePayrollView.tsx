// Wave 1.4 — Associate-facing paystub redesigned to QuickBooks Online
// Payroll layout: per-kind earning lines, separate Deductions section,
// and a Current + YTD column on every numeric row. The full breakdown
// expands inline so an associate can read their tax math without leaving
// the page (the PDF download still lives on the run drawer for HR).

import { useEffect, useMemo, useState } from 'react';
import type { PayrollItem, PayrollItemEarning } from '@alto-people/shared';
import { listMyPayrollItems } from '@/lib/payrollApi';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { PageHeader } from '@/components/ui/PageHeader';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { ChevronDown, ChevronRight, Wallet } from 'lucide-react';

const fmtMoney = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const KIND_LABEL: Record<PayrollItemEarning['kind'], string> = {
  REGULAR: 'Regular',
  OVERTIME: 'Overtime',
  DOUBLE_TIME: 'Double time',
  HOLIDAY: 'Holiday',
  SICK: 'Sick',
  VACATION: 'Vacation',
  BONUS: 'Bonus',
  COMMISSION: 'Commission',
  TIPS: 'Tips',
  REIMBURSEMENT: 'Reimbursement (non-taxable)',
};

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
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

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

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="max-w-3xl mx-auto">
      <PageHeader
        title="My pay"
        subtitle="Recent paystubs with year-to-date totals."
      />

      {error && (
        <p role="alert" className="text-sm text-alert mb-4">
          {error}
        </p>
      )}
      {!items && <SkeletonRows count={3} rowHeight="h-32" />}
      {items && items.length === 0 && (
        <EmptyState
          icon={Wallet}
          title="No paystubs yet"
          description="Your first paystub will appear here after payroll runs for a period you worked."
        />
      )}

      {items && items.length > 0 && (
        <ul className="space-y-3">
          {items.map((it) => (
            <PaystubCard
              key={it.id}
              item={it}
              allItems={items}
              expanded={expanded.has(it.id)}
              onToggle={() => toggle(it.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function PaystubCard({
  item,
  allItems,
  expanded,
  onToggle,
}: {
  item: PayrollItem;
  allItems: PayrollItem[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const badge = statusBadge(item.status);
  const ytd = useMemo(() => computeYtd(item, allItems), [item, allItems]);

  return (
    <li className="bg-navy border border-navy-secondary rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full p-4 text-left hover:bg-navy-secondary/30 transition-colors"
      >
        <div className="flex items-center gap-3 mb-2">
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-silver/60 shrink-0" />
          ) : (
            <ChevronRight className="h-4 w-4 text-silver/60 shrink-0" />
          )}
          <div className="flex-1 text-sm text-silver">
            {item.hoursWorked.toFixed(2)} hrs · {fmtMoney(item.hourlyRate)}/hr
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
        <div className="grid grid-cols-3 gap-3 text-sm pl-7">
          <div>
            <div className="text-xs uppercase tracking-widest text-silver/60">Gross</div>
            <div className="text-white tabular-nums">{fmtMoney(item.grossPay)}</div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-widest text-silver/60">
              {item.postTaxDeductions > 0 ? 'Tax + post-tax' : 'Taxes'}
            </div>
            <div className="text-white tabular-nums">
              −{fmtMoney(item.federalWithholding + item.fica + item.medicare + item.stateWithholding + item.postTaxDeductions)}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-widest text-gold">Net</div>
            <div className="font-display text-xl text-gold tabular-nums">
              {fmtMoney(item.netPay)}
            </div>
          </div>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-navy-secondary p-4 space-y-5 text-xs">
          <Section title="Earnings">
            <PaystubTable
              headers={['', 'Hours', 'Rate', 'Current', 'YTD']}
              rows={(item.earnings.length > 0
                ? item.earnings
                : [
                    {
                      id: 'fallback',
                      kind: 'REGULAR' as const,
                      hours: item.hoursWorked,
                      rate: item.hourlyRate,
                      amount: item.grossPay,
                      isTaxable: true,
                      notes: null,
                    },
                  ]
              ).map((e) => ({
                key: e.id,
                cells: [
                  KIND_LABEL[e.kind],
                  e.hours == null ? '—' : e.hours.toFixed(2),
                  e.rate == null ? '—' : fmtMoney(e.rate),
                  fmtMoney(e.amount),
                  fmtMoney(ytd.byKind.get(e.kind) ?? e.amount),
                ],
              }))}
              footer={['Gross pay', '', '', fmtMoney(item.grossPay), fmtMoney(ytd.gross)]}
            />
          </Section>

          <Section title="Deductions">
            <PaystubTable
              headers={['', '', '', 'Current', 'YTD']}
              rows={[
                {
                  key: 'fit',
                  cells: ['Federal income tax', '', '', `−${fmtMoney(item.federalWithholding)}`, `−${fmtMoney(ytd.fit)}`],
                },
                {
                  key: 'fica',
                  cells: ['Social Security (FICA)', '', '', `−${fmtMoney(item.fica)}`, `−${fmtMoney(ytd.fica)}`],
                },
                {
                  key: 'medicare',
                  cells: ['Medicare', '', '', `−${fmtMoney(item.medicare)}`, `−${fmtMoney(ytd.medicare)}`],
                },
                {
                  key: 'sit',
                  cells: [
                    `State income tax${item.taxState ? ` (${item.taxState})` : ''}`,
                    '',
                    '',
                    `−${fmtMoney(item.stateWithholding)}`,
                    `−${fmtMoney(ytd.sit)}`,
                  ],
                },
                ...(item.postTaxDeductions > 0
                  ? [
                      {
                        key: 'posttax',
                        cells: [
                          'Garnishments / post-tax',
                          '',
                          '',
                          `−${fmtMoney(item.postTaxDeductions)}`,
                          `−${fmtMoney(ytd.postTax)}`,
                        ],
                      },
                    ]
                  : []),
              ]}
              footer={[
                'Total deductions',
                '',
                '',
                `−${fmtMoney(item.federalWithholding + item.fica + item.medicare + item.stateWithholding + item.postTaxDeductions)}`,
                `−${fmtMoney(ytd.fit + ytd.fica + ytd.medicare + ytd.sit + ytd.postTax)}`,
              ]}
            />
          </Section>

          <Section title="Employer contributions (informational)">
            <PaystubTable
              headers={['', '', '', 'Current', 'YTD']}
              rows={[
                {
                  key: 'efica',
                  cells: ['Employer FICA match', '', '', fmtMoney(item.employerFica), fmtMoney(ytd.empFica)],
                },
                {
                  key: 'emed',
                  cells: ['Employer Medicare match', '', '', fmtMoney(item.employerMedicare), fmtMoney(ytd.empMed)],
                },
                {
                  key: 'futa',
                  cells: ['Federal unemployment (FUTA)', '', '', fmtMoney(item.employerFuta), fmtMoney(ytd.futa)],
                },
                {
                  key: 'suta',
                  cells: ['State unemployment (SUTA)', '', '', fmtMoney(item.employerSuta), fmtMoney(ytd.suta)],
                },
              ]}
            />
          </Section>

          <div className="flex items-center justify-between rounded border border-gold/30 bg-gold/5 p-3">
            <span className="text-xs uppercase tracking-widest text-gold">Net pay</span>
            <div className="text-right">
              <div className="font-display text-2xl text-gold tabular-nums">
                {fmtMoney(item.netPay)}
              </div>
              <div className="text-[10px] uppercase tracking-wide text-silver/50">
                YTD net {fmtMoney(ytd.net)}
              </div>
            </div>
          </div>

          {item.disbursementRef && (
            <div className="text-xs text-silver/60">Disbursement ref: {item.disbursementRef}</div>
          )}
          {item.failureReason && (
            <div className="text-xs text-alert">{item.failureReason}</div>
          )}
        </div>
      )}
    </li>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-widest text-silver/50 mb-1.5">{title}</div>
      {children}
    </div>
  );
}

function PaystubTable({
  headers,
  rows,
  footer,
}: {
  headers: string[];
  rows: Array<{ key: string; cells: string[] }>;
  footer?: string[];
}) {
  return (
    // Wrapped in overflow-x-auto so the earnings/deductions/taxes
    // breakdown can scroll horizontally on narrow phones instead of
    // squishing the tabular-num columns into illegible 2-3 char cells.
    <div className="-mx-2 overflow-x-auto sm:mx-0">
      <table className="w-full min-w-[20rem] text-xs">
      <thead>
        <tr className="text-silver/50">
          {headers.map((h, i) => (
            <th
              key={i}
              className={cn('py-1 font-normal text-[10px] uppercase tracking-widest', i === 0 ? 'text-left' : 'text-right')}
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className="border-t border-navy-secondary/60">
            {r.cells.map((c, i) => (
              <td
                key={i}
                className={cn('py-1.5 tabular-nums', i === 0 ? 'text-left text-silver' : 'text-right text-white')}
              >
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
      {footer && (
        <tfoot>
          <tr className="border-t-2 border-silver/20">
            {footer.map((c, i) => (
              <td
                key={i}
                className={cn(
                  'py-1.5 tabular-nums font-medium',
                  i === 0 ? 'text-left text-silver/80' : 'text-right text-white'
                )}
              >
                {c}
              </td>
            ))}
          </tr>
        </tfoot>
      )}
      </table>
    </div>
  );
}

interface YtdSummary {
  gross: number;
  fit: number;
  fica: number;
  medicare: number;
  sit: number;
  postTax: number;
  net: number;
  empFica: number;
  empMed: number;
  futa: number;
  suta: number;
  byKind: Map<PayrollItemEarning['kind'], number>;
}

/**
 * Computes year-to-date totals for a paystub by summing it plus every
 * earlier item from the same calendar year. We use the embedded ytdWages
 * snapshot as a sanity check on the total earnings — if we have all the
 * items in the response, our sum should equal `ytdWages + grossPay`. If
 * the response is paginated and we're missing earlier items, we fall back
 * to the snapshot for gross.
 */
function computeYtd(item: PayrollItem, all: PayrollItem[]): YtdSummary {
  // Bucket items by createdAt year — close enough as a proxy for periodEnd
  // year since runs almost always finalize within their period's year.
  const inYear = all.filter((i) => sameYearAs(i, item) && createdAtLeq(i, item));

  const sum = (sel: (i: PayrollItem) => number) =>
    inYear.reduce((acc, i) => acc + sel(i), 0);

  const byKind = new Map<PayrollItemEarning['kind'], number>();
  for (const i of inYear) {
    for (const e of i.earnings) {
      byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + e.amount);
    }
  }

  const grossFromSnapshot = item.ytdWages + item.grossPay;
  const grossFromSum = sum((i) => i.grossPay);
  const gross = Math.max(grossFromSnapshot, grossFromSum);

  return {
    gross,
    fit: sum((i) => i.federalWithholding),
    fica: sum((i) => i.fica),
    medicare: sum((i) => i.medicare),
    sit: sum((i) => i.stateWithholding),
    postTax: sum((i) => i.postTaxDeductions),
    net: sum((i) => i.netPay),
    empFica: sum((i) => i.employerFica),
    empMed: sum((i) => i.employerMedicare),
    futa: sum((i) => i.employerFuta),
    suta: sum((i) => i.employerSuta),
    byKind,
  };
}

function sameYearAs(a: PayrollItem, b: PayrollItem): boolean {
  // PayrollItem doesn't expose createdAt in the shared contract — derive
  // year from disbursedAt if available, otherwise treat as same-year. The
  // ytdWages snapshot in `b` already encodes a year boundary, so this
  // approximation is corrected by the snapshot fallback in computeYtd.
  const yearOf = (it: PayrollItem) => {
    if (it.disbursedAt) return new Date(it.disbursedAt).getUTCFullYear();
    return new Date().getUTCFullYear();
  };
  return yearOf(a) === yearOf(b);
}

function createdAtLeq(a: PayrollItem, b: PayrollItem): boolean {
  // Without createdAt in the shared contract, fall back to comparing
  // disbursedAt; if either lacks a date, include `a` (caller filters
  // by year already).
  if (a.disbursedAt && b.disbursedAt) return a.disbursedAt <= b.disbursedAt;
  return true;
}
