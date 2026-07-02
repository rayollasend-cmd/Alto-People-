import { useCallback, useEffect, useState } from 'react';
import type {
  AdminOpenShiftClaim,
  Shift,
  ShiftSwapRequest,
} from '@alto-people/shared';
import {
  approveOpenShiftClaim,
  listAdminSwaps,
  listOpenShiftClaims,
  listShifts,
  managerApproveSwap,
  managerRejectSwap,
  rejectOpenShiftClaim,
} from '@/lib/schedulingApi';
import { ApiError } from '@/lib/api';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { toast } from '@/components/ui/Toaster';
import { fmtDateTime } from '@/lib/format';

/**
 * The manager approval panels shared by /scheduling and /approvals.
 *
 * Extracted from AdminSchedulingView: the approvals page importing them
 * from there dragged the entire ~4000-line scheduling module (calendar
 * views, dialogs, auto-fill) into the /approvals lazy chunk. As their
 * own module, both pages share one small chunk instead.
 */

/* ===== Swaps panel ======================================================== */

const SWAP_STATUS_VARIANT: Record<
  ShiftSwapRequest['status'],
  'success' | 'pending' | 'destructive' | 'default'
> = {
  PENDING_PEER: 'pending',
  PEER_ACCEPTED: 'pending',
  PEER_DECLINED: 'destructive',
  MANAGER_APPROVED: 'success',
  MANAGER_REJECTED: 'destructive',
  CANCELLED: 'default',
};

