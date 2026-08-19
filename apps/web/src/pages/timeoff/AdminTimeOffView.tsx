import { useCallback, useEffect, useMemo, useState } from 'react';
import { AssociateLink } from '@/components/ui/AssociateLink';
import { CalendarCheck, Check, X } from 'lucide-react';
import { toast } from 'sonner';
import type {
  TimeOffRequest,
  TimeOffRequestStatus,
} from '@alto-people/shared';
import {
  approveAdminRequest,
  bulkDecideRequests,
  denyAdminRequest,
  listAdminRequests,
  type BulkDecideResponse,
} from '@/lib/timeOffApi';
import { ApiError } from '@/lib/api';
import { fmtDate, fmtDateTime, parseYmd } from '@/lib/format';
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
import {
  Drawer,
  DrawerBody,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/Drawer';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { SearchInput } from '@/components/ui/FilterBar';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/Tabs';
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

// Human-readable labels — raw enum values never reach the user's eyes.
const CATEGORY_LABELS: Record<TimeOffRequest['category'], string> = {
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

/** Dates arrive as date-only "YYYY-MM-DD" — parse at local midnight so
 *  they never render a day early west of UTC. */
const fmtYmd = (s: string) => fmtDate(parseYmd(s));

/** Approving would over-draw the associate's balance. */
const isInsufficient = (r: TimeOffRequest) =>
  r.balanceMinutes !== null &&
  r.balanceMinutes !== undefined &&
  r.balanceMinutes < r.requestedMinutes;

export function AdminTimeOffView({ canManage }: { canManage: boolean }) {
  const [tab, setTab] = useState<TimeOffRequestStatus | 'ALL'>('PENDING');
  const [items, setItems] = useState<TimeOffRequest[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [approveTarget, setApproveTarget] = useState<TimeOffRequest | null>(null);
  const [denyTarget, setDenyTarget] = useState<TimeOffRequest | null>(null);
  const [bulkDenyOpen, setBulkDenyOpen] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [detail, setDetail] = useState<TimeOffRequest | null>(null);

  const refresh = useCallback(async () => {
    setItems(null);
    setTotal(null);
    setError(null);
    setSelected(new Set<string>());
    try {
      const res = await listAdminRequests(tab === 'ALL' ? undefined : tab);
      setItems(res.requests);
      setTotal(res.total ?? null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setError("You don't have permission to view the time-off queue.");
        return;
      }
      setError(
        err instanceof Error ? err.message : 'Could not load requests.',
      );
    }
  }, [tab]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const visible = useMemo(() => {
    if (!items) return null;
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((r) =>
      (r.associateName ?? '').toLowerCase().includes(q),
    );
  }, [items, search]);

  const pendingVisible = useMemo(
    () => (visible ?? []).filter((r) => r.status === 'PENDING'),
    [visible],
  );
  const allPendingSelected =
    pendingVisible.length > 0 && pendingVisible.every((r) => selected.has(r.id));

  const toggleRow = (id: string) => {
    setSelected((prev) => {
      const next = new Set<string>(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllPending = () => {
    setSelected(
      allPendingSelected
        ? new Set<string>()
        : new Set<string>(pendingVisible.map((r) => r.id)),
    );
  };

  const reportBulk = (res: BulkDecideResponse, verb: string) => {
    if (res.decided > 0) {
      toast.success(
        `${verb} ${res.decided} request${res.decided === 1 ? '' : 's'}.`,
      );
    }
    if (res.failed.length > 0) {
      toast.error(
        `${res.failed.length} request${res.failed.length === 1 ? '' : 's'} failed.`,
        { description: res.failed[0]?.error },
      );
    }
  };

  const bulkApprove = async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBulkBusy(true);
    try {
      const res = await bulkDecideRequests({ ids, decision: 'APPROVE' });
      reportBulk(res, 'Approved');
      refresh();
    } catch (err) {
      toast.error('Could not approve the selected requests.', {
        description: err instanceof Error ? err.message : 'Something went wrong.',
      });
    } finally {
      setBulkBusy(false);
    }
  };

  const bulkDeny = async (note: string) => {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBulkBusy(true);
    try {
      const res = await bulkDecideRequests({ ids, decision: 'DENY', note });
      reportBulk(res, 'Denied');
      setBulkDenyOpen(false);
      refresh();
    } catch (err) {
      toast.error('Could not deny the selected requests.', {
        description: err instanceof Error ? err.message : 'Something went wrong.',
      });
    } finally {
      setBulkBusy(false);
    }
  };

  const singleApprove = async (note: string) => {
    if (!approveTarget) return;
    setDeciding(true);
    try {
      await approveAdminRequest(approveTarget.id, note.trim() || undefined);
      toast.success(`Approved ${approveTarget.associateName ?? 'request'}.`);
      setApproveTarget(null);
      refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'insufficient_balance') {
        const d = err.details as { currentMinutes: number; requestedMinutes: number };
        toast.error('Insufficient balance.', {
          description: `Available ${fmtHours(d.currentMinutes)}, requested ${fmtHours(d.requestedMinutes)}`,
        });
        return;
      }
      toast.error('Could not approve.', {
        description: err instanceof Error ? err.message : 'Something went wrong.',
      });
    } finally {
      setDeciding(false);
    }
  };

  const singleDeny = async (note: string) => {
    if (!denyTarget) return;
    setDeciding(true);
    try {
      await denyAdminRequest(denyTarget.id, { note: note.trim() });
      toast.success('Denied.');
      setDenyTarget(null);
      refresh();
    } catch (err) {
      toast.error('Could not deny.', {
        description: err instanceof Error ? err.message : 'Something went wrong.',
      });
    } finally {
      setDeciding(false);
    }
  };

  return (
    <div className="space-y-6">
      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as TimeOffRequestStatus | 'ALL')}
      >
        <TabsList>
          {TABS.map((t) => (
            <TabsTrigger key={t.key} value={t.key}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>Queue</CardTitle>
              <CardDescription>
                {tab === 'PENDING'
                  ? 'Awaiting decision'
                  : `${(TABS.find((t) => t.key === tab)?.label ?? tab).toLowerCase()} requests`}
              </CardDescription>
            </div>
            <SearchInput
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search associate…"
              aria-label="Search by associate name"
              wrapperClassName="w-full sm:w-56"
            />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {error && (
            <div className="p-6">
              <ErrorBanner
                action={
                  <Button size="sm" variant="secondary" onClick={refresh}>
                    Retry
                  </Button>
                }
              >
                {error}
              </ErrorBanner>
            </div>
          )}
          {!error && !visible && (
            <div className="p-4 space-y-2">
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
            </div>
          )}
          {!error && visible && visible.length === 0 && (
            <div className="p-6">
              <EmptyState
                icon={CalendarCheck}
                title={search.trim() ? 'No matches' : 'Nothing in this queue'}
                description={
                  search.trim()
                    ? 'No requests match that associate name.'
                    : tab === 'PENDING'
                      ? 'You\'re all caught up.'
                      : 'No requests with this status.'
                }
              />
            </div>
          )}
          {!error && visible && visible.length > 0 && (
            <>
              {canManage && selected.size > 0 && (
                <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-navy-secondary bg-navy-secondary/30">
                  <span className="text-xs text-silver">
                    {selected.size} selected
                  </span>
                  <Button size="sm" onClick={bulkApprove} loading={bulkBusy}>
                    Approve selected ({selected.size})
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => setBulkDenyOpen(true)}
                    disabled={bulkBusy}
                  >
                    Deny selected ({selected.size})
                  </Button>
                </div>
              )}
              <Table>
                <TableHeader>
                  <TableRow>
                    {canManage && (
                      <TableHead className="w-8">
                        <input
                          type="checkbox"
                          aria-label="Select all pending requests"
                          checked={allPendingSelected}
                          disabled={pendingVisible.length === 0}
                          onChange={toggleAllPending}
                        />
                      </TableHead>
                    )}
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
                  {visible.map((r) => {
                    const insufficient = isInsufficient(r);
                    return (
                      <TableRow
                        key={r.id}
                        className="group cursor-pointer"
                        onClick={() => setDetail(r)}
                      >
                        {canManage && (
                          <TableCell
                            className="w-8"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {r.status === 'PENDING' && (
                              <input
                                type="checkbox"
                                aria-label={`Select request from ${r.associateName ?? 'associate'}`}
                                checked={selected.has(r.id)}
                                onChange={() => toggleRow(r.id)}
                              />
                            )}
                          </TableCell>
                        )}
                        <TableCell className="text-white">
                          <div className="flex items-center gap-2.5">
                            <Avatar name={r.associateName ?? '—'} size="sm" />
                            <div className="min-w-0">
                              <div className="truncate">
                                <AssociateLink associateId={r.associateId}>
                                  {r.associateName ?? '—'}
                                </AssociateLink>
                              </div>
                              {/* Phone-only inline category + hours since their
                                  dedicated columns are hidden. */}
                              <div className="md:hidden text-xs2 text-silver/70 truncate">
                                {CATEGORY_LABELS[r.category] ?? r.category}
                                <span className="sm:hidden tabular-nums">
                                  {' · '}
                                  {fmtHours(r.requestedMinutes)}
                                </span>
                              </div>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          {CATEGORY_LABELS[r.category] ?? r.category}
                        </TableCell>
                        <TableCell className="tabular-nums">
                          {fmtYmd(r.startDate)}
                          {r.startDate !== r.endDate && ` – ${fmtYmd(r.endDate)}`}
                        </TableCell>
                        <TableCell
                          className={`text-right tabular-nums hidden sm:table-cell ${
                            insufficient ? 'text-alert' : ''
                          }`}
                        >
                          {fmtHours(r.requestedMinutes)} requested
                          {r.balanceMinutes !== null &&
                            r.balanceMinutes !== undefined &&
                            ` · ${fmtHours(r.balanceMinutes)} available`}
                        </TableCell>
                        <TableCell className="hidden lg:table-cell text-xs text-silver max-w-[18ch] truncate">
                          {r.reason || '—'}
                        </TableCell>
                        <TableCell>
                          <RowStatus status={r.status} />
                        </TableCell>
                        <TableCell
                          className="text-right"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {r.status === 'PENDING' && canManage ? (
                            <div className="inline-flex gap-1 can-hover:opacity-60 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setApproveTarget(r)}
                                disabled={insufficient}
                                title={
                                  insufficient
                                    ? 'Balance is below the requested hours'
                                    : undefined
                                }
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
                    );
                  })}
                </TableBody>
              </Table>
              {items && total !== null && total > items.length && (
                <p className="px-4 py-2 text-xs text-silver/70 border-t border-navy-secondary">
                  Showing {items.length} of {total} requests
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Single approve — optional note passed along to the associate. */}
      <DecisionDialog
        open={approveTarget !== null}
        title="Approve request"
        description={`Approve ${approveTarget?.associateName ?? 'this request'} — you can add an optional note for the associate.`}
        noteRequired={false}
        confirmLabel="Approve"
        destructive={false}
        submitting={deciding}
        onClose={() => setApproveTarget(null)}
        onSubmit={singleApprove}
      />

      {/* Single deny — note is required. */}
      <DecisionDialog
        open={denyTarget !== null}
        title="Deny request"
        description="The associate will see your note in their request history."
        noteRequired
        confirmLabel="Deny"
        destructive
        submitting={deciding}
        onClose={() => setDenyTarget(null)}
        onSubmit={singleDeny}
      />

      {/* Bulk deny — one shared note applied to every selected request. */}
      <DecisionDialog
        open={bulkDenyOpen}
        title={`Deny ${selected.size} request${selected.size === 1 ? '' : 's'}`}
        description="One note is applied to every selected request; each associate will see it in their history."
        noteRequired
        confirmLabel="Deny selected"
        destructive
        submitting={bulkBusy}
        onClose={() => setBulkDenyOpen(false)}
        onSubmit={bulkDeny}
      />

      {/* Row detail drawer — the queue truncates the reason; this shows it in full. */}
      <Drawer open={detail !== null} onOpenChange={(o) => !o && setDetail(null)}>
        {detail && (
          <>
            <DrawerHeader>
              <DrawerTitle>
                <AssociateLink associateId={detail.associateId}>
                  {detail.associateName ?? 'Request'}
                </AssociateLink>
              </DrawerTitle>
              <DrawerDescription>
                {CATEGORY_LABELS[detail.category] ?? detail.category} ·{' '}
                {fmtYmd(detail.startDate)}
                {detail.startDate !== detail.endDate &&
                  ` – ${fmtYmd(detail.endDate)}`}
              </DrawerDescription>
            </DrawerHeader>
            <DrawerBody className="space-y-4">
              <div className="flex items-center gap-2">
                <RowStatus status={detail.status} />
                <span
                  className={`text-sm tabular-nums ${
                    isInsufficient(detail) ? 'text-alert' : 'text-silver'
                  }`}
                >
                  {fmtHours(detail.requestedMinutes)} requested
                  {detail.balanceMinutes !== null &&
                    detail.balanceMinutes !== undefined &&
                    ` · ${fmtHours(detail.balanceMinutes)} available`}
                </span>
              </div>
              <div>
                <div className="text-2xs uppercase tracking-widest text-silver mb-1">
                  Reason
                </div>
                <p className="text-sm text-white whitespace-pre-wrap">
                  {detail.reason || 'No reason given.'}
                </p>
              </div>
              {detail.reviewerNote && (
                <div>
                  <div className="text-2xs uppercase tracking-widest text-silver mb-1">
                    Reviewer note
                  </div>
                  <p className="text-sm text-white whitespace-pre-wrap">
                    {detail.reviewerNote}
                  </p>
                </div>
              )}
              <div className="text-xs text-silver/80 space-y-1">
                <div>Submitted {fmtDateTime(detail.createdAt)}</div>
                {detail.decidedAt && (
                  <div>
                    Decided {fmtDateTime(detail.decidedAt)}
                    {detail.reviewerEmail && ` by ${detail.reviewerEmail}`}
                  </div>
                )}
              </div>
            </DrawerBody>
          </>
        )}
      </Drawer>
    </div>
  );
}

function RowStatus({ status }: { status: TimeOffRequestStatus }) {
  if (status === 'APPROVED') return <Badge variant="success">Approved</Badge>;
  if (status === 'DENIED') return <Badge variant="destructive">Denied</Badge>;
  if (status === 'CANCELLED') return <Badge variant="outline">Withdrawn</Badge>;
  return <Badge variant="pending">Pending</Badge>;
}

interface DecisionDialogProps {
  open: boolean;
  title: string;
  description: string;
  noteRequired: boolean;
  confirmLabel: string;
  destructive: boolean;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (note: string) => void;
}

/** Shared approve/deny dialog. Deny (single and bulk) requires a note;
 *  approve treats it as optional. */
function DecisionDialog({
  open,
  title,
  description,
  noteRequired,
  confirmLabel,
  destructive,
  submitting,
  onClose,
  onSubmit,
}: DecisionDialogProps) {
  const [note, setNote] = useState('');

  useEffect(() => {
    if (open) setNote('');
  }, [open]);

  const submit = () => {
    if (noteRequired && note.trim().length === 0) {
      toast.error('A note is required when denying.');
      return;
    }
    onSubmit(note);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <Field label={noteRequired ? 'Note' : 'Note (optional)'} required={noteRequired}>
          {(p) => (
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={
                noteRequired ? 'Coverage gap that week, etc.' : 'Enjoy the trip!'
              }
              maxLength={500}
              {...p}
            />
          )}
        </Field>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            loading={submitting}
            variant={destructive ? 'destructive' : 'primary'}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
