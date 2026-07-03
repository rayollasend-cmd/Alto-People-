// Wave 1.4 — Associate-facing paystub redesigned to QuickBooks Online
// Payroll layout: per-kind earning lines, separate Deductions section,
// and a Current + YTD column on every numeric row. The full breakdown
// expands inline so an associate can read their tax math without leaving
// the page. Associates can also download their own paystub as a PDF —
// the backend authorizes the item owner on GET /payroll/items/:id/paystub.pdf.

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { PayrollItem, PayrollItemEarning } from '@alto-people/shared';
import { downloadMyPaystub, listMyPayrollItems } from '@/lib/payrollApi';
import { ApiError } from '@/lib/api';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { cn } from '@/lib/cn';
import { dayHeading, groupByDayBy } from '@/lib/dayGroup';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { ChevronDown, ChevronRight, Download, Wallet } from 'lucide-react';

const fmtMoney = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const KIND_KEY: Record<PayrollItemEarning['kind'], MessageKey> = {
  REGULAR: 'pay.kind.REGULAR',
  OVERTIME: 'pay.kind.OVERTIME',
  DOUBLE_TIME: 'pay.kind.DOUBLE_TIME',
  HOLIDAY: 'pay.kind.HOLIDAY',
  SICK: 'pay.kind.SICK',
  VACATION: 'pay.kind.VACATION',
  BONUS: 'pay.kind.BONUS',
  COMMISSION: 'pay.kind.COMMISSION',
  TIPS: 'pay.kind.TIPS',
  REIMBURSEMENT: 'pay.kind.REIMBURSEMENT',
};

function statusBadge(status: PayrollItem['status']): { labelKey: MessageKey; cls: string } {
  switch (status) {
    case 'PENDING':
      return { labelKey: 'pay.status.PENDING', cls: 'bg-silver/10 text-silver border-silver/30' };
    case 'DISBURSED':
      return { labelKey: 'pay.status.DISBURSED', cls: 'bg-success/15 text-success border-success/30' };
    case 'FAILED':
      return { labelKey: 'pay.status.FAILED', cls: 'bg-alert/15 text-alert border-alert/30' };
    case 'HELD':
      return { labelKey: 'pay.status.HELD', cls: 'bg-gold/20 text-gold border-gold/40' };
    case 'VOIDED':
      return { labelKey: 'pay.status.VOIDED', cls: 'bg-alert/10 text-alert/80 border-alert/20' };
  }
}

/**
 * 403/404 are fully expected for accounts without payroll records and
 * render as a genuine empty state (null data); anything else rethrows so
 * the query errors. Mirrors the dashboard's emptyOnExpectedDenial — the
 * ['me','payrollItems'] key is SHARED with the dashboard's paystub card,
 * so both queryFns must produce the same cached shape.
 */
async function emptyOnExpectedDenial<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
      return null;
    }
    throw err;
  }
}

export function AssociatePayrollView() {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const payQuery = useQuery({
    queryKey: ['me', 'payrollItems'],
    queryFn: () => emptyOnExpectedDenial(listMyPayrollItems()),
  });

  // undefined → still loading (skeleton); null (expected denial) → empty state.
  const items: PayrollItem[] | null =
    payQuery.data === undefined ? null : (payQuery.data?.items ?? []);
  const error = payQuery.error
    ? payQuery.error instanceof ApiError
      ? payQuery.error.message
      : t('pay.loadFailed')
    : null;

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="mx-auto">
      <PageHeader
        title={t('pay.title')}
        subtitle={t('pay.subtitle')}
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
          title={t('pay.noPaystubs')}
          description={t('pay.noPaystubsDesc')}
        />
      )}

      {items && items.length > 0 && (() => {
        // Pending paystubs (not yet disbursed) bubble to the top in a
        // dedicated bucket so they don't get hidden under a collapsed
        // older-day section.
        const pending = items.filter((i) => !i.disbursedAt);
        const disbursed = items.filter((i) => !!i.disbursedAt);
        const groups = groupByDayBy(disbursed, (i) => i.disbursedAt!);
        return (
          <div className="space-y-3">
            {pending.length > 0 && (
              <PaystubGroup
                heading={t('pay.pendingCount', { count: pending.length })}
                items={pending}
                allItems={items}
                expanded={expanded}
                onToggle={toggle}
                defaultOpen
              />
            )}
            {groups.map((g, idx) => (
              <PaystubGroup
                key={g.key}
                heading={`${dayHeading(g.key)} · ${g.key}`}
                items={g.entries}
                allItems={items}
                expanded={expanded}
                onToggle={toggle}
                defaultOpen={pending.length === 0 && idx === 0}
              />
            ))}
          </div>
        );
      })()}
    </div>
  );
}

