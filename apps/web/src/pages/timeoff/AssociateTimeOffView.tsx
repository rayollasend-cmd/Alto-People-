import { useCallback, useEffect, useState } from 'react';
import { CalendarOff, Plus, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import type {
  TimeOffBalance,
  TimeOffCategory,
  TimeOffRequest,
} from '@alto-people/shared';
import {
  cancelMyRequest,
  createMyRequest,
  getMyBalance,
  listMyRequests,
} from '@/lib/timeOffApi';
import { ApiError } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import {
  Card,
  CardContent,
  CardDescription,
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
import { Select } from '@/components/ui/Select';
import { Skeleton, SkeletonRows } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { Badge } from '@/components/ui/Badge';

type Category = TimeOffCategory;

const CATEGORY_LABELS: Record<Category, string> = {
  SICK: 'Sick',
  VACATION: 'Vacation',
  PTO: 'PTO',
  BEREAVEMENT: 'Bereavement',
  JURY_DUTY: 'Jury duty',
  OTHER: 'Other',
};

function fmtHours(minutes: number): string {
  const h = minutes / 60;
  return `${h.toFixed(h % 1 === 0 ? 0 : 1)}h`;
}

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y.slice(2)}`;
}

export function AssociateTimeOffView() {
  const [balances, setBalances] = useState<TimeOffBalance[] | null>(null);
  const [requests, setRequests] = useState<TimeOffRequest[] | null>(null);
  const [openCreate, setOpenCreate] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [bal, reqs] = await Promise.all([getMyBalance(), listMyRequests()]);
      setBalances(bal.balances);
      setRequests(reqs.requests);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        // Caller isn't an associate — render empty state instead of an error.
        setBalances([]);
        setRequests([]);
        return;
      }
      toast.error('Could not load time-off data', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const onCancel = async (id: string) => {
    try {
      await cancelMyRequest(id);
      toast.success('Request withdrawn');
      refresh();
    } catch (err) {
      toast.error('Could not cancel', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl text-white">Time off</h1>
          <p className="text-sm text-silver mt-1">
            Submit a request, see your balance, track approvals.
          </p>
        </div>
        <Button onClick={() => setOpenCreate(true)}>
          <Plus className="h-4 w-4" />
          Request time off
        </Button>
      </div>

      <BalanceGrid balances={balances} />

      <Card>
        <CardHeader>
          <CardTitle>My requests</CardTitle>
          <CardDescription>Most recent first</CardDescription>
        </CardHeader>
        <CardContent>
          {!requests && <SkeletonRows count={3} />}
          {requests && requests.length === 0 && (
            <EmptyState
              icon={CalendarOff}
              title="No requests yet"
              description="Submit one with the button above. HR will be notified."
            />
          )}
          {requests && requests.length > 0 && (
            <ul className="divide-y divide-navy-secondary/60">
              {requests.map((r) => (
                <li
                  key={r.id}
                  className="py-3 flex items-start gap-4"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-white font-medium">
                        {CATEGORY_LABELS[r.category]} · {fmtHours(r.requestedMinutes)}
                      </span>
                      <StatusBadge status={r.status} />
                    </div>
                    <div className="text-xs text-silver mt-0.5">
                      {fmtDate(r.startDate)}
                      {r.startDate !== r.endDate && ` – ${fmtDate(r.endDate)}`}
                    </div>
                    {r.reason && (
                      <div className="text-xs text-silver/80 mt-1 italic">
                        “{r.reason}”
                      </div>
                    )}
                    {r.reviewerNote && (
                      <div className="text-xs text-silver mt-1">
                        <span className="text-silver/60">Note from {r.reviewerEmail ?? 'HR'}:</span>{' '}
                        {r.reviewerNote}
                      </div>
                    )}
                  </div>
                  {r.status === 'PENDING' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onCancel(r.id)}
                    >
                      Withdraw
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <CreateRequestDialog
        open={openCreate}
        onOpenChange={setOpenCreate}
        onCreated={() => {
          setOpenCreate(false);
          refresh();
        }}
      />
    </div>
  );
}

function BalanceGrid({ balances }: { balances: TimeOffBalance[] | null }) {
  if (!balances) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
    );
  }
  if (balances.length === 0) {
    return (
      <Card>
        <CardContent className="py-6">
          <EmptyState
            icon={Wallet}
            title="No accrued balance yet"
            description="Sick-leave hours accrue automatically as you work. Other categories start at 0 and are added by HR."
          />
        </CardContent>
      </Card>
    );
  }
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {balances.map((b) => (
        <Card key={b.category}>
          <CardContent className="py-4">
            <div className="text-[10px] uppercase tracking-widest text-silver">
              {CATEGORY_LABELS[b.category]}
            </div>
            <div className="text-2xl text-white font-display mt-1 tabular-nums">
              {fmtHours(b.balanceMinutes)}
            </div>
            <div className="text-xs text-silver/70 mt-0.5">available</div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function StatusBadge({ status }: { status: TimeOffRequest['status'] }) {
  if (status === 'APPROVED') return <Badge variant="success">Approved</Badge>;
  if (status === 'DENIED') return <Badge variant="destructive">Denied</Badge>;
  if (status === 'CANCELLED') return <Badge variant="outline">Withdrawn</Badge>;
  return <Badge variant="pending">Pending</Badge>;
}

interface CreateProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: () => void;
}

function CreateRequestDialog({ open, onOpenChange, onCreated }: CreateProps) {
  const [category, setCategory] = useState<Category>('VACATION');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [hours, setHours] = useState('8');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setCategory('VACATION');
    setStartDate('');
    setEndDate('');
    setHours('8');
    setReason('');
  };

  const submit = async () => {
    if (!startDate || !endDate) {
      toast.error('Pick a start and end date');
      return;
    }
    const h = Number(hours);
    if (!Number.isFinite(h) || h <= 0) {
      toast.error('Hours must be greater than 0');
      return;
    }
    setSubmitting(true);
    try {
      await createMyRequest({
        category,
        startDate,
        endDate,
        hours: h,
        reason: reason.trim() || undefined,
      });
      toast.success('Request submitted');
      reset();
      onCreated();
    } catch (err) {
      toast.error('Could not submit', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Request time off</DialogTitle>
          <DialogDescription>
            HR will see your request immediately. You'll be notified when it's reviewed.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Field label="Category">
            {(p) => (
              <Select
                value={category}
                onChange={(e) => setCategory(e.target.value as Category)}
                {...p}
              >
                {(Object.keys(CATEGORY_LABELS) as Category[]).map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABELS[c]}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Start date" required>
              {(p) => (
                <Input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  {...p}
                />
              )}
            </Field>
            <Field label="End date" required>
              {(p) => (
                <Input
                  type="date"
                  value={endDate}
                  min={startDate || undefined}
                  onChange={(e) => setEndDate(e.target.value)}
                  {...p}
                />
              )}
            </Field>
          </div>

          <Field
            label="Total hours"
            required
            hint="Half-hour granularity. 8 = a full work day."
          >
            {(p) => (
              <Input
                type="number"
                step="0.5"
                min="0.5"
                value={hours}
                onChange={(e) => setHours(e.target.value)}
                {...p}
              />
            )}
          </Field>

          <Field label="Reason (optional)">
            {(p) => (
              <Input
                type="text"
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Family event, doctor visit, etc."
                {...p}
              />
            )}
          </Field>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} loading={submitting}>
            Submit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
