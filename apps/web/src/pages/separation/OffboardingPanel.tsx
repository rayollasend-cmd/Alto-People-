import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Package, Wallet } from '@/components/ui/icons';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { fmtDate, fmtHours, fmtMoney, parseYmd } from '@/lib/format';
import { returnAssetAssignment } from '@/lib/assets108Api';
import { getOffboarding, waiveSeparationAssets } from '@/lib/separation119Api';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { Textarea } from '@/components/ui/Input';

/**
 * Offboarding (HR pack 2026-10), inside the separation drawer: the final-pay
 * preview (what is still owed and by when the state wants it paid), the
 * company property still out — returned here, or waived with a reason — and
 * whether access is gone. Completion is blocked until the assets are clear.
 */
export function OffboardingPanel({ separationId, canManage }: { separationId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const [waiving, setWaiving] = useState(false);
  const [reason, setReason] = useState('');
  const query = useQuery({ queryKey: ['separations', separationId, 'offboarding'], queryFn: () => getOffboarding(separationId) });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['separations', separationId, 'offboarding'] });
  const returned = useMutation({
    mutationFn: (assignmentId: string) => returnAssetAssignment(assignmentId, { notes: 'Returned at offboarding' }),
    onSuccess: () => {
      toast.success('Marked returned.');
      refresh();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not record the return.'),
  });
  const waive = useMutation({
    mutationFn: () => waiveSeparationAssets(separationId, reason.trim()),
    onSuccess: () => {
      toast.success('Waived — the reason stays on the record.');
      setWaiving(false);
      refresh();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not waive.'),
  });
  const d = query.data;
  if (query.isError) {
    return (
      <div role="alert" className="text-sm text-alert">
        Could not load the offboarding checks.
      </div>
    );
  }
  if (!d) return <SkeletonRows count={3} />;
  const fp = d.finalPay;
  return (
    <div className="space-y-4 border-t border-line pt-3">
      <section className="space-y-2">
        <div className="flex items-center gap-2 text-sm uppercase tracking-wider text-ink-muted">
          <Wallet className="h-4 w-4" aria-hidden="true" /> Final pay
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          <dt className="text-ink-muted">Unpaid approved hours</dt>
          <dd className="text-right tabular-nums text-ink">{fmtHours(fp.unpaidApprovedHours)}{fp.paidThrough ? <span className="block text-xs text-ink-muted">paid through {fmtDate(parseYmd(fp.paidThrough))}</span> : null}</dd>
          <dt className="text-ink-muted">Awaiting approval</dt>
          <dd className="text-right tabular-nums text-ink">{fmtHours(fp.awaitingApprovalHours)}</dd>
          <dt className="text-ink-muted">Leave paid out</dt>
          <dd className="text-right tabular-nums text-ink">
            {fmtHours(fp.leavePayoutHours)}
            {fp.leaveBalances.filter((b) => !b.paidOut && b.hours > 0).length > 0 && (
              <span className="block text-xs text-ink-muted">{fp.leaveBalances.filter((b) => !b.paidOut && b.hours > 0).map((b) => `${b.category.toLowerCase()} ${fmtHours(b.hours)} not paid out`).join(' · ')}</span>
            )}
          </dd>
          <dt className="text-ink-muted">Rate</dt>
          <dd className="text-right tabular-nums text-ink">{fp.rate === null ? '—' : `${fmtMoney(fp.rate)}/h${fp.payType === 'SALARY' ? ' (from salary)' : ''}`}</dd>
          <dt className="font-medium text-ink">Estimated gross</dt>
          <dd className="text-right font-medium tabular-nums text-ink">{fp.estimatedGross === null ? '—' : fmtMoney(fp.estimatedGross)}</dd>
        </dl>
        <div className={fp.finalPaycheckLate ? 'rounded-md border border-alert/40 bg-alert/5 p-2 text-xs text-alert' : 'text-xs text-ink-muted'}>
          {fp.deadline.date ? `Last check due by ${fmtDate(parseYmd(fp.deadline.date))} (${fp.deadline.basis}).` : 'Last check due on the next regular payday.'} {fp.deadline.note}
          {fp.finalPaycheckLate && fp.finalPaycheckDate ? ` The final paycheck date on file (${fmtDate(parseYmd(fp.finalPaycheckDate))}) is after that.` : ''}
        </div>
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm uppercase tracking-wider text-ink-muted">
            <Package className="h-4 w-4" aria-hidden="true" /> Company property
          </div>
          {d.assets.clear ? <Badge variant="success">{d.assets.waivedAt ? 'Waived' : 'All returned'}</Badge> : <Badge variant="destructive">{d.assets.outstanding.length} out</Badge>}
        </div>
        {d.assets.waivedAt && d.assets.waiveReason && <p className="text-xs text-ink-muted">Waived: {d.assets.waiveReason}</p>}
        {d.assets.outstanding.length > 0 && (
          <ul className="divide-y divide-line rounded-md border border-line">
            {d.assets.outstanding.map((a) => (
              <li key={a.assignmentId} className="flex items-center justify-between gap-2 p-2 text-sm">
                <div className="min-w-0">
                  <div className="truncate text-ink">{a.label}</div>
                  <div className="text-xs text-ink-muted">
                    {a.kind.replace(/_/g, ' ').toLowerCase()}
                    {a.serial ? ` · ${a.serial}` : ''} · since {fmtDate(a.assignedAt)}
                  </div>
                </div>
                {canManage && (
                  <Button size="sm" variant="outline" onClick={() => returned.mutate(a.assignmentId)} loading={returned.isPending}>
                    Returned
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {canManage && !d.assets.clear && !waiving && (
          <Button size="sm" variant="ghost" onClick={() => setWaiving(true)}>
            Waive with a reason
          </Button>
        )}
        {waiving && (
          <div className="space-y-2">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} placeholder="Why completion can go ahead without the property back" />
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setWaiving(false)}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => waive.mutate()} loading={waive.isPending} disabled={reason.trim().length < 3}>
                Waive
              </Button>
            </div>
          </div>
        )}
      </section>

      <section className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm uppercase tracking-wider text-ink-muted">
          <KeyRound className="h-4 w-4" aria-hidden="true" /> Access
        </div>
        {d.access.removed ? <Badge variant="success">Removed</Badge> : d.access.activeLogins > 0 ? <Badge variant="pending">{d.access.activeLogins} live {d.access.activeLogins === 1 ? 'login' : 'logins'} · removed on completion</Badge> : <Badge variant="default">No login</Badge>}
      </section>
    </div>
  );
}
