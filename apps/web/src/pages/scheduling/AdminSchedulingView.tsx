import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  Calendar,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  List,
  Plus,
  Sparkles,
  UserPlus,
  X,
} from 'lucide-react';
import type {
  AutoFillCandidate,
  ClientSummary,
  Shift,
  ShiftStatus,
  ShiftSwapRequest,
} from '@alto-people/shared';
import {
  assignShift,
  cancelShift,
  createShift,
  getAutoFillCandidates,
  getSchedulingKpis,
  getShiftConflicts,
  listAdminSwaps,
  listShifts,
  managerApproveSwap,
  managerRejectSwap,
  unassignShift,
  type SchedulingKpis,
} from '@/lib/schedulingApi';
import { apiFetch, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input, Textarea } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Skeleton } from '@/components/ui/Skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';
import { toast } from '@/components/ui/Toaster';
import { cn } from '@/lib/cn';
import {
  WeekCalendarView,
  endOfWeekMonday,
  shiftWeek,
  startOfWeekMonday,
} from './WeekCalendarView';

const STATUS_FILTERS: Array<{ value: ShiftStatus | 'ALL'; label: string }> = [
  { value: 'OPEN', label: 'Open' },
  { value: 'ASSIGNED', label: 'Assigned' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'CANCELLED', label: 'Cancelled' },
  { value: 'ALL', label: 'All' },
];

const STATUS_VARIANT: Record<
  ShiftStatus,
  'success' | 'pending' | 'destructive' | 'default' | 'accent'
> = {
  OPEN: 'pending',
  ASSIGNED: 'success',
  DRAFT: 'default',
  COMPLETED: 'success',
  CANCELLED: 'destructive',
};

function fmt(iso: string): string {
  return new Date(iso).toLocaleString();
}

/**
 * <input type="datetime-local"> wants "YYYY-MM-DDTHH:MM" in *local* time.
 * `toISOString()` gives UTC and breaks the form. This builds the local
 * representation manually.
 */
function toLocalDatetimeInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

interface AdminSchedulingViewProps {
  canManage: boolean;
}

