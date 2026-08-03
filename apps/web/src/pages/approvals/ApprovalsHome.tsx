import { useEffect, useState } from 'react';
import { AssociateLink } from '@/components/ui/AssociateLink';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarCheck, Check, X } from 'lucide-react';
import { toast } from 'sonner';
import type { TimeOffRequest } from '@alto-people/shared';
import {
  approveAdminRequest,
  bulkDecideRequests,
  denyAdminRequest,
  listAdminRequests,
} from '@/lib/timeOffApi';
import {
  approveOpenShiftClaim,
  listAdminSwaps,
  listOpenShiftClaims,
  managerApproveSwap,
  managerRejectSwap,
  rejectOpenShiftClaim,
} from '@/lib/schedulingApi';
import { countAdminTimeEntries } from '@/lib/timeApi';
import { ApiError } from '@/lib/api';
import { fmtDate, fmtDateTime, parseYmd } from '@/lib/format';
import { PageHeader } from '@/components/ui/PageHeader';
import { MetricCard } from '@/components/ui/MetricCard';
import { Button } from '@/components/ui/Button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/Card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Field } from '@/components/ui/Field';
import { Textarea } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import { Badge } from '@/components/ui/Badge';
import { AdminUnconfirmedPanel } from '@/pages/scheduling/AdminApprovalPanels';

/**
 * One inbox for everything waiting on a manager's decision. Before this
 * page, the queues were scattered: swaps + pickups + unconfirmed shifts
 * at the bottom of /scheduling, time off in its own tab, timesheets on
 * /time-attendance — a manager had to remember to visit each one. Here
 * they all stack on a single URL that can be checked (or deep-linked)
 * in one pass.
 *
 * The swap + pickup panels here are LOCAL variants of the shared
 * AdminApprovalPanels — same queries and single-decide endpoints, plus
 * row checkboxes and an "Approve selected (n)" bulk bar (the shared
 * panels on /scheduling stay checkbox-free).
 */
const TIME_OFF_KEY = ['approvals', 'timeOff'] as const;
const SWAPS_KEY = ['approvals', 'swaps'] as const;
const PICKUPS_KEY = ['approvals', 'pickups'] as const;

export function ApprovalsHome() {
  // KPI is best-effort — the panels below are the real content. A failure
  // renders an inline retry affordance on the tile instead of a dash.
  const timesheetQuery = useQuery({
    queryKey: ['approvals', 'timesheetCount'],
    queryFn: () => countAdminTimeEntries('COMPLETED'),
  });

  const timeOffQuery = useQuery({
    queryKey: TIME_OFF_KEY,
    queryFn: async () => {
      try {
        return (await listAdminRequests('PENDING')).requests;
      } catch (err) {
        // 403 = not permitted to see the admin queue — an honest empty
        // list, not an error.
        if (err instanceof ApiError && err.status === 403) return [];
        throw err;
      }
    },
  });

  const timesheetCount = timesheetQuery.data?.count ?? null;
  const timesheetFailed = timesheetQuery.isError;
  const timeOff = timeOffQuery.data ?? null;
  const timeOffError = timeOffQuery.isError
    ? timeOffQuery.error instanceof Error
      ? timeOffQuery.error.message
      : 'Could not load time-off requests.'
    : null;

  return (
    <div>
      <PageHeader
        title="Approvals"
        subtitle="Everything waiting on your decision — swaps, pickups, time off, and timesheets."
      />

      <div className="grid grid-cols-2 gap-3 sm:max-w-md">
        <MetricCard
          label="Time off pending"
          value={timeOffError ? '—' : timeOff === null ? '…' : timeOff.length}
          accent={(timeOff?.length ?? 0) > 0}
        />
        <MetricCard
          label="Timesheets to review"
          value={
            timesheetFailed ? '—' : timesheetCount === null ? '…' : timesheetCount
          }
          accent={timesheetFailed || (timesheetCount ?? 0) > 0}
          hint={
            timesheetFailed ? (
              <span className="inline-flex items-center gap-2">
                <span role="alert" className="text-alert">
                  Couldn't load
                </span>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => timesheetQuery.refetch()}
                >
                  Retry
                </Button>
              </span>
            ) : (
              'Review on Time & Attendance'
            )
          }
          // A retry button inside a link is invalid markup — drop the link
          // while the tile is in its error state.
          wrap={
            timesheetFailed
              ? undefined
              : (children) => <Link to="/time-attendance">{children}</Link>
          }
        />
      </div>

      <PendingTimeOffPanel
        items={timeOffError ? null : timeOff}
        error={timeOffError}
        onRetry={() => timeOffQuery.refetch()}
      />
      <SwapsPanel />
      <PickupsPanel />
      <AdminUnconfirmedPanel />
    </div>
  );
}

