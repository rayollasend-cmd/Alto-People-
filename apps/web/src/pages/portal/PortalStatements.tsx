import type { ReactNode } from 'react';
import { FileText } from '@/components/ui/icons';
import { useI18n } from '@/lib/i18n';
import { fmtDateOnly, fmtDateOnlyRange, fmtHours, fmtMoney, fmtStatementNo } from '@/lib/format';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { downloadStatementFile } from '@/pages/clients/statementsShared';
import '@/lib/i18n/en/portal';

/**
 * One statement as the portal shows it — the store home and History draw
 * the same row (F500 G5). It used to read "Statement #4 · Aug 29 – Sep 4 ·
 * Due" with no money, no due date and "Due" on a statement 44 days late;
 * now: "No. 0004 · Aug 29 – Sep 4 · $2,880.00 · due Oct 7 · 15 days past
 * due". The API decides what an account may see: a store account at a
 * multi-store client gets its store's share and no PDF; at a one-store
 * client the statement is its own.
 */
export interface PortalStatement {
  id: string;
  number: number | null;
  periodStart: string;
  periodEnd: string;
  amount: number | null;
  hours: number | null;
  storeHours: number | null;
  storeAmount: number | null;
  paidAt: string | null;
  /** YYYY-MM-DD; absent from an older server. */
  dueAt?: string | null;
  poNumber?: string | null;
  /** Days past due, unpaid; null when not yet due. */
  daysPastDue?: number | null;
  pdfUrl: string | null;
  reviewed: { reviewedAt: string; reviewedBy: string | null } | null;
}

/** The amount this account sees: its store's share in a store view, else the statement's. */
export function statementAmount(s: PortalStatement, inStore: boolean): number | null {
  return inStore && s.storeAmount !== null ? s.storeAmount : s.amount;
}

/** The status chip: paid, past due (alert, with how long), or due on a day. */
export function StatementStatus({ s }: { s: PortalStatement }) {
  const { t } = useI18n();
  if (s.paidAt) return <Badge variant="success" size="sm">{t('portal.paidOn', { date: fmtDateOnly(s.paidAt.slice(0, 10), { year: 'auto' }) })}</Badge>;
  if (s.daysPastDue) {
    return (
      <Badge variant="destructive" size="sm" data-testid="statement-past-due">
        {t('portal.stPastDue', { count: s.daysPastDue })}
      </Badge>
    );
  }
  return (
    <Badge variant="pending" size="sm">
      {s.dueAt ? t('portal.stDueOn', { date: fmtDateOnly(s.dueAt, { year: 'auto' }) }) : t('portal.due')}
    </Badge>
  );
}

export function StatementRow({ s, inStore, actions }: { s: PortalStatement; inStore: boolean; actions?: ReactNode }) {
  const { t } = useI18n();
  const amount = statementAmount(s, inStore);
  const hours = inStore && s.storeHours !== null ? s.storeHours : s.hours;
  return (
    <li className="py-2.5" data-testid="portal-statement">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-ink tabular-nums">
            {s.number !== null ? t('portal.stNumber', { n: fmtStatementNo(s.number) }) : t('portal.statements')}
          </div>
          <div className="text-xs text-silver/70 tabular-nums">
            {fmtDateOnlyRange(s.periodStart, s.periodEnd)}
            {hours !== null && ` · ${fmtHours(hours)}`}
            {s.poNumber && ` · ${t('portal.stPo', { po: s.poNumber })}`}
          </div>
          {!s.paidAt && s.dueAt && (
            <div className={s.daysPastDue ? 'text-xs text-alert tabular-nums' : 'text-xs text-silver/70 tabular-nums'}>
              {t('portal.stDueLine', { date: fmtDateOnly(s.dueAt, { year: 'auto' }) })}
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {amount !== null && <span className="text-sm font-semibold tabular-nums text-ink">{fmtMoney(amount)}</span>}
          <StatementStatus s={s} />
        </div>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1 print:hidden">
        {s.pdfUrl !== null && (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              const url = s.pdfUrl;
              if (url) void downloadStatementFile(url, `statement-${s.periodStart}.pdf`);
            }}
          >
            <FileText className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
            {t('portal.stPdfShort')}
          </Button>
        )}
        {actions}
      </div>
    </li>
  );
}

/** "Open balance $5,760.00 · 2 statements" (the amount only where the account sees it). */
export function OpenBalance({ balance }: { balance: { count: number; amount: number | null; pastDue: number } | undefined }) {
  const { t } = useI18n();
  if (!balance || balance.count === 0) return null;
  return (
    <span className={balance.pastDue > 0 ? 'text-xs tabular-nums text-alert' : 'text-xs tabular-nums text-silver/70'} data-testid="open-balance">
      {balance.amount !== null
        ? t('portal.stBalance', { amount: fmtMoney(balance.amount), count: balance.count })
        : t('portal.stBalanceCount', { count: balance.count })}
    </span>
  );
}
