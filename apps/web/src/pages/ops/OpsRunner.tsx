import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Camera,
  Check,
  ChevronRight,
  ClipboardList,
  Flag,
  Plus,
  Thermometer,
  Users,
  X,
} from 'lucide-react';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
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
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Input, Textarea } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { toast } from '@/components/ui/Toaster';
import {
  addOpsAdhocTask,
  addOpsHandover,
  closeOpsShift,
  decideOpsHandover,
  getOpsOpenOptions,
  getOpsShift,
  openOpsShift,
  opsPhotoUrl,
  patchOpsTask,
  uploadOpsTaskPhoto,
  type OpsHandoverKind,
  type OpsShiftDetail,
  type OpsTaskRow,
} from '@/lib/opsApi';

/**
 * The shift supervisor's floor tool. Touch-first: one column, big
 * targets, camera-native photo capture — built to be worked one-handed
 * on an iPad between aisles. Associates never see this; the supervisor
 * records reality and tags who did the physical work.
 */

const PERIOD_LABEL: Record<string, string> = {
  MORNING: 'Morning',
  EVENING: 'Evening',
  CLOSING: 'Closing',
  OVERNIGHT: 'Overnight',
};

const HANDOVER_KIND_LABEL: Record<OpsHandoverKind, string> = {
  NOTE: 'Note',
  UNFINISHED_TASK: 'Unfinished task',
  SPECIAL_ORDER: 'Special order',
  COACH_COMPLAINT: 'Walmart coach complaint',
  EQUIPMENT: 'Equipment problem',
  STOCKING: 'Stocking issue',
};

export function OpsRunner() {
  const [shiftId, setShiftId] = useState<string | null>(null);
  const [detail, setDetail] = useState<OpsShiftDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (id: string) => {
    try {
      setDetail(await getOpsShift(id));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the shift.');
    }
  }, []);

  useEffect(() => {
    if (shiftId) void load(shiftId);
  }, [shiftId, load]);

  if (!shiftId) {
    return <OpenShiftPanel onOpened={(id) => setShiftId(id)} />;
  }
  if (error) {
    return <ErrorBanner>{error}</ErrorBanner>;
  }
  if (!detail) {
    return <Skeleton className="h-64" />;
  }
  return (
    <ShiftRunner
      detail={detail}
      refresh={() => void load(shiftId)}
      onClosed={() => {
        setShiftId(null);
        setDetail(null);
      }}
    />
  );
}

/* ===== Open / resume ===================================================== */