function fmtHours(minutes: number): string {
  const h = minutes / 60;
  return `${h.toFixed(h % 1 === 0 ? 0 : 1)}h`;
}

/** Human labels for the time-off category enum (never show SICK/JURY_DUTY raw). */
const CATEGORY_LABELS: Record<string, string> = {
  SICK: 'Sick',
  VACATION: 'Vacation',
  PTO: 'PTO',
  BEREAVEMENT: 'Bereavement',
  JURY_DUTY: 'Jury duty',
  OTHER: 'Other',
};

/** Date-only "YYYY-MM-DD" — parse at local midnight so it never renders a
 *  day early west of UTC. */
const fmtYmd = (iso: string) => fmtDate(parseYmd(iso));

/* --------------------------------------------------- shared selection */

function useSelection() {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set<string>(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const clear = () => setSelected(new Set<string>());
  return { selected, toggle, clear };
}

/** Loop a single-approve endpoint over the selection; report both halves. */
async function approveAllSettled(
  ids: string[],
  fn: (id: string) => Promise<unknown>,
  noun: string,
): Promise<void> {
  const results = await Promise.allSettled(ids.map((id) => fn(id)));
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  const failed = results.length - ok;
  if (ok > 0) toast.success(`Approved ${ok} ${noun}${ok === 1 ? '' : 's'}.`);
  if (failed > 0) {
    toast.error(`${failed} ${noun}${failed === 1 ? '' : 's'} could not be approved.`);
  }
}

/* --------------------------------------------------- time-off panel */

function PendingTimeOffPanel({
  items,
  error,
  onRetry,
}: {
  items: TimeOffRequest[] | null;
  error: string | null;
  onRetry: () => void;
}) {
  const queryClient = useQueryClient();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [denyTarget, setDenyTarget] = useState<TimeOffRequest | null>(null);
  const { selected, toggle, clear } = useSelection();
  const [bulkBusy, setBulkBusy] = useState(false);

  // Optimistically drop the row from the cached list the moment a
  // decision is submitted; snapshot the previous list so onError can
  // roll it back, and let onSettled re-sync with the server.
  const removeOptimistically = async (id: string) => {
    await queryClient.cancelQueries({ queryKey: TIME_OFF_KEY });
    const previous = queryClient.getQueryData<TimeOffRequest[]>(TIME_OFF_KEY);
    queryClient.setQueryData<TimeOffRequest[]>(TIME_OFF_KEY, (old) =>
      old?.filter((r) => r.id !== id),
    );
    return { previous };
  };
  const rollback = (ctx: { previous?: TimeOffRequest[] } | undefined) => {
    if (ctx?.previous !== undefined) {
      queryClient.setQueryData(TIME_OFF_KEY, ctx.previous);
    }
  };

  const approveMutation = useMutation({
    mutationFn: (r: TimeOffRequest) => approveAdminRequest(r.id),
    onMutate: (r) => removeOptimistically(r.id),
    onError: (err, _r, ctx) => {
      rollback(ctx);
      if (err instanceof ApiError && err.code === 'insufficient_balance') {
        const d = err.details as { currentMinutes: number; requestedMinutes: number };
        toast.error('Insufficient balance.', {
          description: `Available ${fmtHours(d.currentMinutes)}, requested ${fmtHours(d.requestedMinutes)}.`,
        });
        return;
      }
      toast.error('Could not approve.', {
        description: err instanceof Error ? err.message : String(err),
      });
    },
    onSuccess: (_res, r) => {
      toast.success(`Approved ${r.associateName ?? 'request'}.`);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: TIME_OFF_KEY }),
  });

  const denyMutation = useMutation({
    mutationFn: ({ target, note }: { target: TimeOffRequest; note: string }) =>
      denyAdminRequest(target.id, { note }),
    onMutate: ({ target }) => removeOptimistically(target.id),
    onError: (err, _vars, ctx) => {
      rollback(ctx);
      toast.error('Could not deny.', {
        description: err instanceof Error ? err.message : String(err),
      });
    },
    onSuccess: () => {
      toast.success('Request denied.');
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: TIME_OFF_KEY }),
  });

  const onApprove = (r: TimeOffRequest) => {
    setPendingId(r.id);
    approveMutation.mutate(r, { onSettled: () => setPendingId(null) });
  };

  // Bulk approvals go through the server's bulk endpoint — one round-trip,
  // per-id failure reporting.
  const bulkApprove = async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBulkBusy(true);
    try {
      const res = await bulkDecideRequests({ ids, decision: 'APPROVE' });
      if (res.decided > 0) {
        toast.success(
          `Approved ${res.decided} request${res.decided === 1 ? '' : 's'}.`,
        );
      }
      if (res.failed.length > 0) {
        toast.error(
          `${res.failed.length} request${res.failed.length === 1 ? '' : 's'} could not be approved.`,
          { description: res.failed[0]?.error },
        );
      }
      clear();
    } catch (err) {
      toast.error('Could not approve selected.', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBulkBusy(false);
      queryClient.invalidateQueries({ queryKey: TIME_OFF_KEY });
    }
  };

  return (
    <Card className="mt-8">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Time-off requests awaiting your decision</CardTitle>
          {selected.size > 0 && (
            <Button size="sm" onClick={bulkApprove} loading={bulkBusy}>
              Approve selected ({selected.size})
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {error && (
          <div className="space-y-3">
            <ErrorBanner>{error}</ErrorBanner>
            <Button size="sm" variant="secondary" onClick={onRetry}>
              Retry
            </Button>
          </div>
        )}
        {!error && !items && <Skeleton className="h-16" />}
        {!error && items && items.length === 0 && (
          <p className="text-silver text-sm flex items-center gap-2">
            <CalendarCheck className="h-4 w-4" aria-hidden="true" />
            No time-off requests waiting.
          </p>
        )}
        {!error && items && items.length > 0 && (
          <ul className="space-y-2">
            {items.map((r) => (
              <li
                key={r.id}
                className="p-3 bg-navy-secondary/30 border border-navy-secondary rounded-md flex items-start justify-between gap-3 flex-wrap"
              >
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    className="mt-1"
                    aria-label={`Select request from ${r.associateName ?? 'associate'}`}
                    checked={selected.has(r.id)}
                    onChange={() => toggle(r.id)}
                  />
                  <div>
                    <div className="text-white text-sm font-medium">
                      {r.associateName ?? '—'}
                    </div>
                    <div className="text-xs text-silver mt-0.5 tabular-nums">
                      {CATEGORY_LABELS[r.category] ?? r.category} · {fmtYmd(r.startDate)}
                      {r.startDate !== r.endDate && ` – ${fmtYmd(r.endDate)}`} ·{' '}
                      {fmtHours(r.requestedMinutes)}
                    </div>
                    {r.reason && (
                      <div className="text-xs text-silver/70 italic mt-1">
                        "{r.reason}"
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="pending">Pending</Badge>
                  <Button
                    size="sm"
                    onClick={() => onApprove(r)}
                    disabled={pendingId === r.id || bulkBusy}
                  >
                    <Check className="h-4 w-4" />
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => setDenyTarget(r)}
                    disabled={pendingId === r.id || bulkBusy}
                  >
                    <X className="h-4 w-4" />
                    Deny
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <DenyDialog
        target={denyTarget}
        onSubmit={(target, note) => denyMutation.mutate({ target, note })}
        onClose={() => setDenyTarget(null)}
      />
    </Card>
  );
}

function DenyDialog({
  target,
  onSubmit,
  onClose,
}: {
  target: TimeOffRequest | null;
  onSubmit: (target: TimeOffRequest, note: string) => void;
  onClose: () => void;
}) {
  const [note, setNote] = useState('');
  const open = target !== null;

  useEffect(() => {
    if (open) setNote('');
  }, [open]);

  const submit = () => {
    if (!target) return;
    const trimmed = note.trim();
    if (trimmed.length === 0) {
      toast.error('A note is required when denying.');
      return;
    }
    // Optimistic: the row disappears the moment the deny is submitted;
    // the mutation rolls it back (with a toast) if the server rejects.
    onSubmit(target, trimmed);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Deny request</DialogTitle>
          <DialogDescription>
            The associate will see your note in their request history.
          </DialogDescription>
        </DialogHeader>
        <Field label="Note" required>
          {(p) => (
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Coverage gap that week, etc."
              maxLength={500}
              rows={3}
              {...p}
            />
          )}
        </Field>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onClose()}>
            Cancel
          </Button>
          <Button onClick={submit} variant="destructive">
            Deny
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* --------------------------------------------------- swaps panel */

function SwapsPanel() {
  const queryClient = useQueryClient();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const { selected, toggle, clear } = useSelection();
  const [bulkBusy, setBulkBusy] = useState(false);

  const swapsQuery = useQuery({
    queryKey: SWAPS_KEY,
    queryFn: () => listAdminSwaps({ status: 'PEER_ACCEPTED' }),
  });
  const items = swapsQuery.data?.requests ?? null;
  const error = swapsQuery.isError
    ? swapsQuery.error instanceof ApiError
      ? swapsQuery.error.message
      : 'Failed to load swaps.'
    : null;

  const decide = async (
    id: string,
    fn: () => Promise<unknown>,
    successMsg: string,
  ) => {
    setPendingId(id);
    try {
      await fn();
      toast.success(successMsg);
      await queryClient.invalidateQueries({ queryKey: SWAPS_KEY });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Action failed.');
    } finally {
      setPendingId(null);
    }
  };

  // No bulk endpoint for swaps — loop the single-approve calls and settle
  // them all, then report both halves.
  const bulkApprove = async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBulkBusy(true);
    await approveAllSettled(ids, (id) => managerApproveSwap(id), 'swap');
    clear();
    setBulkBusy(false);
    queryClient.invalidateQueries({ queryKey: SWAPS_KEY });
  };

  return (
    <Card className="mt-8">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Swap requests awaiting your approval</CardTitle>
          {selected.size > 0 && (
            <Button size="sm" onClick={bulkApprove} loading={bulkBusy}>
              Approve selected ({selected.size})
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {error && (
          <div className="space-y-3">
            <ErrorBanner>{error}</ErrorBanner>
            <Button size="sm" variant="secondary" onClick={() => swapsQuery.refetch()}>
              Retry
            </Button>
          </div>
        )}
        {!error && !items && <Skeleton className="h-16" />}
        {!error && items && items.length === 0 && (
          <p className="text-silver text-sm">
            No swap requests need your approval.
          </p>
        )}
        {!error && items && items.length > 0 && (
          <ul className="space-y-2">
            {items.map((s) => (
              <li
                key={s.id}
                className="p-3 bg-navy-secondary/30 border border-navy-secondary rounded-md flex items-start justify-between gap-3 flex-wrap"
              >
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    className="mt-1"
                    aria-label={`Select swap from ${s.requesterName}`}
                    checked={selected.has(s.id)}
                    onChange={() => toggle(s.id)}
                  />
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
                      <div className="text-xs text-silver/70 italic mt-1">
                        "{s.note}"
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {s.wouldExceed40h && (
                    <Badge variant="destructive">Over 40h</Badge>
                  )}
                  <Button
                    size="sm"
                    onClick={() =>
                      decide(s.id, () => managerApproveSwap(s.id), 'Swap approved.')
                    }
                    disabled={pendingId === s.id || bulkBusy}
                  >
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() =>
                      decide(s.id, () => managerRejectSwap(s.id), 'Swap rejected.')
                    }
                    disabled={pendingId === s.id || bulkBusy}
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

/* --------------------------------------------------- pickups panel */

function PickupsPanel() {
  const queryClient = useQueryClient();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const { selected, toggle, clear } = useSelection();
  const [bulkBusy, setBulkBusy] = useState(false);

  const pickupsQuery = useQuery({
    queryKey: PICKUPS_KEY,
    queryFn: () => listOpenShiftClaims(),
  });
  const items = pickupsQuery.data?.claims ?? null;
  const error = pickupsQuery.isError
    ? pickupsQuery.error instanceof ApiError
      ? pickupsQuery.error.message
      : 'Failed to load pickup requests.'
    : null;

  const decide = async (
    id: string,
    fn: () => Promise<unknown>,
    successMsg: string,
  ) => {
    setPendingId(id);
    try {
      await fn();
      toast.success(successMsg);
      await queryClient.invalidateQueries({ queryKey: PICKUPS_KEY });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Action failed.');
    } finally {
      setPendingId(null);
    }
  };

  const bulkApprove = async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBulkBusy(true);
    await approveAllSettled(ids, (id) => approveOpenShiftClaim(id), 'pickup');
    clear();
    setBulkBusy(false);
    queryClient.invalidateQueries({ queryKey: PICKUPS_KEY });
  };

  return (
    <Card className="mt-8">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Open-shift pickup requests</CardTitle>
          {selected.size > 0 && (
            <Button size="sm" onClick={bulkApprove} loading={bulkBusy}>
              Approve selected ({selected.size})
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {error && (
          <div className="space-y-3">
            <ErrorBanner>{error}</ErrorBanner>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => pickupsQuery.refetch()}
            >
              Retry
            </Button>
          </div>
        )}
        {!error && !items && <Skeleton className="h-16" />}
        {!error && items && items.length === 0 && (
          <p className="text-silver text-sm">
            No pickup requests waiting. Associates see published open shifts
            at their clients and can ask to take them.
          </p>
        )}
        {!error && items && items.length > 0 && (
          <ul className="space-y-2">
            {items.map((c) => (
              <li
                key={c.id}
                className="p-3 bg-navy-secondary/30 border border-navy-secondary rounded-md flex items-start justify-between gap-3 flex-wrap"
              >
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    className="mt-1"
                    aria-label={`Select pickup from ${c.associateName}`}
                    checked={selected.has(c.id)}
                    onChange={() => toggle(c.id)}
                  />
                  <div>
                    <div className="text-white text-sm">
                      <AssociateLink associateId={c.associateId} className="font-medium">
                        {c.associateName}
                      </AssociateLink>
                      {' wants '}
                      <span className="font-medium">{c.shiftPosition}</span>
                    </div>
                    <div className="text-xs text-silver mt-0.5 tabular-nums">
                      {c.shiftClientName ?? '—'} · {fmtDateTime(c.shiftStartsAt)}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {c.wouldExceed40h && (
                    <Badge variant="destructive">Over 40h</Badge>
                  )}
                  <Button
                    size="sm"
                    onClick={() =>
                      decide(
                        c.id,
                        () => approveOpenShiftClaim(c.id),
                        'Pickup approved — shift assigned.',
                      )
                    }
                    disabled={pendingId === c.id || bulkBusy}
                  >
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() =>
                      decide(c.id, () => rejectOpenShiftClaim(c.id), 'Pickup rejected.')
                    }
                    disabled={pendingId === c.id || bulkBusy}
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
