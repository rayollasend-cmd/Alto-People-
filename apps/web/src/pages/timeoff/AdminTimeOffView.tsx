import { useCallback, useEffect, useMemo, useState } from 'react';
import { AssociateLink } from '@/components/ui/AssociateLink';
import { CalendarCheck, Check, MessageSquarePlus, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  isEventBasedTimeOffCategory,
  type TimeOffRequest,
  type TimeOffRequestStatus,
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
import { usePrompt } from '@/lib/confirm';
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
import { DataGrid } from '@/components/ui/DataGrid';

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

/**
 * Approving would over-draw the associate's balance — which disables the
 * approve buttons outright, so it must only be true where a balance is
 * actually what grants the leave. Bereavement and jury duty are granted by
 * the event; the server will not refuse them, and neither should this.
 */
export const isInsufficient = (r: TimeOffRequest) =>
  !isEventBasedTimeOffCategory(r.category) &&
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
  // Row id currently being one-click approved — drives that row's spinner.
  const [quickApproveId, setQuickApproveId] = useState<string | null>(null);
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

  // One-click row approve — same call as the dialog submit, just without
  // the note stop. "Approve with note…" still opens the dialog.
  /**
   * The balance said no — offer the way through rather than a dead end.
   *
   * Most associates have no balance at all: only SICK accrues, and only
   * where state law provides for it, while every other category needs an
   * entitlement someone configured by hand. So this is the common case,
   * not the exception, and the approver needs more than an apology.
   * The reason is required because it lands in the ledger next to a
   * negative balance.
   */
  const prompt = usePrompt();

  const offerOverride = async (
    requestId: string,
    who: string,
    details: { currentMinutes: number; requestedMinutes: number },
    after: () => void,
  ) => {
    const reason = (
      await prompt({
        title: 'Approve without the balance?',
        description:
          `${who} has ${fmtHours(details.currentMinutes)} available and asked for ` +
          `${fmtHours(details.requestedMinutes)}. Approving anyway takes the balance negative — ` +
          'say why, and it goes on the ledger beside it.',
        reasonLabel: 'Why this is approved anyway',
        reasonPlaceholder: 'e.g. Unpaid day, agreed with Ops',
        confirmLabel: 'Approve anyway',
      })
    )?.trim();
    if (!reason) return;
    try {
      await approveAdminRequest(requestId, undefined, reason);
      toast.success(`Approved ${who} — balance now negative.`);
      after();
    } catch (err) {
      toast.error('Could not approve.', {
        description: err instanceof Error ? err.message : 'Something went wrong.',
      });
    }
  };

  const quickApprove = async (r: TimeOffRequest) => {
    setQuickApproveId(r.id);
    try {
      await approveAdminRequest(r.id, undefined);
      toast.success(`Approved ${r.associateName ?? 'request'}.`);
      refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'insufficient_balance') {
        const d = err.details as { currentMinutes: number; requestedMinutes: number };
        await offerOverride(r.id, r.associateName ?? 'this request', d, refresh);
        return;
      }
      toast.error('Could not approve.', {
        description: err instanceof Error ? err.message : 'Something went wrong.',
      });
    } finally {
      setQuickApproveId(null);
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
        const who = approveTarget.associateName ?? 'this request';
        await offerOverride(approveTarget.id, who, d, () => {
          setApproveTarget(null);
          refresh();
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
              {/* The page keeps the selection (the deny dialog reads it
                  later), so the grid is told which rows are chosen and
                  draws no bulk bar of its own — the one above stays. */}
              <DataGrid<TimeOffRequest>
                id="time-off-admin"
                caption="Time-off requests"
                rows={visible}
                rowKey={(r) => r.id}
                search={false}
                urlState={false}
                exportCsv={{ filename: 'time-off-requests' }}
                total={total ?? undefined}
                onRowClick={(r) => setDetail(r)}
                rowActionLabel={(r) => `Open the request from ${r.associateName ?? 'associate'}`}
                selectable={
                  canManage
                    ? {
                        disabled: (r) => r.status !== 'PENDING',
                        selection: { selected, onChange: setSelected },
                      }
                    : undefined
                }
                columns={[
                  {
                    key: 'associate',
                    header: 'Associate',
                    accessor: (r) => r.associateName ?? '—',
                    sortable: true,
                    primary: true,
                    className: 'text-white',
                    cell: (r) => (
                      <div className="flex items-center gap-2.5">
                        <Avatar name={r.associateName ?? '—'} size="sm" />
                        <div className="min-w-0 truncate">
                          <AssociateLink associateId={r.associateId}>{r.associateName ?? '—'}</AssociateLink>
                        </div>
                      </div>
                    ),
                  },
                  {
                    key: 'category',
                    header: 'Category',
                    accessor: (r) => CATEGORY_LABELS[r.category] ?? r.category,
                    sortable: true,
                    cardMeta: true,
                  },
                  {
                    key: 'dates',
                    header: 'Dates',
                    accessor: (r) => r.startDate,
                    csv: (r) => (r.startDate === r.endDate ? r.startDate : `${r.startDate} – ${r.endDate}`),
                    sortable: true,
                    cardMeta: true,
                    className: 'tabular-nums',
                    cell: (r) => (
                      <>
                        {fmtYmd(r.startDate)}
                        {r.startDate !== r.endDate && ` – ${fmtYmd(r.endDate)}`}
                        {/* The coverage hole this approval would punch — shown
                            BEFORE the click, not discovered at the pre-shift check. */}
                        {r.status === 'PENDING' && (r.assignedShiftOverlaps ?? 0) > 0 && (
                          <span className="ml-2 inline-flex rounded-full bg-warning/15 px-2 py-0.5 text-2xs font-medium text-warning">
                            releases {r.assignedShiftOverlaps} {r.assignedShiftOverlaps === 1 ? 'shift' : 'shifts'}
                          </span>
                        )}
                      </>
                    ),
                  },
                  {
                    key: 'hours',
                    header: 'Hours',
                    accessor: (r) => r.requestedMinutes / 60,
                    csv: (r) => fmtHours(r.requestedMinutes),
                    sortable: true,
                    searchable: false,
                    align: 'right',
                    className: 'tabular-nums',
                    cell: (r) => (
                      <span className={isInsufficient(r) ? 'text-alert' : undefined}>
                        {fmtHours(r.requestedMinutes)} requested
                        {r.balanceMinutes !== null &&
                          r.balanceMinutes !== undefined &&
                          ` · ${fmtHours(r.balanceMinutes)} available`}
                      </span>
                    ),
                  },
                  {
                    key: 'reason',
                    header: 'Reason',
                    accessor: (r) => r.reason,
                    defaultHidden: true,
                    className: 'text-xs text-silver max-w-[18ch] truncate',
                    cell: (r) => r.reason || '—',
                  },
                  {
                    key: 'status',
                    header: 'Status',
                    accessor: (r) => r.status,
                    sortable: true,
                    cell: (r) => <RowStatus status={r.status} />,
                  },
                  {
                    key: 'actions',
                    header: 'Actions',
                    accessor: (r) => (r.status === 'PENDING' ? null : r.reviewerEmail),
                    csv: (r) => r.reviewerEmail ?? '',
                    searchable: false,
                    align: 'right',
                    stopRowClick: true,
                    cell: (r) => {
                      const insufficient = isInsufficient(r);
                      return r.status === 'PENDING' && canManage ? (
                        <div className="inline-flex gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => quickApprove(r)}
                            disabled={insufficient || quickApproveId !== null}
                            loading={quickApproveId === r.id}
                            title={insufficient ? 'Balance is below the requested hours' : 'Approve'}
                            aria-label="Approve"
                          >
                            <Check className="h-4 w-4 text-success" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setApproveTarget(r)}
                            disabled={insufficient || quickApproveId !== null}
                            title={insufficient ? 'Balance is below the requested hours' : 'Approve with note…'}
                            aria-label="Approve with note"
                          >
                            <MessageSquarePlus className="h-4 w-4 text-success/80" />
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setDenyTarget(r)} aria-label="Deny">
                            <X className="h-4 w-4 text-alert" />
                          </Button>
                        </div>
                      ) : (
                        <span className="text-silver/80 text-xs">{r.reviewerEmail ?? '—'}</span>
                      );
                    },
                  },
                ]}
              />
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
                {detail.status === 'PENDING' &&
                  (detail.assignedShiftOverlaps ?? 0) > 0 && (
                    <span className="inline-flex rounded-full bg-warning/15 px-2 py-0.5 text-2xs font-medium text-warning">
                      releases {detail.assignedShiftOverlaps}{' '}
                      {detail.assignedShiftOverlaps === 1
                        ? 'assigned shift'
                        : 'assigned shifts'}
                    </span>
                  )}
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
