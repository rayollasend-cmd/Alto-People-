import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AdminOpenShiftClaim, ShiftSwapRequest } from '@alto-people/shared';
import {
  approveOpenShiftClaim,
  listAdminSwaps,
  listOpenShiftClaims,
  listShifts,
  managerApproveSwap,
  managerRejectSwap,
  nudgeUnconfirmedShifts,
  rejectOpenShiftClaim,
} from '@/lib/schedulingApi';
import { ApiError } from '@/lib/api';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { toast } from '@/components/ui/Toaster';
import { fmtDateTime } from '@/lib/format';
import { statusTone } from '@/lib/status';

/**
 * The manager approval panels shared by /scheduling and /approvals.
 *
 * Extracted from AdminSchedulingView: the approvals page importing them
 * from there dragged the entire ~4000-line scheduling module (calendar
 * views, dialogs, auto-fill) into the /approvals lazy chunk. As their
 * own module, both pages share one small chunk instead.
 */

/* ===== Swaps panel ======================================================== */

// Swap codes are mostly domain-only (peer-negotiation states the shared
// vocabulary doesn't carry); PEER_ACCEPTED stays amber because the manager
// still has to decide. MANAGER_APPROVED and CANCELLED come from the shared
// status vocabulary.
const SWAP_STATUS_TONES = {
  PENDING_PEER: 'pending',
  PEER_ACCEPTED: 'pending',
  PEER_DECLINED: 'destructive',
  MANAGER_REJECTED: 'destructive',
} as const;

// Human-readable labels — raw enum values never reach the user's eyes.
const SWAP_STATUS_LABELS: Record<ShiftSwapRequest['status'], string> = {
  PENDING_PEER: 'Awaiting peer',
  PEER_ACCEPTED: 'Peer accepted',
  PEER_DECLINED: 'Peer declined',
  MANAGER_APPROVED: 'Approved',
  MANAGER_REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
};

const SWAPS_KEY = ['approvals', 'swaps'] as const;