export function AdminSwapsPanel() {
  const [items, setItems] = useState<ShiftSwapRequest[] | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await listAdminSwaps({ status: 'PEER_ACCEPTED' });
      setItems(res.requests);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to load swaps.');
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const wrap = async (id: string, fn: () => Promise<unknown>, successMsg: string) => {
    setPendingId(id);
    try {
      await fn();
      toast.success(successMsg);
      await refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Action failed.');
    } finally {
      setPendingId(null);
    }
  };

  return (
    <Card className="mt-8">
      <CardHeader>
        <CardTitle>Swap requests awaiting your approval</CardTitle>
      </CardHeader>
      <CardContent>
        {!items && <Skeleton className="h-16" />}
        {items && items.length === 0 && (
          <p className="text-silver text-sm">
            No swap requests need your approval.
          </p>
        )}
        {items && items.length > 0 && (
          <ul className="space-y-2">
            {items.map((s) => (
              <li
                key={s.id}
                className="p-3 bg-navy-secondary/30 border border-navy-secondary rounded-md flex items-start justify-between gap-3 flex-wrap"
              >
                <div>
                  <div className="text-white text-sm">
                    <span className="font-medium">{s.requesterName}</span>
                    {' → '}
                    <span className="font-medium">{s.counterpartyName}</span>
                  </div>
                  <div className="text-xs text-silver mt-0.5">
                    {s.shiftPosition} · {s.shiftClientName ?? '—'} ·{' '}
                    <span className="tabular-nums">
                      {fmtDateTime(s.shiftStartsAt)}
                    </span>
                  </div>
                  {s.inExchange && (
                    <div className="text-xs text-gold/90 mt-0.5 tabular-nums">
                      Trade — {s.requesterName} takes: {s.inExchange.position} ·{' '}
                      {fmtDateTime(s.inExchange.startsAt)}
                    </div>
                  )}
                  {s.note && (
                    <div className="text-xs text-silver/70 italic mt-1">"{s.note}"</div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {s.wouldExceed40h && (
                    <Badge variant="destructive">Over 40h</Badge>
                  )}
                  <Badge variant={SWAP_STATUS_VARIANT[s.status]}>
                    {s.status.replace(/_/g, ' ')}
                  </Badge>
                  <Button
                    size="sm"
                    onClick={() =>
                      wrap(s.id, () => managerApproveSwap(s.id), 'Swap approved.')
                    }
                    disabled={pendingId === s.id}
                  >
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() =>
                      wrap(s.id, () => managerRejectSwap(s.id), 'Swap rejected.')
                    }
                    disabled={pendingId === s.id}
                  >
                    Reject
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/* ===== Open-shift pickup requests panel ================================== */

export function AdminPickupPanel() {
  const [items, setItems] = useState<AdminOpenShiftClaim[] | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await listOpenShiftClaims();
      setItems(res.claims);
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : 'Failed to load pickup requests.',
      );
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const wrap = async (id: string, fn: () => Promise<unknown>, successMsg: string) => {
    setPendingId(id);
    try {
      await fn();
      toast.success(successMsg);
      await refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Action failed.');
    } finally {
      setPendingId(null);
    }
  };

  return (
    <Card className="mt-8">
      <CardHeader>
        <CardTitle>Open-shift pickup requests</CardTitle>
      </CardHeader>
      <CardContent>
        {!items && <Skeleton className="h-16" />}
        {items && items.length === 0 && (
          <p className="text-silver text-sm">
            No pickup requests waiting. Associates see published open shifts
            at their clients and can ask to take them.
          </p>
        )}
        {items && items.length > 0 && (
          <ul className="space-y-2">
            {items.map((c) => (
              <li
                key={c.id}
                className="p-3 bg-navy-secondary/30 border border-navy-secondary rounded-md flex items-start justify-between gap-3 flex-wrap"
              >
                <div>
                  <div className="text-white text-sm">
                    <span className="font-medium">{c.associateName}</span>
                    {' wants '}
                    <span className="font-medium">{c.shiftPosition}</span>
                  </div>
                  <div className="text-xs text-silver mt-0.5 tabular-nums">
                    {c.shiftClientName ?? '—'} · {fmtDateTime(c.shiftStartsAt)}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {c.wouldExceed40h && (
                    <Badge variant="destructive">Over 40h</Badge>
                  )}
                  <Button
                    size="sm"
                    onClick={() =>
                      wrap(
                        c.id,
                        () => approveOpenShiftClaim(c.id),
                        'Pickup approved — shift assigned.',
                      )
                    }
                    disabled={pendingId === c.id}
                  >
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() =>
                      wrap(c.id, () => rejectOpenShiftClaim(c.id), 'Pickup rejected.')
                    }
                    disabled={pendingId === c.id}
                  >
                    Reject
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/* ===== Unconfirmed shifts panel ========================================== */

/**
 * Published, assigned shifts starting in the next 48h whose associate has
 * NOT tapped "I'll be there". Hidden entirely when everyone confirmed —
 * this panel exists to chase silence, not to celebrate compliance.
 */
export function AdminUnconfirmedPanel() {
  const [items, setItems] = useState<Shift[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const now = new Date();
        const to = new Date(now.getTime() + 48 * 3_600_000);
        const res = await listShifts({
          status: 'ASSIGNED',
          from: now.toISOString(),
          to: to.toISOString(),
        });
        if (!cancelled) {
          setItems(res.shifts.filter((s) => s.publishedAt && !s.acknowledgedAt));
        }
      } catch {
        if (!cancelled) setItems([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!items || items.length === 0) return null;

  return (
    <Card className="mt-8">
      <CardHeader>
        <CardTitle>
          Not yet confirmed by the associate ({items.length})
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-silver/70 mb-3">
          Starting within 48 hours and the associate hasn't tapped "I'll be
          there". Worth a call if the shift is critical.
        </p>
        <ul className="space-y-2">
          {items.map((s) => (
            <li
              key={s.id}
              className="p-3 bg-navy-secondary/30 border border-navy-secondary rounded-md flex items-center justify-between gap-3 flex-wrap"
            >
              <div>
                <div className="text-white text-sm font-medium">
                  {s.assignedAssociateName ?? '—'}
                </div>
                <div className="text-xs text-silver mt-0.5 tabular-nums">
                  {s.position} · {s.clientName ?? '—'} · {fmtDateTime(s.startsAt)}
                </div>
              </div>
              <Badge variant="pending">Unconfirmed</Badge>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