export function AdminSchedulingView({ canManage }: AdminSchedulingViewProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  // View mode persists in the URL so deep links stay stable.
  const view: 'list' | 'week' = searchParams.get('view') === 'week' ? 'week' : 'list';
  const setView = (v: 'list' | 'week') => {
    const next = new URLSearchParams(searchParams);
    if (v === 'list') next.delete('view');
    else next.set('view', 'week');
    setSearchParams(next, { replace: true });
  };

  const [filter, setFilter] = useState<ShiftStatus | 'ALL'>('OPEN');
  const [shifts, setShifts] = useState<Shift[] | null>(null);
  const [clients, setClients] = useState<ClientSummary[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [createInitialDate, setCreateInitialDate] = useState<Date | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  // Week-view state. weekStart is always a Monday at 00:00 local.
  const [weekStart, setWeekStart] = useState<Date>(() => startOfWeekMonday(new Date()));
  const weekEnd = useMemo(() => endOfWeekMonday(weekStart), [weekStart]);

  // KPI strip — always pulls the *current* week regardless of which week
  // the calendar is showing, so the "right now" signal stays consistent.
  const [kpis, setKpis] = useState<SchedulingKpis | null>(null);
  useEffect(() => {
    getSchedulingKpis().then(setKpis).catch(() => setKpis(null));
    // shifts changing is a proxy for "something happened" — refresh KPIs
    // after assigns / cancels / publishes so the strip doesn't go stale.
  }, [shifts]);

  // Dialog state — replaces window.prompt + window.confirm.
  const [assignTarget, setAssignTarget] = useState<Shift | null>(null);
  const [cancelTarget, setCancelTarget] = useState<Shift | null>(null);
  const [autoFillForShift, setAutoFillForShift] = useState<{
    shiftId: string;
    candidates: AutoFillCandidate[];
  } | null>(null);

  const refresh = useCallback(async () => {
    try {
      // Week view always loads the visible window regardless of status
      // filter (status filter only applies to the list view).
      const args =
        view === 'week'
          ? { from: weekStart.toISOString(), to: weekEnd.toISOString() }
          : filter === 'ALL'
            ? {}
            : { status: filter };
      const res = await listShifts(args);
      setShifts(res.shifts);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to load shifts.';
      toast.error(msg);
    }
  }, [filter, view, weekStart, weekEnd]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!canManage) return;
    (async () => {
      try {
        const res = await apiFetch<{ clients: ClientSummary[] }>('/clients');
        setClients(res.clients);
      } catch {
        // Silent — Create form falls back to free-text Client UUID entry.
      }
    })();
  }, [canManage]);

  const onAutoFill = async (id: string) => {
    if (pendingId) return;
    setPendingId(id);
    try {
      const res = await getAutoFillCandidates(id);
      setAutoFillForShift({ shiftId: id, candidates: res.candidates });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Auto-fill failed.');
    } finally {
      setPendingId(null);
    }
  };

  const onPickAutoFill = async (associateId: string) => {
    if (!autoFillForShift) return;
    setPendingId(autoFillForShift.shiftId);
    try {
      await assignShift(autoFillForShift.shiftId, { associateId });
      setAutoFillForShift(null);
      toast.success('Shift assigned.');
      await refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Assign failed.');
    } finally {
      setPendingId(null);
    }
  };

  const onUnassign = async (s: Shift) => {
    if (pendingId) return;
    setPendingId(s.id);
    try {
      await unassignShift(s.id);
      toast.success('Shift unassigned.');
      await refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Unassign failed.');
    } finally {
      setPendingId(null);
    }
  };

  return (
    <div className="max-w-6xl mx-auto">
      <header className="mb-6 flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-4xl md:text-5xl text-white mb-2 leading-tight">
            Scheduling
          </h1>
          <p className="text-silver">
            {canManage
              ? 'Plan shifts, assign associates, and track fill status.'
              : 'Read-only view of scheduled shifts.'}
          </p>
        </div>
        {canManage && (
          <Button onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4" />
            New shift
          </Button>
        )}
      </header>

      {canManage && <KpiStrip kpis={kpis} />}

      {canManage && (
        <CreateShiftDialog
          open={showCreate}
          clients={clients}
          initialDate={createInitialDate}
          onOpenChange={(o) => {
            setShowCreate(o);
            if (!o) setCreateInitialDate(null);
          }}
          onCreated={() => {
            setShowCreate(false);
            setCreateInitialDate(null);
            toast.success('Shift created.');
            refresh();
          }}
        />
      )}

      {/* View-mode toggle + (in week view) week navigator */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="inline-flex rounded-md border border-navy-secondary p-0.5 bg-navy-secondary/30">
          <button
            type="button"
            onClick={() => setView('list')}
            className={cn(
              'px-3 py-1 text-xs uppercase tracking-wider rounded-sm transition-colors inline-flex items-center gap-1.5',
              view === 'list' ? 'bg-gold text-navy' : 'text-silver hover:text-white'
            )}
          >
            <List className="h-3.5 w-3.5" />
            List
          </button>
          <button
            type="button"
            onClick={() => setView('week')}
            className={cn(
              'px-3 py-1 text-xs uppercase tracking-wider rounded-sm transition-colors inline-flex items-center gap-1.5',
              view === 'week' ? 'bg-gold text-navy' : 'text-silver hover:text-white'
            )}
          >
            <CalendarDays className="h-3.5 w-3.5" />
            Week
          </button>
        </div>

        {view === 'week' && (
          <div className="inline-flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setWeekStart((w) => shiftWeek(w, -1))}
              aria-label="Previous week"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <button
              type="button"
              onClick={() => setWeekStart(startOfWeekMonday(new Date()))}
              className="px-3 py-1 text-xs uppercase tracking-wider text-silver hover:text-white border border-navy-secondary rounded-md"
            >
              Today
            </button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setWeekStart((w) => shiftWeek(w, 1))}
              aria-label="Next week"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            <span className="text-sm text-silver tabular-nums ml-2">
              {weekStart.toLocaleDateString([], { month: 'short', day: 'numeric' })}
              {' – '}
              {new Date(weekEnd.getTime() - 1).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}
            </span>
          </div>
        )}

        {view === 'list' && (
          <div className="flex flex-wrap gap-2">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                onClick={() => setFilter(f.value)}
                className={cn(
                  'px-3 py-1.5 rounded-md text-sm border transition-colors',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
                  filter === f.value
                    ? 'border-gold text-gold bg-gold/10'
                    : 'border-navy-secondary text-silver hover:text-white hover:border-silver/40'
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {!shifts && (
        <Card>
          <div className="p-2 space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-14" />
            ))}
          </div>
        </Card>
      )}

      {/* Week view */}
      {shifts && view === 'week' && (
        <WeekCalendarView
          shifts={shifts}
          weekStart={weekStart}
          canManage={canManage}
          onShiftClick={(s) => {
            // Card click → open the appropriate dialog. OPEN/DRAFT shifts
            // get the assign sheet (most useful action); ASSIGNED jumps
            // straight to the cancel/unassign affordances via the same
            // sheet that the list-view buttons trigger.
            if (s.status === 'OPEN' || s.status === 'DRAFT') {
              setAssignTarget(s);
            } else if (s.status === 'ASSIGNED') {
              setAssignTarget(s); // shows shift info; Assign Anyway re-routes
            } else {
              // COMPLETED / CANCELLED — read-only, no action.
            }
          }}
          onCellCreate={(dayStart) => {
            setCreateInitialDate(dayStart);
            setShowCreate(true);
          }}
        />
      )}

      {/* List view: empty state */}
      {shifts && view === 'list' && shifts.length === 0 && (
        <EmptyState
          icon={Calendar}
          title="No shifts match this filter"
          description={
            canManage
              ? 'Try a different filter, or create a new shift to start staffing.'
              : 'Try a different filter to see other shifts.'
          }
          action={
            canManage ? (
              <Button onClick={() => setShowCreate(true)}>
                <Plus className="h-4 w-4" />
                New shift
              </Button>
            ) : undefined
          }
        />
      )}

      {shifts && view === 'list' && shifts.length > 0 && (
        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Position</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Starts</TableHead>
                <TableHead>Ends</TableHead>
                <TableHead>Assigned</TableHead>
                <TableHead>Status</TableHead>
                {canManage && <TableHead className="text-right">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {shifts.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">{s.position}</TableCell>
                  <TableCell className="text-silver">{s.clientName ?? '—'}</TableCell>
                  <TableCell className="tabular-nums">{fmt(s.startsAt)}</TableCell>
                  <TableCell className="tabular-nums">{fmt(s.endsAt)}</TableCell>
                  <TableCell className="text-silver">
                    {s.assignedAssociateName ?? '—'}
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[s.status] ?? 'default'}>
                      {s.status}
                    </Badge>
                    {s.cancellationReason && (
                      <div className="text-alert text-[10px] mt-1">
                        {s.cancellationReason}
                      </div>
                    )}
                  </TableCell>
                  {canManage && (
                    <TableCell className="text-right whitespace-nowrap">
                      <div className="inline-flex gap-1.5">
                        {(s.status === 'OPEN' || s.status === 'DRAFT') && (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => onAutoFill(s.id)}
                              disabled={pendingId === s.id}
                            >
                              <Sparkles className="h-3.5 w-3.5" />
                              Auto-fill
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => setAssignTarget(s)}
                              disabled={pendingId === s.id}
                            >
                              <UserPlus className="h-3.5 w-3.5" />
                              Assign
                            </Button>
                          </>
                        )}
                        {s.status === 'ASSIGNED' && (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => onUnassign(s)}
                            disabled={pendingId === s.id}
                          >
                            Unassign
                          </Button>
                        )}
                        {s.status !== 'COMPLETED' && s.status !== 'CANCELLED' && (
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => setCancelTarget(s)}
                            disabled={pendingId === s.id}
                          >
                            <X className="h-3.5 w-3.5" />
                            Cancel
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {canManage && <AdminSwapsPanel />}

      {/* Assign-with-conflicts dialog */}
      <AssignDialog
        target={assignTarget}
        onClose={() => setAssignTarget(null)}
        onAssigned={() => {
          setAssignTarget(null);
          toast.success('Shift assigned.');
          refresh();
        }}
      />

      {/* Cancel-with-reason dialog */}
      <CancelDialog
        target={cancelTarget}
        onClose={() => setCancelTarget(null)}
        onCancelled={() => {
          setCancelTarget(null);
          toast.success('Shift cancelled.');
          refresh();
        }}
      />

      {/* Auto-fill candidates dialog */}
      <AutoFillDialog
        target={autoFillForShift}
        onClose={() => setAutoFillForShift(null)}
        onPick={onPickAutoFill}
        pending={pendingId !== null}
      />
    </div>
  );
}

/* ===== KPI strip ========================================================== */

function KpiStrip({ kpis }: { kpis: SchedulingKpis | null }) {
  if (!kpis) {
    return (
      <div className="mb-5">
        <Skeleton className="h-14" />
      </div>
    );
  }
  const hours = kpis.totalScheduledMinutes / 60;
  const fillTone =
    kpis.fillRatePercent >= 90
      ? 'text-success'
      : kpis.fillRatePercent >= 70
        ? 'text-warning'
        : 'text-alert';
  return (
    <div className="mb-5 flex flex-wrap gap-x-6 gap-y-2 px-4 py-3 rounded-md border border-navy-secondary bg-navy-secondary/30">
      <Kpi label="Open shifts" value={String(kpis.openShifts)} tone={kpis.openShifts > 0 ? 'text-warning' : 'text-silver'} />
      <Kpi label="Filled" value={String(kpis.assignedShifts + kpis.completedShifts)} />
      <Kpi label="Fill rate" value={`${kpis.fillRatePercent}%`} tone={fillTone} />
      <Kpi label="Hours scheduled" value={hours.toFixed(0)} />
      {kpis.draftShifts > 0 && (
        <Kpi label="Draft" value={String(kpis.draftShifts)} tone="text-silver" />
      )}
      <div className="text-[10px] uppercase tracking-wider text-silver/40 self-end ml-auto">
        this week
      </div>
    </div>
  );
}

function Kpi({ label, value, tone = 'text-white' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="min-w-[6rem]">
      <div className="text-[10px] uppercase tracking-wider text-silver">{label}</div>
      <div className={cn('text-xl font-semibold tabular-nums', tone)}>{value}</div>
    </div>
  );
}

/* ===== Assign dialog ====================================================== */

type ConflictRow = { position: string; client: string | null; startsAt: string };

function AssignDialog({
  target,
  onClose,
  onAssigned,
}: {
  target: Shift | null;
  onClose: () => void;
  onAssigned: () => void;
}) {
  const [associateId, setAssociateId] = useState('');
  const [conflicts, setConflicts] = useState<ConflictRow[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Reset on open.
  useEffect(() => {
    if (target) {
      setAssociateId('');
      setConflicts(null);
      setSubmitting(false);
      setChecking(false);
    }
  }, [target]);

  // Live conflict check — debounced. The /conflicts endpoint accepts any
  // string for associateId (returns 400 on a bad UUID) so we naively
  // hit it whenever the value looks plausible.
  useEffect(() => {
    if (!target) return;
    const id = associateId.trim();
    // UUID-ish gate so we don't hammer the API on every keystroke.
    if (id.length < 32) {
      setConflicts(null);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      setChecking(true);
      try {
        const c = await getShiftConflicts(target.id, id);
        if (cancelled) return;
        setConflicts(
          c.conflicts.map((cf) => ({
            position: cf.conflictingPosition,
            client: cf.conflictingClientName,
            startsAt: cf.conflictingStartsAt,
          }))
        );
      } catch {
        if (!cancelled) setConflicts(null);
      } finally {
        if (!cancelled) setChecking(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [associateId, target]);

  const submit = async () => {
    if (!target || !associateId.trim()) return;
    setSubmitting(true);
    try {
      await assignShift(target.id, { associateId });
      onAssigned();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Assign failed.');
      setSubmitting(false);
    }
  };

  const hasConflicts = !!(conflicts && conflicts.length > 0);

  return (
    <Dialog open={target !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign shift</DialogTitle>
          <DialogDescription>
            {target && (
              <>
                {target.position} at {target.clientName ?? '—'} ·{' '}
                {fmt(target.startsAt)}
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="space-y-3"
        >
          <div>
            <Label htmlFor="assign-id" required>
              Associate ID
            </Label>
            <Input
              id="assign-id"
              value={associateId}
              onChange={(e) => setAssociateId(e.target.value)}
              placeholder="UUID"
              autoFocus
              required
            />
            {checking && (
              <div className="text-[11px] text-silver/60 mt-1">Checking conflicts…</div>
            )}
            {!checking && conflicts && conflicts.length === 0 && (
              <div className="text-[11px] text-success mt-1 inline-flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3" />
                No conflicts
              </div>
            )}
          </div>

          {hasConflicts && (
            <div className="flex items-start gap-2 p-3 rounded-md border border-warning/40 bg-warning/10 text-sm">
              <AlertTriangle className="h-4 w-4 text-warning mt-0.5 shrink-0" />
              <div>
                <div className="font-medium text-white">
                  Overlaps {conflicts!.length} existing shift
                  {conflicts!.length === 1 ? '' : 's'}:
                </div>
                <ul className="mt-2 space-y-1 text-silver">
                  {conflicts!.map((c, i) => (
                    <li key={i} className="text-xs">
                      • {c.position} @ {c.client ?? '—'} ·{' '}
                      <span className="tabular-nums">{fmt(c.startsAt)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant={hasConflicts ? 'destructive' : 'primary'}
              loading={submitting}
              disabled={!associateId.trim()}
            >
              {hasConflicts ? 'Assign anyway' : 'Assign'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ===== Cancel dialog ====================================================== */

function CancelDialog({
  target,
  onClose,
  onCancelled,
}: {
  target: Shift | null;
  onClose: () => void;
  onCancelled: () => void;
}) {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (target) {
      setReason('');
      setSubmitting(false);
    }
  }, [target]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!target || !reason.trim()) return;
    setSubmitting(true);
    try {
      await cancelShift(target.id, { reason: reason.trim() });
      onCancelled();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Cancel failed.');
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={target !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancel shift</DialogTitle>
          <DialogDescription>
            {target && (
              <>
                {target.position} at {target.clientName ?? '—'} ·{' '}
                {fmt(target.startsAt)}
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div>
            <Label htmlFor="cancel-reason" required>
              Cancellation reason
            </Label>
            <Textarea
              id="cancel-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Required for the audit trail."
              autoFocus
              rows={3}
              required
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>
              Keep shift
            </Button>
            <Button
              type="submit"
              variant="destructive"
              loading={submitting}
              disabled={!reason.trim()}
            >
              Cancel shift
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ===== Auto-fill dialog =================================================== */

function AutoFillDialog({
  target,
  onClose,
  onPick,
  pending,
}: {
  target: { shiftId: string; candidates: AutoFillCandidate[] } | null;
  onClose: () => void;
  onPick: (associateId: string) => void;
  pending: boolean;
}) {
  return (
    <Dialog open={target !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Suggested associates</DialogTitle>
          <DialogDescription>
            Ranked by availability, conflict-free, and weekly hours headroom.
          </DialogDescription>
        </DialogHeader>
        {target?.candidates.length === 0 && (
          <p className="text-silver text-sm">
            No candidates returned. Check that associates have set availability.
          </p>
        )}
        {target && target.candidates.length > 0 && (
          <ul className="space-y-2 max-h-[60vh] overflow-y-auto">
            {target.candidates.slice(0, 15).map((c) => (
              <li
                key={c.associateId}
                className="flex items-center justify-between gap-3 p-3 bg-navy-secondary/30 border border-navy-secondary rounded-md"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-white text-sm font-medium">{c.associateName}</div>
                  <div className="text-xs text-silver flex flex-wrap gap-x-3 gap-y-0.5 mt-0.5">
                    <span
                      className={cn(
                        'inline-flex items-center gap-1',
                        c.matchesAvailability ? 'text-success' : 'text-silver/60'
                      )}
                    >
                      {c.matchesAvailability ? (
                        <CheckCircle2 className="h-3 w-3" />
                      ) : null}
                      {c.matchesAvailability ? 'Available' : 'No availability'}
                    </span>
                    <span
                      className={cn(
                        'inline-flex items-center gap-1',
                        c.noConflict ? 'text-success' : 'text-alert'
                      )}
                    >
                      {c.noConflict ? (
                        <CheckCircle2 className="h-3 w-3" />
                      ) : (
                        <AlertTriangle className="h-3 w-3" />
                      )}
                      {c.noConflict ? 'No conflict' : 'Conflict'}
                    </span>
                    <span className="tabular-nums">
                      {Math.round(c.weeklyMinutesActual / 60)}h worked this week
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <Badge variant="accent">{(c.score * 100).toFixed(0)}%</Badge>
                  <Button
                    size="sm"
                    onClick={() => onPick(c.associateId)}
                    disabled={pending}
                  >
                    Assign
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

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

function AdminSwapsPanel() {
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
                      {new Date(s.shiftStartsAt).toLocaleString()}
                    </span>
                  </div>
                  {s.note && (
                    <div className="text-xs text-silver/70 italic mt-1">"{s.note}"</div>
                  )}
                </div>
                <div className="flex items-center gap-2">
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

/* ===== Create-shift dialog ================================================ */

function CreateShiftDialog({
  open,
  clients,
  initialDate,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  clients: ClientSummary[];
  initialDate?: Date | null;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [clientId, setClientId] = useState(clients[0]?.id ?? '');
  const [position, setPosition] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [location, setLocation] = useState('');
  const [hourlyRate, setHourlyRate] = useState('');
  const [notes, setNotes] = useState('');
  const [lateNoticeReason, setLateNoticeReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setClientId(clients[0]?.id ?? '');
      setPosition('');
      // When opened from a calendar cell, pre-fill 9am–5pm on that day —
      // the most common shift shape for hourly workforce, easy to edit.
      if (initialDate) {
        const start = new Date(initialDate);
        start.setHours(9, 0, 0, 0);
        const end = new Date(initialDate);
        end.setHours(17, 0, 0, 0);
        setStartsAt(toLocalDatetimeInput(start));
        setEndsAt(toLocalDatetimeInput(end));
      } else {
        setStartsAt('');
        setEndsAt('');
      }
      setLocation('');
      setHourlyRate('');
      setNotes('');
      setLateNoticeReason('');
      setSubmitting(false);
    }
  }, [open, clients, initialDate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      await createShift({
        clientId,
        position,
        startsAt: new Date(startsAt).toISOString(),
        endsAt: new Date(endsAt).toISOString(),
        location: location || undefined,
        hourlyRate: hourlyRate ? Number(hourlyRate) : undefined,
        notes: notes || undefined,
        status: 'OPEN',
        lateNoticeReason: lateNoticeReason.trim() || undefined,
      });
      onCreated();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Create failed.');
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New shift</DialogTitle>
          <DialogDescription>
            Open shifts publish immediately. Drafts stay private until you publish them.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <Label htmlFor="cs-client" required>
                Client
              </Label>
              {clients.length > 0 ? (
                <select
                  id="cs-client"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  required
                  className="flex h-10 w-full rounded-md border border-navy-secondary bg-navy-secondary/40 px-3 py-2 text-sm text-white focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
                >
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              ) : (
                <Input
                  id="cs-client"
                  required
                  placeholder="Client UUID"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                />
              )}
            </div>
            <div>
              <Label htmlFor="cs-position" required>
                Position
              </Label>
              <Input
                id="cs-position"
                required
                value={position}
                onChange={(e) => setPosition(e.target.value)}
                placeholder="e.g. Server"
              />
            </div>
            <div>
              <Label htmlFor="cs-starts" required>
                Starts at
              </Label>
              <Input
                id="cs-starts"
                type="datetime-local"
                required
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="cs-ends" required>
                Ends at
              </Label>
              <Input
                id="cs-ends"
                type="datetime-local"
                required
                value={endsAt}
                onChange={(e) => setEndsAt(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="cs-location">Location</Label>
              <Input
                id="cs-location"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="cs-rate">Hourly rate ($)</Label>
              <Input
                id="cs-rate"
                type="number"
                min={0}
                step="0.01"
                value={hourlyRate}
                onChange={(e) => setHourlyRate(e.target.value)}
              />
            </div>
          </div>
          <div>
            <Label htmlFor="cs-notes">Notes</Label>
            <Textarea
              id="cs-notes"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="cs-late">
              Late-notice reason (only required for fair-workweek states inside the 14-day window)
            </Label>
            <Textarea
              id="cs-late"
              rows={2}
              value={lateNoticeReason}
              onChange={(e) => setLateNoticeReason(e.target.value)}
              placeholder="e.g. Mutual agreement — associate volunteered to cover a sick call-out"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={submitting}>
              Create shift
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
