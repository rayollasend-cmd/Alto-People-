import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarCheck, Check, X } from 'lucide-react';
import { toast } from 'sonner';
import type { TimeOffRequest } from '@alto-people/shared';
import {
  approveAdminRequest,
  denyAdminRequest,
  listAdminRequests,
} from '@/lib/timeOffApi';
import { countAdminTimeEntries } from '@/lib/timeApi';
import { ApiError } from '@/lib/api';
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
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import { Badge } from '@/components/ui/Badge';
import {
  AdminPickupPanel,
  AdminSwapsPanel,
  AdminUnconfirmedPanel,
} from '@/pages/scheduling/AdminApprovalPanels';

/**
 * One inbox for everything waiting on a manager's decision. Before this
 * page, the queues were scattered: swaps + pickups + unconfirmed shifts
 * at the bottom of /scheduling, time off in its own tab, timesheets on
 * /time-attendance — a manager had to remember to visit each one. Here
 * they all stack on a single URL that can be checked (or deep-linked)
 * in one pass.
 */
const TIME_OFF_KEY = ['approvals', 'timeOff'] as const;

export function ApprovalsHome() {
  // KPI is best-effort — the panels below are the real content. A failure
  // just leaves the tile at "—" (data stays undefined).
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

  const timeOffError = timeOffQuery.error;
  useEffect(() => {
    if (timeOffError) {
      toast.error('Could not load time-off requests', {
        description:
          timeOffError instanceof Error
            ? timeOffError.message
            : String(timeOffError),
      });
    }
  }, [timeOffError]);

  const timesheetCount = timesheetQuery.data?.count ?? null;
  const timeOff = timeOffQuery.data ?? null;

  return (
    <div>
      <PageHeader
        title="Approvals"
        subtitle="Everything waiting on your decision — swaps, pickups, time off, and timesheets."
      />

      <div className="grid grid-cols-2 gap-3 sm:max-w-md">
        <MetricCard
          label="Time off pending"
          value={timeOff === null ? '…' : timeOff.length}
          accent={(timeOff?.length ?? 0) > 0}
        />
        <MetricCard
          label="Timesheets to review"
          value={timesheetCount === null ? '—' : timesheetCount}
          accent={(timesheetCount ?? 0) > 0}
          hint="Review on Time & Attendance"
          wrap={(children) => <Link to="/time-attendance">{children}</Link>}
        />
      </div>

      <PendingTimeOffPanel items={timeOff} />
      <AdminSwapsPanel />
      <AdminPickupPanel />
      <AdminUnconfirmedPanel />
    </div>
  );
}

function fmtHours(minutes: number): string {
  const h = minutes / 60;
  return `${h.toFixed(h % 1 === 0 ? 0 : 1)}h`;
}

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y.slice(2)}`;
}

function PendingTimeOffPanel({ items }: { items: TimeOffRequest[] | null }) {
  const queryClient = useQueryClient();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [denyTarget, setDenyTarget] = useState<TimeOffRequest | null>(null);

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
        toast.error('Insufficient balance', {
          description: `Available ${fmtHours(d.currentMinutes)}, requested ${fmtHours(d.requestedMinutes)}`,
        });
        return;
      }
      toast.error('Could not approve', {
        description: err instanceof Error ? err.message : String(err),
      });
    },
    onSuccess: (_res, r) => {
      toast.success(`Approved ${r.associateName ?? 'request'}`);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: TIME_OFF_KEY }),
  });

  const denyMutation = useMutation({
    mutationFn: ({ target, note }: { target: TimeOffRequest; note: string }) =>
      denyAdminRequest(target.id, { note }),
    onMutate: ({ target }) => removeOptimistically(target.id),
    onError: (err, _vars, ctx) => {
      rollback(ctx);
      toast.error('Could not deny', {
        description: err instanceof Error ? err.message : String(err),
      });
    },
    onSuccess: () => {
      toast.success('Denied');
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: TIME_OFF_KEY }),
  });

  const onApprove = (r: TimeOffRequest) => {
    setPendingId(r.id);
    approveMutation.mutate(r, { onSettled: () => setPendingId(null) });
  };

  return (
    <Card className="mt-8">
      <CardHeader>
        <CardTitle>Time-off requests awaiting your decision</CardTitle>
      </CardHeader>
      <CardContent>
        {!items && <Skeleton className="h-16" />}
        {items && items.length === 0 && (
          <p className="text-silver text-sm flex items-center gap-2">
            <CalendarCheck className="h-4 w-4" aria-hidden="true" />
            No time-off requests waiting.
          </p>
        )}
        {items && items.length > 0 && (
          <ul className="space-y-2">
            {items.map((r) => (
              <li
                key={r.id}
                className="p-3 bg-navy-secondary/30 border border-navy-secondary rounded-md flex items-start justify-between gap-3 flex-wrap"
              >
                <div>
                  <div className="text-white text-sm font-medium">
                    {r.associateName ?? '—'}
                  </div>
                  <div className="text-xs text-silver mt-0.5 tabular-nums">
                    {r.category} · {fmtDate(r.startDate)}
                    {r.startDate !== r.endDate && ` – ${fmtDate(r.endDate)}`} ·{' '}
                    {fmtHours(r.requestedMinutes)}
                  </div>
                  {r.reason && (
                    <div className="text-xs text-silver/70 italic mt-1">
                      "{r.reason}"
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="pending">Pending</Badge>
                  <Button
                    size="sm"
                    onClick={() => onApprove(r)}
                    disabled={pendingId === r.id}
                  >
                    <Check className="h-4 w-4" />
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => setDenyTarget(r)}
                    disabled={pendingId === r.id}
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
      toast.error('A note is required when denying');
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
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Coverage gap that week, etc."
              maxLength={500}
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
