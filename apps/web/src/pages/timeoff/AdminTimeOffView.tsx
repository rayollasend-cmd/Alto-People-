import { useCallback, useEffect, useState } from 'react';
import { CalendarCheck, Check, X } from 'lucide-react';
import { toast } from 'sonner';
import type {
  TimeOffRequest,
  TimeOffRequestStatus,
} from '@alto-people/shared';
import {
  approveAdminRequest,
  denyAdminRequest,
  listAdminRequests,
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
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { Badge } from '@/components/ui/Badge';
import { Avatar } from '@/components/ui/Avatar';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';

const TABS: { key: TimeOffRequestStatus | 'ALL'; label: string }[] = [
  { key: 'PENDING', label: 'Pending' },
  { key: 'APPROVED', label: 'Approved' },
  { key: 'DENIED', label: 'Denied' },
  { key: 'CANCELLED', label: 'Withdrawn' },
  { key: 'ALL', label: 'All' },
];

function fmtHours(minutes: number): string {
  const h = minutes / 60;
  return `${h.toFixed(h % 1 === 0 ? 0 : 1)}h`;
}

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y.slice(2)}`;
}

export function AdminTimeOffView({ canManage }: { canManage: boolean }) {
  const [tab, setTab] = useState<TimeOffRequestStatus | 'ALL'>('PENDING');
  const [items, setItems] = useState<TimeOffRequest[] | null>(null);
  const [denyTarget, setDenyTarget] = useState<TimeOffRequest | null>(null);

  const refresh = useCallback(async () => {
    setItems(null);
    try {
      const res = await listAdminRequests(tab === 'ALL' ? undefined : tab);
      setItems(res.requests);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setItems([]);
        return;
      }
      toast.error('Could not load requests', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }, [tab]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const onApprove = async (r: TimeOffRequest) => {
    try {
      await approveAdminRequest(r.id);
      toast.success(`Approved ${r.associateName ?? 'request'}`);
      refresh();
    } catch (err) {
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
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl text-white">Time-off requests</h1>
        <p className="text-sm text-silver mt-1">
          Approve or deny associate requests. Approving debits their balance.
        </p>
      </div>

      <div className="flex flex-wrap gap-1 border-b border-navy-secondary">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`px-3 py-2 text-sm border-b-2 -mb-px transition-colors ${
              tab === t.key
                ? 'border-gold text-gold'
                : 'border-transparent text-silver hover:text-white'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Queue</CardTitle>
          <CardDescription>
            {tab === 'PENDING' ? 'Awaiting decision' : `${tab.toLowerCase()} requests`}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {!items && (
            <div className="p-4 space-y-2">
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
            </div>
          )}
          {items && items.length === 0 && (
            <div className="p-6">
              <EmptyState
                icon={CalendarCheck}
                title="Nothing in this queue"
                description={tab === 'PENDING' ? 'You\'re all caught up.' : 'No requests with this status.'}
              />
            </div>
          )}
          {items && items.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Associate</TableHead>
                  <TableHead className="hidden md:table-cell">Category</TableHead>
                  <TableHead>Dates</TableHead>
                  <TableHead className="text-right hidden sm:table-cell">Hours</TableHead>
                  <TableHead className="hidden lg:table-cell">Reason</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((r) => (
                  <TableRow key={r.id} className="group">
                    <TableCell className="text-white">
                      <div className="flex items-center gap-2.5">
                        <Avatar name={r.associateName ?? '—'} size="sm" />
                        <div className="min-w-0">
                          <div className="truncate">{r.associateName ?? '—'}</div>
                          {/* Phone-only inline category + hours since their
                              dedicated columns are hidden. */}
                          <div className="md:hidden text-[11px] text-silver/70 truncate">
                            {r.category}
                            <span className="sm:hidden tabular-nums">
                              {' · '}
                              {fmtHours(r.requestedMinutes)}
                            </span>
                          </div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">{r.category}</TableCell>
                    <TableCell className="tabular-nums">
                      {fmtDate(r.startDate)}
                      {r.startDate !== r.endDate && ` – ${fmtDate(r.endDate)}`}
                    </TableCell>
                    <TableCell className="text-right tabular-nums hidden sm:table-cell">
                      {fmtHours(r.requestedMinutes)}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell text-xs text-silver max-w-[18ch] truncate">
                      {r.reason || '—'}
                    </TableCell>
                    <TableCell>
                      <RowStatus status={r.status} />
                    </TableCell>
                    <TableCell className="text-right">
                      {r.status === 'PENDING' && canManage ? (
                        <div className="inline-flex gap-1 opacity-60 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => onApprove(r)}
                            aria-label="Approve"
                          >
                            <Check className="h-4 w-4 text-success" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setDenyTarget(r)}
                            aria-label="Deny"
                          >
                            <X className="h-4 w-4 text-alert" />
                          </Button>
                        </div>
                      ) : (
                        <span className="text-silver/80 text-xs">
                          {r.reviewerEmail ?? '—'}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <DenyDialog
        target={denyTarget}
        onClose={(refreshed) => {
          setDenyTarget(null);
          if (refreshed) refresh();
        }}
      />
    </div>
  );
}

function RowStatus({ status }: { status: TimeOffRequestStatus }) {
  if (status === 'APPROVED') return <Badge variant="success">Approved</Badge>;
  if (status === 'DENIED') return <Badge variant="destructive">Denied</Badge>;
  if (status === 'CANCELLED') return <Badge variant="outline">Withdrawn</Badge>;
  return <Badge variant="pending">Pending</Badge>;
}

interface DenyProps {
  target: TimeOffRequest | null;
  onClose: (refreshed: boolean) => void;
}

function DenyDialog({ target, onClose }: DenyProps) {
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const open = target !== null;

  useEffect(() => {
    if (open) setNote('');
  }, [open]);

  const submit = async () => {
    if (!target) return;
    if (note.trim().length === 0) {
      toast.error('A note is required when denying');
      return;
    }
    setSubmitting(true);
    try {
      await denyAdminRequest(target.id, { note: note.trim() });
      toast.success('Denied');
      onClose(true);
    } catch (err) {
      toast.error('Could not deny', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose(false)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Deny request</DialogTitle>
          <DialogDescription>
            The associate will see your note in their request history.
          </DialogDescription>
        </DialogHeader>
        <div>
          <Label htmlFor="deny-note" required>
            Note
          </Label>
          <Input
            id="deny-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Coverage gap that week, etc."
            maxLength={500}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onClose(false)}>
            Cancel
          </Button>
          <Button onClick={submit} loading={submitting} variant="destructive">
            Deny
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
