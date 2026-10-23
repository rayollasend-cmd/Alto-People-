import { fmtMoney } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import type { ReimbursementStatus, ReimbursementSummaryCounts } from '@/lib/reimbursements97Api';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';

/**
 * The desk side of /reimbursements — the people who approve and settle
 * (managers, HR, finance), not the person submitting. Kept apart from the
 * associate's screen so its words stay staff words (English and Spanish),
 * while the associate's own screen ships in all six languages.
 *
 * Each role opens on its own queue (?status=): a settler on "Ready to
 * settle", an approver on "To approve".
 */

export type DeskFilter = 'ready' | 'approve' | 'queued' | 'paid' | 'all';
export const DESK_FILTERS: DeskFilter[] = ['ready', 'approve', 'queued', 'paid', 'all'];

/** The report status each desk filter lists (null = all). */
export const DESK_STATUS: Record<DeskFilter, ReimbursementStatus | null> = {
  ready: 'MANAGER_APPROVED',
  approve: 'SUBMITTED',
  queued: 'SETTLED',
  paid: 'PAID',
  all: null,
};

export function deskDefault(canSettle: boolean): DeskFilter {
  return canSettle ? 'ready' : 'approve';
}

/** The filters a role sees, in the order it works them. */
export function deskFilters(canSettle: boolean, canApprove: boolean): DeskFilter[] {
  const first: DeskFilter[] = canSettle ? ['ready', ...(canApprove ? (['approve'] as const) : [])] : ['approve', 'ready'];
  return [...first, 'queued', 'paid', 'all'];
}

export function useDeskWords() {
  const { t } = useI18n();
  return {
    filter: (f: DeskFilter, canSettle: boolean): string =>
      f === 'ready'
        ? canSettle
          ? t('reimbDesk.filter.ready')
          : t('reimbDesk.filter.waitingOnFinance')
        : f === 'approve'
          ? t('reimbDesk.filter.approve')
          : f === 'queued'
            ? t('reimbDesk.filter.queued')
            : f === 'paid'
              ? t('reimbDesk.filter.paid')
              : t('reimbDesk.filter.all'),
    approveN: (n: number, amount: number) => t(n === 1 ? 'reimbDesk.approveOne' : 'reimbDesk.approveMany', { count: n, amount: fmtMoney(amount) }),
    settleN: (n: number, amount: number) => t(n === 1 ? 'reimbDesk.settleOne' : 'reimbDesk.settleMany', { count: n, amount: fmtMoney(amount) }),
    settledToast: (n: number, amount: number) => t(n === 1 ? 'reimbDesk.settledOne' : 'reimbDesk.settledMany', { count: n, amount: fmtMoney(amount) }),
    skippedToast: (n: number, reason: string) => t(n === 1 ? 'reimbDesk.skippedOne' : 'reimbDesk.skippedMany', { count: n, reason }),
    selectApprovable: t('reimbDesk.selectApprovable'),
    newest200: t('reimbDesk.newest200'),
    selectSettleable: t('reimbDesk.selectSettleable'),
    empty: (f: DeskFilter): { title: string; description: string } =>
      f === 'ready'
        ? { title: t('reimbDesk.empty.readyTitle'), description: t('reimbDesk.empty.readyDesc') }
        : f === 'approve'
          ? { title: t('reimbDesk.empty.approveTitle'), description: t('reimbDesk.empty.approveDesc') }
          : f === 'queued'
            ? { title: t('reimbDesk.empty.queuedTitle'), description: t('reimbDesk.empty.queuedDesc') }
            : f === 'paid'
              ? { title: t('reimbDesk.empty.paidTitle'), description: t('reimbDesk.empty.paidDesc') }
              : { title: t('reimbDesk.empty.allTitle'), description: t('reimbDesk.empty.allDesc') },
  };
}

/**
 * The numbers the desk opens on, each a filter of the list below: money
 * ready to settle, what's queued for the next payroll, what payroll paid
 * this month (settlers), and what waits on a manager (approvers).
 */
export function DeskStrip({
  summary,
  canSettle,
  canApprove,
  filter,
  onFilter,
}: {
  summary: ReimbursementSummaryCounts | undefined;
  canSettle: boolean;
  canApprove: boolean;
  filter: DeskFilter;
  onFilter: (f: DeskFilter) => void;
}) {
  const { t } = useI18n();
  if (!summary) return null;
  const s = summary;
  const reports = (n: number) => t(n === 1 ? 'reimbDesk.reportOne' : 'reimbDesk.reportMany', { count: n });
  const tile = (f: DeskFilter, label: string, m: { count: number; amount: number }, nothing: string, tone?: 'warning' | 'good' | 'neutral') => (
    <MetricCard
      key={f}
      label={label}
      value={fmtMoney(m.amount)}
      hint={reports(m.count)}
      tone={tone}
      onClick={() => onFilter(f)}
      selected={filter === f}
      nothing={m.count === 0 ? nothing : undefined}
    />
  );
  return (
    <MetricStrip label={t('reimbDesk.stripLabel')}>
      {canSettle && tile('ready', t('reimbDesk.tile.ready'), s.readyToSettle, t('reimbDesk.tile.readyNone'), 'warning')}
      {canApprove && tile('approve', t('reimbDesk.tile.approve'), s.toApprove, t('reimbDesk.tile.approveNone'), 'warning')}
      {!canSettle && tile('ready', t('reimbDesk.tile.waitingOnFinance'), s.readyToSettle, t('reimbDesk.tile.waitingOnFinanceNone'), 'neutral')}
      {tile('queued', t('reimbDesk.tile.queued'), s.queuedForPayroll, t('reimbDesk.tile.queuedNone'), 'neutral')}
      {tile('paid', t('reimbDesk.tile.paid'), s.paidThisMonth, t('reimbDesk.tile.paidNone'), 'good')}
    </MetricStrip>
  );
}