export function AdminSwapsPanel() {
  const queryClient = useQueryClient();
  const [pendingId, setPendingId] = useState<string | null>(null);

  const swapsQuery = useQuery({
    queryKey: SWAPS_KEY,
    queryFn: () => listAdminSwaps({ status: 'PEER_ACCEPTED' }),
  });
  const items = swapsQuery.data?.requests ?? null;

  const loadError = swapsQuery.error;
  useEffect(() => {
    if (loadError) {
      toast.error(loadError instanceof ApiError ? loadError.message : 'Failed to load swaps.');
    }
  }, [loadError]);

  const decideMutation = useMutation({
    mutationFn: (vars: { id: string; fn: () => Promise<unknown>; successMsg: string }) =>
      vars.fn(),
    onSuccess: (_res, { successMsg }) => {
      toast.success(successMsg);
      // Returned so the row's pending state holds until the refetched
      // list lands — same ordering as the old await-refresh wrap().
      return queryClient.invalidateQueries({ queryKey: SWAPS_KEY });
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : 'Action failed.');
    },
  });

  const wrap = (id: string, fn: () => Promise<unknown>, successMsg: string) => {
    setPendingId(id);
    decideMutation.mutate(
      { id, fn, successMsg },
      { onSettled: () => setPendingId(null) },
    );
  };

  return (
    <Card className="mt-8">
      <CardHeader>
        <CardTitle>Swap requests awaiting your approval</CardTitle>
      </CardHeader>
      <CardContent>
        {/* Gate the skeleton on the error — a failed load used to shimmer
            forever with only a transient toast. */}
        {loadError != null && (
          <ErrorBanner
            action={
              <Button size="sm" variant="secondary" onClick={() => void swapsQuery.refetch()}>
                Retry
              </Button>
            }
          >
            Could not load swap requests.
          </ErrorBanner>
        )}
        {!items && loadError == null && <Skeleton className="h-16" />}
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
                  <Badge variant={statusTone(s.status, { overrides: SWAP_STATUS_TONES })}>
                    {SWAP_STATUS_LABELS[s.status] ?? s.status}
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

const PICKUPS_KEY = ['approvals', 'pickups'] as const;

/** Requests for one shift, best candidate first. */
interface PickupGroup {
  shiftId: string;
  position: string;
  clientName: string | null;
  startsAt: string;
  candidates: AdminOpenShiftClaim[];
}

/**
 * Ranking: overtime-safe candidates before over-40h ones; within a band,
 * fewest scheduled hours that week; ties go to whoever asked first.
 */
function rankCandidates(a: AdminOpenShiftClaim, b: AdminOpenShiftClaim): number {
  if (a.wouldExceed40h !== b.wouldExceed40h) return a.wouldExceed40h ? 1 : -1;
  const am = a.weeklyMinutes ?? Number.MAX_SAFE_INTEGER;
  const bm = b.weeklyMinutes ?? Number.MAX_SAFE_INTEGER;
  if (am !== bm) return am - bm;
  return a.createdAt.localeCompare(b.createdAt);
}

export function AdminPickupPanel() {
  const queryClient = useQueryClient();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filling, setFilling] = useState(false);

  const pickupsQuery = useQuery({
    queryKey: PICKUPS_KEY,
    queryFn: () => listOpenShiftClaims(),
  });
  const items = pickupsQuery.data?.claims ?? null;

  const loadError = pickupsQuery.error;
  useEffect(() => {
    if (loadError) {
      toast.error(
        loadError instanceof ApiError ? loadError.message : 'Failed to load pickup requests.',
      );
    }
  }, [loadError]);

  // One entry per SHIFT, not per request — 25 people asking for the same
  // overnight shift is one decision, not 25 rows. Soonest shift first.
  const groups = useMemo<PickupGroup[] | null>(() => {
    if (!items) return null;
    const byShift = new Map<string, PickupGroup>();
    for (const c of items) {
      const g = byShift.get(c.shiftId) ?? {
        shiftId: c.shiftId,
        position: c.shiftPosition,
        clientName: c.shiftClientName,
        startsAt: c.shiftStartsAt,
        candidates: [],
      };
      g.candidates.push(c);
      byShift.set(c.shiftId, g);
    }
    const out = [...byShift.values()];
    for (const g of out) g.candidates.sort(rankCandidates);
    out.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    return out;
  }, [items]);

  const decideMutation = useMutation({
    mutationFn: (vars: { id: string; fn: () => Promise<unknown>; successMsg: string }) =>
      vars.fn(),
    onSuccess: (_res, { successMsg }) => {
      toast.success(successMsg);
      // Returned so the row's pending state holds until the refetched
      // list lands — same ordering as the old await-refresh wrap().
      return queryClient.invalidateQueries({ queryKey: PICKUPS_KEY });
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : 'Action failed.');
    },
  });

  const wrap = (id: string, fn: () => Promise<unknown>, successMsg: string) => {
    setPendingId(id);
    decideMutation.mutate(
      { id, fn, successMsg },
      { onSettled: () => setPendingId(null) },
    );
  };

  // One click fills every shift that has an overtime-safe requester: the
  // top-ranked candidate per shift is approved (the server auto-declines
  // the rest of that shift's queue). Shifts whose every requester would
  // cross 40h are left for a human. Failures (someone grabbed the shift
  // concurrently, fresh PTO) skip that shift, never the batch.
  const fillFromRequests = async () => {
    if (!groups || filling) return;
    setFilling(true);
    let filled = 0;
    let leftOt = 0;
    let failed = 0;
    for (const g of groups) {
      const best = g.candidates.find((c) => !c.wouldExceed40h);
      if (!best) {
        leftOt += 1;
        continue;
      }
      try {
        await approveOpenShiftClaim(best.id);
        filled += 1;
      } catch {
        failed += 1;
      }
    }
    setFilling(false);
    await queryClient.invalidateQueries({ queryKey: PICKUPS_KEY });
    const parts = [`Filled ${filled} shift${filled === 1 ? '' : 's'}`];
    if (leftOt > 0) parts.push(`${leftOt} left for review (only over-40h requesters)`);
    if (failed > 0) parts.push(`${failed} failed (likely filled meanwhile)`);
    toast.success(parts.join(' · '));
  };

  const hours = (c: AdminOpenShiftClaim) =>
    c.weeklyMinutes != null ? `${(c.weeklyMinutes / 60).toFixed(1)}h wk` : null;

  const candidateRow = (c: AdminOpenShiftClaim) => (
    <li key={c.id} className="flex items-center justify-between gap-2 py-1.5">
      <div className="min-w-0 flex items-center gap-2">
        <span className="truncate text-sm text-white">{c.associateName}</span>
        {hours(c) && (
          <span className="shrink-0 text-2xs tabular-nums text-silver/60">{hours(c)}</span>
        )}
        {c.wouldExceed40h && <Badge variant="destructive">Over 40h</Badge>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          size="sm"
          onClick={() =>
            wrap(c.id, () => approveOpenShiftClaim(c.id), 'Pickup approved — shift assigned.')
          }
          disabled={pendingId === c.id}
        >
          Approve
        </Button>
        <Button
          size="sm"
          variant="destructive"
          onClick={() => wrap(c.id, () => rejectOpenShiftClaim(c.id), 'Pickup rejected.')}
          disabled={pendingId === c.id}
        >
          Reject
        </Button>
      </div>
    </li>
  );

  return (
    <Card className="mt-8">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>
            Open-shift pickup requests
            {groups && groups.length > 0 && (
              <span className="ml-2 text-sm font-normal text-silver/70 tabular-nums">
                {groups.length} shift{groups.length === 1 ? '' : 's'} ·{' '}
                {items?.length ?? 0} requests
              </span>
            )}
          </CardTitle>
          {groups && groups.length > 1 && (
            <Button
              size="sm"
              onClick={() => void fillFromRequests()}
              loading={filling}
              title="Approve the best overtime-safe requester for every shift; the rest auto-decline. Shifts with only over-40h requesters are left for you."
            >
              Fill {groups.length} shifts from requests
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {loadError != null && (
          <ErrorBanner
            action={
              <Button size="sm" variant="secondary" onClick={() => void pickupsQuery.refetch()}>
                Retry
              </Button>
            }
          >
            Could not load pickup requests.
          </ErrorBanner>
        )}
        {!groups && loadError == null && <Skeleton className="h-16" />}
        {groups && groups.length === 0 && (
          <p className="text-silver text-sm">
            No pickup requests waiting. Associates see published open shifts
            at their clients and can ask to take them.
          </p>
        )}
        {groups && groups.length > 0 && (
          <ul className="space-y-2">
            {groups.map((g) => {
              const best = g.candidates[0];
              const isOpen = expanded.has(g.shiftId);
              const others = g.candidates.length - 1;
              return (
                <li
                  key={g.shiftId}
                  className="rounded-md border border-navy-secondary bg-navy-secondary/30 p-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-sm text-white">
                        <span className="font-medium">{g.position}</span>
                        <span className="text-silver/70"> · {g.clientName ?? '—'}</span>
                      </div>
                      <div className="mt-0.5 text-xs tabular-nums text-silver">
                        {fmtDateTime(g.startsAt)} · {g.candidates.length} request
                        {g.candidates.length === 1 ? '' : 's'}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {best.wouldExceed40h ? (
                        <Badge variant="destructive">All over 40h</Badge>
                      ) : (
                        <Button
                          size="sm"
                          onClick={() =>
                            wrap(
                              best.id,
                              () => approveOpenShiftClaim(best.id),
                              `Approved ${best.associateName} — others auto-declined.`,
                            )
                          }
                          disabled={pendingId === best.id}
                          title={`Best fit: fewest hours this week${hours(best) ? ` (${hours(best)})` : ''}; the other requesters auto-decline.`}
                        >
                          Approve {best.associateName.split(' ')[0]}
                        </Button>
                      )}
                      {others > 0 && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            setExpanded((prev) => {
                              const next = new Set(prev);
                              if (next.has(g.shiftId)) next.delete(g.shiftId);
                              else next.add(g.shiftId);
                              return next;
                            })
                          }
                        >
                          {isOpen ? 'Hide' : `All ${g.candidates.length}`}
                        </Button>
                      )}
                    </div>
                  </div>
                  {(isOpen || others === 0) && (
                    <ul className="mt-2 divide-y divide-navy-secondary/60 border-t border-navy-secondary/60">
                      {g.candidates.map(candidateRow)}
                    </ul>
                  )}
                </li>
              );
            })}
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
const UNCONFIRMED_KEY = ['approvals', 'unconfirmed'] as const;

export function AdminUnconfirmedPanel() {
  const [nudging, setNudging] = useState(false);
  const unconfirmedQuery = useQuery({
    queryKey: UNCONFIRMED_KEY,
    queryFn: async () => {
      try {
        const now = new Date();
        const to = new Date(now.getTime() + 48 * 3_600_000);
        const res = await listShifts({
          status: 'ASSIGNED',
          from: now.toISOString(),
          to: to.toISOString(),
        });
        return res.shifts.filter((s) => s.publishedAt && !s.acknowledgedAt);
      } catch {
        // Best-effort chase list — a load failure just hides the panel.
        return [];
      }
    },
  });
  const items = unconfirmedQuery.data ?? null;

  if (!items || items.length === 0) return null;

  return (
    <Card className="mt-8">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>
            Not yet confirmed by the associate ({items.length})
          </CardTitle>
          <Button
            size="sm"
            loading={nudging}
            onClick={() => {
              setNudging(true);
              nudgeUnconfirmedShifts()
                .then((r) => {
                  toast.success(
                    r.nudged > 0
                      ? `Reminder sent to ${r.nudged} associate${r.nudged === 1 ? '' : 's'} — asked to tap "I'll be there".`
                      : 'Everyone here was already reminded in the last 20 hours.',
                  );
                })
                .catch((err) => {
                  toast.error(
                    err instanceof ApiError ? err.message : 'Could not send reminders.',
                  );
                })
                .finally(() => setNudging(false));
            }}
            title='One tap asks every unconfirmed associate to confirm; anyone reminded in the last 20 hours is skipped. The system also auto-reminds 24 hours before start.'
          >
            Send reminder to all
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-silver/70 mb-3">
          Starting within 48 hours and the associate hasn't tapped "I'll be
          there". The system auto-reminds them 24h out; the button re-asks
          everyone now. Worth a call only if a critical shift stays silent.
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
