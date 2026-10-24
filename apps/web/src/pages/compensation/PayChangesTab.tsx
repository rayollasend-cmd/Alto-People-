import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ScrollText, TrendingUp } from '@/components/ui/icons';
import type { PayChangeRow, Promotion } from '@alto-people/shared';
import { AssociateLink } from '@/components/ui/AssociateLink';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { DataGrid } from '@/components/ui/DataGrid';
import { fmtDate, fmtDateTime, fmtMoney, parseYmd } from '@/lib/format';
import { listPayChanges, listPromotions } from '@/lib/approvalRequestsApi';

/**
 * Finance's audit of pay: every pay-rate and bill-rate change with who
 * changed it, what it was, what it became, when it took effect, and the
 * approval that let it through. And the promotions, with where each stands.
 */

const money = (v: unknown) => (typeof v === 'number' ? fmtMoney(v) : '—');

function beforeAfter(r: PayChangeRow): string {
  const b = (r.before ?? null) as Record<string, unknown> | null;
  const a = (r.after ?? {}) as Record<string, unknown>;
  if (r.kind === 'pay') return `${b ? `${money(b.amount)} → ` : ''}${money(a.amount)} ${a.payType === 'SALARY' ? '/yr' : '/h'}`;
  return `bill ${b ? `${money(b.billRate)} → ` : ''}${money(a.billRate)}, pay ${b ? `${money(b.payRate)} → ` : ''}${money(a.payRate)}`;
}

export function PayChangesTab({ clientId, associateId }: { clientId?: string; associateId?: string }) {
  const q = useQuery({
    queryKey: ['comp-changes', clientId ?? null, associateId ?? null],
    queryFn: () => listPayChanges({ ...(associateId ? { associateId } : {}), ...(clientId && !associateId ? { clientId } : {}) }),
  });
  if (q.isError) {
    return (
      <ErrorBanner action={<Button size="xs" variant="outline" onClick={() => void q.refetch()}>Retry</Button>}>
        Could not load the pay changes.
      </ErrorBanner>
    );
  }
  if (!q.data) return <SkeletonRows count={6} />;
  const rows = q.data.changes;
  if (rows.length === 0) return <EmptyState icon={ScrollText} title="No pay changes yet" description="Every pay-rate and bill-rate change lands here with who made it, the before and after, and the approval behind it." />;
  return (
    <DataGrid<PayChangeRow>
      rows={rows}
      id="pay-changes"
      rowKey={(r) => r.id}
      caption="Pay changes"
      noun={{ one: 'change', many: 'changes' }}
      columns={[
        { key: 'at', header: 'When', accessor: (r) => r.at, sortable: true, cell: (r) => <span className="tabular-nums">{fmtDateTime(r.at)}</span> },
        {
          key: 'who',
          header: 'What changed',
          accessor: (r) => r.associateName ?? r.position ?? '',
          cell: (r) =>
            r.kind === 'pay' && r.associateId ? (
              <AssociateLink associateId={r.associateId}>{r.associateName ?? 'Person'}</AssociateLink>
            ) : (
              <span>{r.position ?? '—'}</span>
            ),
        },
        { key: 'kind', header: 'Kind', accessor: (r) => r.kind, cell: (r) => <Badge variant="default" size="sm">{r.kind === 'pay' ? 'Pay rate' : 'Bill rate'}</Badge> },
        { key: 'change', header: 'Before → after', accessor: (r) => beforeAfter(r), cell: (r) => <span className="tabular-nums">{beforeAfter(r)}</span> },
        { key: 'effective', header: 'Effective', accessor: (r) => r.effectiveFrom ?? '', cell: (r) => (r.effectiveFrom ? fmtDate(parseYmd(r.effectiveFrom) ?? r.effectiveFrom) : '—') },
        { key: 'actor', header: 'By', accessor: (r) => r.actor?.name ?? '', cell: (r) => r.actor?.name ?? 'System' },
        {
          key: 'approval',
          header: 'Approval',
          accessor: (r) => (r.approvalRequestId ? 'approved' : r.note ?? ''),
          cell: (r) =>
            r.approvalRequestId ? (
              <Link to={`/approvals?tab=requests&approval=${r.approvalRequestId}`} className="text-gold underline-offset-2 hover:underline">
                Second person
              </Link>
            ) : (
              <span className="text-ink-muted">{r.note ?? 'Not required'}</span>
            ),
        },
      ]}
    />
  );
}

const PROMOTION_TONE: Record<Promotion['status'], 'pending' | 'success' | 'destructive' | 'default'> = { PENDING: 'pending', APPROVED: 'success', APPLIED: 'success', REJECTED: 'destructive' };
const PROMOTION_LABEL: Record<Promotion['status'], string> = { PENDING: 'Waiting', APPROVED: 'Approved', APPLIED: 'Applied', REJECTED: 'Rejected' };

export function PromotionsTab({ associateId }: { associateId?: string }) {
  const q = useQuery({ queryKey: ['promotions', associateId ?? null], queryFn: () => listPromotions(associateId ? { associateId } : {}) });
  if (q.isError) {
    return (
      <ErrorBanner action={<Button size="xs" variant="outline" onClick={() => void q.refetch()}>Retry</Button>}>
        Could not load the promotions.
      </ErrorBanner>
    );
  }
  if (!q.data) return <SkeletonRows count={4} />;
  const rows = q.data.promotions;
  if (rows.length === 0) return <EmptyState icon={TrendingUp} title="No promotions yet" description="Promote someone from their record: the seat, the level and the pay go to a second person, then land together with a letter." />;
  return (
    <DataGrid<Promotion>
      rows={rows}
      id="promotions"
      rowKey={(r) => r.id}
      caption="Promotions"
      noun={{ one: 'promotion', many: 'promotions' }}
      columns={[
        { key: 'who', header: 'Who', accessor: (r) => r.associateName, sortable: true, cell: (r) => <AssociateLink associateId={r.associateId}>{r.associateName}</AssociateLink> },
        { key: 'to', header: 'To', accessor: (r) => r.newTitle ?? r.jobProfileTitle ?? '', cell: (r) => [r.newTitle ?? r.jobProfileTitle, r.level ? `level ${r.level}` : null].filter(Boolean).join(' · ') || '—' },
        { key: 'pay', header: 'Pay', accessor: (r) => r.amount ?? '', cell: (r) => (r.amount ? <span className="tabular-nums">{r.currentAmount ? `${fmtMoney(Number(r.currentAmount))} → ` : ''}{fmtMoney(Number(r.amount))}</span> : '—') },
        { key: 'effective', header: 'Effective', accessor: (r) => r.effectiveFrom, sortable: true, cell: (r) => fmtDate(parseYmd(r.effectiveFrom) ?? r.effectiveFrom) },
        { key: 'status', header: 'Status', accessor: (r) => r.status, cell: (r) => <Badge variant={PROMOTION_TONE[r.status]} size="sm">{PROMOTION_LABEL[r.status]}</Badge> },
        {
          key: 'approval',
          header: 'Approval',
          accessor: (r) => r.approvalRequestId ?? '',
          cell: (r) =>
            r.approvalRequestId ? (
              <Link to={`/approvals?tab=requests&approval=${r.approvalRequestId}`} className="text-gold underline-offset-2 hover:underline">
                Open
              </Link>
            ) : (
              '—'
            ),
        },
      ]}
    />
  );
}