function OpenShiftPanel({ onOpened }: { onOpened: (shiftId: string) => void }) {
  const [options, setOptions] = useState<Awaited<
    ReturnType<typeof getOpsOpenOptions>
  > | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [manualDept, setManualDept] = useState<Record<string, string>>({});

  useEffect(() => {
    getOpsOpenOptions()
      .then(setOptions)
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : 'Could not load today.'),
      );
  }, []);

  if (error) return <ErrorBanner>{error}</ErrorBanner>;
  if (!options) return <Skeleton className="h-48" />;

  const open = async (position: string, department?: string) => {
    setBusy(position);
    try {
      const res = await openOpsShift({ position, ...(department ? { department } : {}) });
      onOpened(res.shiftId);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not open the shift.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      {options.resumeShift && (
        <Card className="border-gold/40">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
            <div>
              <div className="text-white font-medium">
                Your {options.resumeShift.department} shift is still open
              </div>
              <div className="text-xs text-silver mt-0.5">
                {options.resumeShift.position} — pick up where you left off.
              </div>
            </div>
            <Button onClick={() => onOpened(options.resumeShift!.id)}>
              Resume shift
              <ChevronRight className="h-4 w-4" />
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Start your shift</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-silver/70 mb-3">
            Today&apos;s scheduled positions at your store. Opening a shift loads its
            SOP checklist automatically — store, headcounts, and times fill
            themselves in.
          </p>
          {options.positions.length === 0 ? (
            <EmptyState
              icon={ClipboardList}
              title="Nothing scheduled today"
              description="No shifts are on today's schedule for your store yet."
            />
          ) : (
            <ul className="space-y-2">
              {options.positions.map((p) => (
                <li
                  key={p.position}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-navy-secondary bg-navy-secondary/20 p-3"
                >
                  <div className="min-w-0">
                    <div className="text-white font-medium">{p.position}</div>
                    <div className="text-xs text-silver mt-0.5">
                      {p.department ?? 'Department?'} · {PERIOD_LABEL[p.period]} ·{' '}
                      {p.scheduledCount} scheduled
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {!p.department && (
                      <Select
                        size="sm"
                        aria-label={`Department for ${p.position}`}
                        value={manualDept[p.position] ?? ''}
                        onChange={(e) =>
                          setManualDept((prev) => ({ ...prev, [p.position]: e.target.value }))
                        }
                      >
                        <option value="">Pick department…</option>
                        {options.departments.map((d) => (
                          <option key={d} value={d}>
                            {d}
                          </option>
                        ))}
                      </Select>
                    )}
                    <Button
                      size="sm"
                      onClick={() => void open(p.position, manualDept[p.position] || undefined)}
                      loading={busy === p.position}
                      disabled={busy !== null || (!p.department && !manualDept[p.position])}
                    >
                      Open shift
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* ===== Runner ============================================================ */

function ShiftRunner({
  detail,
  refresh,
  onClosed,
}: {
  detail: OpsShiftDetail;
  refresh: () => void;
  onClosed: () => void;
}) {
  const { shift, tasks, handoverIn, clockedIn } = detail;
  const [adhocOpen, setAdhocOpen] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);

  const sections = useMemo(() => {
    const bySection = new Map<string, OpsTaskRow[]>();
    for (const t of tasks) {
      const key = t.section ?? 'Tasks';
      const list = bySection.get(key) ?? [];
      list.push(t);
      bySection.set(key, list);
    }
    return [...bySection.entries()];
  }, [tasks]);

  const done = tasks.filter((t) => t.status === 'DONE').length;
  const pct = tasks.length > 0 ? Math.round((done / tasks.length) * 100) : 0;

  return (
    <div className="space-y-4">
      {/* Header: everything auto-populated. */}
      <Card className="border-l-2 border-l-gold">
        <CardContent className="py-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-lg font-medium text-white">
                {shift.department} — {PERIOD_LABEL[shift.period]}
              </div>
              <div className="text-xs text-silver mt-0.5">
                {shift.clientName} · {shift.position} · {shift.dateKey}
                {shift.templateName ? ` · ${shift.templateName}` : ''}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => setAdhocOpen(true)}>
                <Plus className="h-3.5 w-3.5" />
                Add task
              </Button>
              <Button size="sm" onClick={() => setCloseOpen(true)}>
                Close shift
              </Button>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs tabular-nums">
            <span className="inline-flex items-center gap-1.5 text-silver">
              <Users className="h-3.5 w-3.5 text-gold" aria-hidden="true" />
              <span className="text-white">{shift.actualHeadcount}</span>/
              {shift.scheduledHeadcount} on the floor
            </span>
            <span className="text-silver">
              Checklist <span className="text-white">{done}</span>/{tasks.length} · {pct}%
            </span>
            {shift.tempAlerts > 0 && (
              <Badge variant="destructive">
                {shift.tempAlerts} temp alert{shift.tempAlerts === 1 ? '' : 's'}
              </Badge>
            )}
          </div>
          <div className="mt-2 h-1.5 rounded-full bg-navy-secondary overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-gold to-success transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
        </CardContent>
      </Card>

      {/* Handover from the previous shift — the FIRST thing to deal with. */}
      {handoverIn.length > 0 && (
        <Card className="border-warning/40">
          <CardHeader>
            <CardTitle className="text-base">
              From the previous shift ({handoverIn.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {handoverIn.map((h) => (
              <HandoverDecisionRow
                key={h.id}
                item={h}
                shiftId={shift.id}
                onDecided={refresh}
              />
            ))}
          </CardContent>
        </Card>
      )}

      {/* The checklist, by section. */}
      {sections.map(([section, rows]) => (
        <Card key={section}>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              {section}
              <span className="ml-2 text-xs font-normal text-silver/70 tabular-nums">
                {rows.filter((r) => r.status === 'DONE').length}/{rows.length}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="divide-y divide-navy-secondary/60">
            {rows.map((task) => (
              <TaskRow key={task.id} task={task} clockedIn={clockedIn} onChanged={refresh} />
            ))}
          </CardContent>
        </Card>
      ))}

      <AdhocDialog
        open={adhocOpen}
        onOpenChange={setAdhocOpen}
        shiftId={shift.id}
        onAdded={refresh}
      />
      <CloseDialog
        open={closeOpen}
        onOpenChange={setCloseOpen}
        detail={detail}
        onClosed={onClosed}
      />
    </div>
  );
}

/* ===== One task ========================================================== */

function TaskRow({
  task,
  clockedIn,
  onChanged,
}: {
  task: OpsTaskRow;
  clockedIn: { id: string; name: string }[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [numberDraft, setNumberDraft] = useState(
    task.answerNumber != null ? String(task.answerNumber) : '',
  );
  const [textDraft, setTextDraft] = useState(task.answerText ?? '');
  const fileRef = useRef<HTMLInputElement | null>(null);

  const patch = async (body: Parameters<typeof patchOpsTask>[1]) => {
    setBusy(true);
    try {
      await patchOpsTask(task.id, body);
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  };

  const uploadPhoto = async (file: File) => {
    setBusy(true);
    try {
      await uploadOpsTaskPhoto(task.id, file);
      toast.success('Photo attached.');
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setBusy(false);
    }
  };

  const isDone = task.status === 'DONE';
  const isBlocked = task.status === 'BLOCKED';

  return (
    <div className={cn('py-2.5', isDone && 'opacity-70')}>
      <div className="flex items-start gap-3">
        {/* The big tap target: cycles OPEN → DONE (and back). */}
        <button
          type="button"
          onClick={() => void patch({ status: isDone ? 'OPEN' : 'DONE' })}
          disabled={busy}
          aria-label={isDone ? `Reopen "${task.title}"` : `Mark "${task.title}" done`}
          className={cn(
            'mt-0.5 grid h-7 w-7 coarse:h-9 coarse:w-9 shrink-0 place-items-center rounded-full border transition-colors',
            isDone
              ? 'border-success bg-success/20 text-success'
              : isBlocked
                ? 'border-alert bg-alert/15 text-alert'
                : 'border-navy-secondary text-silver/40 hover:border-gold hover:text-gold',
          )}
        >
          {isDone ? (
            <Check className="h-4 w-4" strokeWidth={3} />
          ) : isBlocked ? (
            <X className="h-4 w-4" strokeWidth={3} />
          ) : (
            <span className="h-2 w-2 rounded-full bg-current" />
          )}
        </button>

        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright rounded"
          >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className={cn('text-sm text-white', isDone && 'line-through decoration-1')}>
                {task.title}
              </span>
              {!task.required && (
                <span className="text-2xs text-silver/50">optional</span>
              )}
              {task.source === 'CARRYOVER' && <Badge variant="pending">carried over</Badge>}
              {task.source === 'ADHOC' && task.priority === 'HIGH' && (
                <Badge variant="destructive">high</Badge>
              )}
              {task.tempOutOfRange && (
                <span
                  className="inline-flex items-center gap-1 text-2xs text-alert"
                  title="This reading was outside the allowed range — ops has been alerted."
                >
                  <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                  out of range
                </span>
              )}
              {(task.photoRequired || task.responseType === 'PHOTO') &&
                task.photos.length === 0 && (
                  <span className="inline-flex items-center gap-1 text-2xs text-warning">
                    <Camera className="h-3 w-3" aria-hidden="true" />
                    photo needed
                  </span>
                )}
            </div>
            {/* Answer summary line. */}
            <div className="mt-0.5 text-xs text-silver/70">
              {task.responseType === 'TEMPERATURE' && task.answerNumber != null && (
                <span className="tabular-nums">
                  {task.tempLabel ?? 'Reading'}: {task.answerNumber}°F
                  {task.tempMin != null && task.tempMax != null
                    ? ` (allowed ${task.tempMin}–${task.tempMax})`
                    : ''}
                </span>
              )}
              {task.responseType === 'NUMBER' && task.answerNumber != null && (
                <span className="tabular-nums">Count: {task.answerNumber}</span>
              )}
              {task.answerChoice && <span>Answer: {task.answerChoice}</span>}
              {task.doneAssociate && <span> · by {task.doneAssociate.name}</span>}
              {task.photos.length > 0 && (
                <span> · {task.photos.length} photo{task.photos.length === 1 ? '' : 's'}</span>
              )}
              {isBlocked && task.blockedReason && (
                <span className="text-alert"> · blocked: {task.blockedReason}</span>
              )}
            </div>
          </button>

          {expanded && (
            <div className="mt-2 space-y-2.5 rounded-md border border-navy-secondary bg-navy-secondary/20 p-3">
              {task.instructions && (
                <p className="text-xs text-silver">{task.instructions}</p>
              )}

              {/* Typed response controls. */}
              {(task.responseType === 'YES_NO' || task.responseType === 'YES_NO_PARTIAL') && (
                <div className="flex flex-wrap gap-2">
                  {(task.responseType === 'YES_NO_PARTIAL'
                    ? (['YES', 'NO', 'PARTIAL'] as const)
                    : (['YES', 'NO'] as const)
                  ).map(
                    (choice) => (
                      <Button
                        key={choice}
                        size="sm"
                        variant={task.answerChoice === choice ? 'primary' : 'outline'}
                        onClick={() =>
                          void patch({ answerChoice: choice, status: 'DONE' })
                        }
                        disabled={busy}
                      >
                        {choice === 'YES' ? 'Yes' : choice === 'NO' ? 'No' : 'Partial'}
                      </Button>
                    ),
                  )}
                </div>
              )}

              {(task.responseType === 'NUMBER' || task.responseType === 'TEMPERATURE') && (
                <div className="flex items-end gap-2">
                  <div>
                    <Label className="text-xs">
                      {task.responseType === 'TEMPERATURE'
                        ? (task.tempLabel ?? 'Temperature °F')
                        : 'Count'}
                    </Label>
                    <Input
                      inputMode="decimal"
                      className="w-32 tabular-nums"
                      value={numberDraft}
                      onChange={(e) => setNumberDraft(e.target.value)}
                      placeholder={task.responseType === 'TEMPERATURE' ? 'e.g. 36' : 'e.g. 84'}
                    />
                  </div>
                  <Button
                    size="sm"
                    onClick={() => {
                      const n = Number(numberDraft);
                      if (!Number.isFinite(n)) {
                        toast.error('Enter a number.');
                        return;
                      }
                      void patch({ answerNumber: n, status: 'DONE' });
                    }}
                    loading={busy}
                  >
                    {task.responseType === 'TEMPERATURE' ? (
                      <Thermometer className="h-3.5 w-3.5" />
                    ) : null}
                    Record
                  </Button>
                  {task.responseType === 'TEMPERATURE' &&
                    task.tempMin != null &&
                    task.tempMax != null && (
                      <span className="pb-2 text-2xs text-silver/60 tabular-nums">
                        allowed {task.tempMin}–{task.tempMax}°F
                      </span>
                    )}
                </div>
              )}

              {task.responseType === 'TEXT' && (
                <div className="space-y-1.5">
                  <Textarea
                    rows={2}
                    value={textDraft}
                    onChange={(e) => setTextDraft(e.target.value)}
                    placeholder="Write it down — this becomes part of the record."
                  />
                  <Button
                    size="sm"
                    onClick={() => void patch({ answerText: textDraft, status: 'DONE' })}
                    loading={busy}
                    disabled={!textDraft.trim()}
                  >
                    Save answer
                  </Button>
                </div>
              )}

              {/* Photos — camera-native on touch devices. */}
              <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void uploadPhoto(f);
                    e.target.value = '';
                  }}
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => fileRef.current?.click()}
                  loading={busy}
                >
                  <Camera className="h-3.5 w-3.5" />
                  {task.photos.length > 0 ? 'Add another photo' : 'Take photo'}
                </Button>
                {task.photos.map((p) => (
                  <a
                    key={p.id}
                    href={opsPhotoUrl(p.id)}
                    target="_blank"
                    rel="noreferrer"
                    className="block h-12 w-12 overflow-hidden rounded border border-navy-secondary"
                    title={p.filename}
                  >
                    {/* eslint-disable-next-line jsx-a11y/img-redundant-alt */}
                    <img
                      src={opsPhotoUrl(p.id)}
                      alt={`Photo: ${p.filename}`}
                      className="h-full w-full object-cover"
                    />
                  </a>
                ))}
              </div>

              {/* Who did the physical work (associates never log in here). */}
              {clockedIn.length > 0 && (
                <div className="flex items-end gap-2">
                  <div className="min-w-[180px]">
                    <Label className="text-xs">Done by (clocked in now)</Label>
                    <Select
                      value={task.doneAssociate?.id ?? ''}
                      onChange={(e) =>
                        void patch({ doneAssociateId: e.target.value || null })
                      }
                    >
                      <option value="">—</option>
                      {clockedIn.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>
              )}

              {/* Blocked / unblock. */}
              <div className="flex flex-wrap gap-2 pt-1">
                {!isBlocked ? (
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => {
                      const reason = window.prompt('Why is this blocked?');
                      if (reason?.trim()) {
                        void patch({ status: 'BLOCKED', blockedReason: reason.trim() });
                      }
                    }}
                    disabled={busy || isDone}
                  >
                    <Flag className="h-3.5 w-3.5" />
                    Blocked
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void patch({ status: 'OPEN', blockedReason: null })}
                    disabled={busy}
                  >
                    Unblock
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ===== Handover decision row ============================================ */

function HandoverDecisionRow({
  item,
  shiftId,
  onDecided,
}: {
  item: OpsShiftDetail['handoverIn'][number];
  shiftId: string;
  onDecided: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const decide = async (action: 'CARRY' | 'DISMISS' | 'REVIEW') => {
    setBusy(action);
    try {
      await decideOpsHandover(item.id, { action, shiftId });
      toast.success(
        action === 'CARRY'
          ? 'Added to your shift.'
          : action === 'DISMISS'
            ? 'Dismissed — on the record.'
            : 'Marked reviewed.',
      );
      onDecided();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not decide.');
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-navy-secondary bg-navy-secondary/20 p-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <Badge variant={item.priority === 'HIGH' ? 'destructive' : 'default'}>
            {HANDOVER_KIND_LABEL[item.kind]}
          </Badge>
          <span className="text-2xs text-silver/60">
            from {item.from.position} · {item.from.dateKey}
          </span>
        </div>
        <p className="mt-1 text-sm text-white">{item.body}</p>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button size="sm" onClick={() => void decide('CARRY')} loading={busy === 'CARRY'}>
          Carry
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void decide('REVIEW')}
          loading={busy === 'REVIEW'}
        >
          Reviewed
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void decide('DISMISS')}
          loading={busy === 'DISMISS'}
        >
          Dismiss
        </Button>
      </div>
    </div>
  );
}

/* ===== Ad-hoc + close dialogs =========================================== */

function AdhocDialog({
  open,
  onOpenChange,
  shiftId,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  shiftId: string;
  onAdded: () => void;
}) {
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<'HIGH' | 'MEDIUM' | 'LOW'>('MEDIUM');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setTitle('');
      setPriority('MEDIUM');
    }
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add a task</DialogTitle>
          <DialogDescription>
            Something came up on the floor — spill in aisle 7, recount a
            delivery, recheck a unit.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-xs">What needs doing</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Clean up spill in aisle 7"
              autoFocus
            />
          </div>
          <div>
            <Label className="text-xs">Priority</Label>
            <Select
              value={priority}
              onChange={(e) => setPriority(e.target.value as 'HIGH' | 'MEDIUM' | 'LOW')}
            >
              <option value="HIGH">High</option>
              <option value="MEDIUM">Medium</option>
              <option value="LOW">Low</option>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={async () => {
              if (!title.trim()) return;
              setBusy(true);
              try {
                await addOpsAdhocTask(shiftId, { title: title.trim(), priority });
                onAdded();
                onOpenChange(false);
              } catch (err) {
                toast.error(err instanceof ApiError ? err.message : 'Could not add.');
              } finally {
                setBusy(false);
              }
            }}
            loading={busy}
            disabled={!title.trim()}
          >
            Add task
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CloseDialog({
  open,
  onOpenChange,
  detail,
  onClosed,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  detail: OpsShiftDetail;
  onClosed: () => void;
}) {
  const { shift, tasks } = detail;
  const [summary, setSummary] = useState('');
  const [items, setItems] = useState<
    { kind: OpsHandoverKind; body: string; priority: 'HIGH' | 'MEDIUM' | 'LOW' }[]
  >([]);
  const [draftKind, setDraftKind] = useState<OpsHandoverKind>('NOTE');
  const [draftBody, setDraftBody] = useState('');
  const [busy, setBusy] = useState(false);

  const openRequired = tasks.filter((t) => t.required && t.status !== 'DONE');

  useEffect(() => {
    if (open) {
      setSummary('');
      setItems([]);
      setDraftBody('');
      setDraftKind('NOTE');
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Close shift — handover first</DialogTitle>
          <DialogDescription>
            What does the next shift need to know? Unfinished work, special
            orders, coach complaints, equipment — nothing on paper, nothing
            verbal.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {openRequired.length > 0 && (
            <div className="rounded-md border border-warning/40 bg-warning/[0.07] p-3 text-xs">
              <div className="font-medium text-white">
                {openRequired.length} required item{openRequired.length === 1 ? '' : 's'} still
                open
              </div>
              <div className="mt-0.5 text-silver">
                You can close anyway — the record will show the shift closed
                incomplete and operations will see it. Consider handing the work
                over below.
              </div>
            </div>
          )}

          {/* Handover composer. */}
          <div className="rounded-md border border-navy-secondary bg-navy-secondary/20 p-3 space-y-2">
            <div className="text-xs font-medium text-white">Handover to the next shift</div>
            {items.map((i, idx) => (
              <div
                key={idx}
                className="flex items-center justify-between gap-2 text-xs text-silver"
              >
                <span className="min-w-0 truncate">
                  <span className="text-white">{HANDOVER_KIND_LABEL[i.kind]}:</span> {i.body}
                </span>
                <button
                  type="button"
                  className="text-silver/50 hover:text-alert"
                  onClick={() => setItems((prev) => prev.filter((_, j) => j !== idx))}
                  aria-label="Remove handover item"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            <div className="flex flex-wrap items-end gap-2">
              <div>
                <Label className="text-xs">Type</Label>
                <Select
                  size="sm"
                  value={draftKind}
                  onChange={(e) => setDraftKind(e.target.value as OpsHandoverKind)}
                >
                  {(Object.keys(HANDOVER_KIND_LABEL) as OpsHandoverKind[]).map((k) => (
                    <option key={k} value={k}>
                      {HANDOVER_KIND_LABEL[k]}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="min-w-[160px] flex-1">
                <Label className="text-xs">Detail</Label>
                <Input
                  value={draftBody}
                  onChange={(e) => setDraftBody(e.target.value)}
                  placeholder="e.g. 2 pallets of dairy left in staging"
                />
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  if (!draftBody.trim()) return;
                  setItems((prev) => [
                    ...prev,
                    { kind: draftKind, body: draftBody.trim(), priority: 'MEDIUM' },
                  ]);
                  setDraftBody('');
                }}
                disabled={!draftBody.trim()}
              >
                Add
              </Button>
            </div>
          </div>

          <div>
            <Label className="text-xs">Closing summary (optional)</Label>
            <Textarea
              rows={2}
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="How did the shift go?"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={async () => {
              setBusy(true);
              try {
                if (items.length > 0) {
                  await addOpsHandover(shift.id, items);
                }
                await closeOpsShift(shift.id, summary.trim() || undefined);
                toast.success('Shift closed — the record is final.');
                onOpenChange(false);
                onClosed();
              } catch (err) {
                toast.error(err instanceof ApiError ? err.message : 'Could not close.');
              } finally {
                setBusy(false);
              }
            }}
            loading={busy}
          >
            Close shift
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