function PaystubGroup({
  heading,
  items,
  allItems,
  expanded,
  onToggle,
  defaultOpen,
}: {
  heading: string;
  items: PayrollItem[];
  allItems: PayrollItem[];
  expanded: Set<string>;
  onToggle: (id: string) => void;
  defaultOpen?: boolean;
}) {
  const { t } = useI18n();
  return (
    <details
      open={defaultOpen}
      className="rounded-lg border border-navy-secondary bg-navy/40 [&[open]>summary>svg.chev]:rotate-90"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs hover:bg-navy-secondary/40">
        <ChevronRight className="chev h-4 w-4 text-silver/70 transition-transform" />
        <span className="font-medium text-white">{heading}</span>
        <span className="ml-auto text-silver/70">
          {items.length === 1
            ? t('pay.paystubWord', { count: items.length })
            : t('pay.paystubWordPlural', { count: items.length })}
        </span>
      </summary>
      <ul className="space-y-3 p-3 pt-0">
        {items.map((it) => (
          <PaystubCard
            key={it.id}
            item={it}
            allItems={allItems}
            expanded={expanded.has(it.id)}
            onToggle={() => onToggle(it.id)}
          />
        ))}
      </ul>
    </details>
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
  const { t } = useI18n();
  const badge = statusBadge(item.status);
  const ytd = useMemo(() => computeYtd(item, allItems), [item, allItems]);
  const [downloading, setDownloading] = useState(false);

  const onDownload = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      await downloadMyPaystub(item.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('pay.downloadFailed'));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <li className="bg-navy border border-navy-secondary rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full p-4 text-left hover:bg-navy-secondary/30 transition-colors"
      >
        <div className="flex items-center gap-3 mb-2">
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-silver/70 shrink-0" />
          ) : (
            <ChevronRight className="h-4 w-4 text-silver/70 shrink-0" />
          )}
          <div className="flex-1 text-sm text-silver">
            {t('pay.hrsAtRate', {
              hours: item.hoursWorked.toFixed(2),
              rate: fmtMoney(item.hourlyRate),
            })}
          </div>
          <span
            className={cn(
              'shrink-0 text-xs uppercase tracking-widest px-2 py-1 rounded border',
              badge.cls
            )}
          >
            {t(badge.labelKey)}
          </span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm pl-7">
          <div>
            <div className="text-xs uppercase tracking-widest text-silver/70">{t('pay.gross')}</div>
            <div className="text-white tabular-nums">{fmtMoney(item.grossPay)}</div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-widest text-silver/70">
              {item.postTaxDeductions > 0 ? t('pay.taxPlusPostTax') : t('pay.taxes')}
            </div>
            <div className="text-white tabular-nums">
              −{fmtMoney(item.federalWithholding + item.fica + item.medicare + item.stateWithholding + item.postTaxDeductions)}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-widest text-gold">{t('pay.net')}</div>
            <div className="font-display text-xl text-gold tabular-nums">
              {fmtMoney(item.netPay)}
            </div>
          </div>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-navy-secondary p-4 space-y-5 text-xs">
          <Section title={t('pay.earnings')}>
            <PaystubTable
              headers={['', t('pay.colHours'), t('pay.colRate'), t('pay.colCurrent'), t('pay.colYtd')]}
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
                  t(KIND_KEY[e.kind]),
                  e.hours == null ? '—' : e.hours.toFixed(2),
                  e.rate == null ? '—' : fmtMoney(e.rate),
                  fmtMoney(e.amount),
                  fmtMoney(ytd.byKind.get(e.kind) ?? e.amount),
                ],
              }))}
              footer={[t('pay.grossPay'), '', '', fmtMoney(item.grossPay), fmtMoney(ytd.gross)]}
            />
          </Section>

          <Section title={t('pay.deductions')}>
            <PaystubTable
              headers={['', '', '', t('pay.colCurrent'), t('pay.colYtd')]}
              rows={[
                {
                  key: 'fit',
                  cells: [t('pay.fedIncomeTax'), '', '', `−${fmtMoney(item.federalWithholding)}`, `−${fmtMoney(ytd.fit)}`],
                },
                {
                  key: 'fica',
                  cells: [t('pay.socialSecurity'), '', '', `−${fmtMoney(item.fica)}`, `−${fmtMoney(ytd.fica)}`],
                },
                {
                  key: 'medicare',
                  cells: [t('pay.medicare'), '', '', `−${fmtMoney(item.medicare)}`, `−${fmtMoney(ytd.medicare)}`],
                },
                {
                  key: 'sit',
                  cells: [
                    `${t('pay.stateIncomeTax')}${item.taxState ? ` (${item.taxState})` : ''}`,
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
                          t('pay.garnishments'),
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
                t('pay.totalDeductions'),
                '',
                '',
                `−${fmtMoney(item.federalWithholding + item.fica + item.medicare + item.stateWithholding + item.postTaxDeductions)}`,
                `−${fmtMoney(ytd.fit + ytd.fica + ytd.medicare + ytd.sit + ytd.postTax)}`,
              ]}
            />
          </Section>

          <Section title={t('pay.employerContrib')}>
            <PaystubTable
              headers={['', '', '', t('pay.colCurrent'), t('pay.colYtd')]}
              rows={[
                {
                  key: 'efica',
                  cells: [t('pay.employerFica'), '', '', fmtMoney(item.employerFica), fmtMoney(ytd.empFica)],
                },
                {
                  key: 'emed',
                  cells: [t('pay.employerMedicare'), '', '', fmtMoney(item.employerMedicare), fmtMoney(ytd.empMed)],
                },
                {
                  key: 'futa',
                  cells: [t('pay.futa'), '', '', fmtMoney(item.employerFuta), fmtMoney(ytd.futa)],
                },
                {
                  key: 'suta',
                  cells: [t('pay.suta'), '', '', fmtMoney(item.employerSuta), fmtMoney(ytd.suta)],
                },
              ]}
            />
          </Section>

          <div className="flex items-center justify-between rounded border border-gold/30 bg-gold/5 p-3">
            <span className="text-xs uppercase tracking-widest text-gold">{t('pay.netPay')}</span>
            <div className="text-right">
              <div className="font-display text-2xl text-gold tabular-nums">
                {fmtMoney(item.netPay)}
              </div>
              <div className="text-[10px] uppercase tracking-wide text-silver/70">
                {t('pay.ytdNet', { amount: fmtMoney(ytd.net) })}
              </div>
            </div>
          </div>

          {item.disbursementRef && (
            <div className="text-xs text-silver/70">
              {t('pay.disbursementRef', { ref: item.disbursementRef })}
            </div>
          )}
          {item.failureReason && (
            <div className="text-xs text-alert">{item.failureReason}</div>
          )}

          <div className="flex justify-end pt-1">
            <Button
              size="sm"
              variant="outline"
              onClick={onDownload}
              loading={downloading}
            >
              <Download className="h-3.5 w-3.5" />
              {t('pay.downloadPdf')}
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-widest text-silver/70 mb-1.5">{title}</div>
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
      {/* 13px, not 12 — these cells carry the associate's pay math, the
          most load-bearing numbers in the app, read on phones at arm's
          length. Still fits the 5-col grid at 320px. */}
      <table className="w-full min-w-[20rem] text-[13px]">
      <thead>
        <tr className="text-silver/70">
          {headers.map((h, i) => (
            <th
              key={i}
              className={cn('py-1 font-normal text-[11px] uppercase tracking-widest', i === 0 ? 'text-left' : 'text-right')}
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
