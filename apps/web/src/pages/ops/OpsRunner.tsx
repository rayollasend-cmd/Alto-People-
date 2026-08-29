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
import {
  DEPT_FALLBACK_ICON,
  DEPT_ICON,
  DEPT_TONE,
  HANDOVER_KIND_ICON,
  HANDOVER_KIND_LABEL,
  PERIOD_LABEL,
} from './opsVisuals';

/**
 * The shift supervisor's floor tool — the flagship surface where the
 * standard becomes real work. Touch-first: one column, big targets,
 * camera-native photo capture, section rail for one-thumb navigation.
 * Associates never see this; the supervisor records reality and tags
 * who did the physical work.
 */

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
      {/* Hero: the day, framed. */}
      <div className="relative overflow-hidden rounded-lg border border-navy-secondary bg-gradient-to-br from-navy-secondary/60 via-navy to-navy p-5">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-8 -top-8 h-40 w-40 rounded-full bg-gold/10 blur-3xl"
        />
        <div className="relative">
          <div className="text-2xs uppercase tracking-[0.2em] text-gold">
            Your floor · {options.dateKey}
          </div>
          <div className="mt-1 text-xl font-medium text-white">
            {options.resumeShift ? 'Pick up where you left off' : 'Start your shift'}
          </div>
          <div className="mt-0.5 max-w-prose text-xs text-silver/70">
            Open a shift and its SOP checklist loads itself — store, headcounts,
            and standards fill in automatically.
          </div>
        </div>
      </div>

      {options.resumeShift && (
        <button
          type="button"
          onClick={() => onOpened(options.resumeShift!.id)}
          className="group flex w-full items-center gap-4 rounded-lg border border-gold/50 bg-gold/[0.06] p-4 text-left transition-colors hover:bg-gold/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
        >
          <span className="relative flex h-2.5 w-2.5 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-success" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-white">
              Your {options.resumeShift.department} shift is still live
            </div>
            <div className="mt-0.5 text-xs text-silver">
              {options.resumeShift.position} — tap to resume.
            </div>
          </div>
          <ChevronRight className="h-5 w-5 shrink-0 text-gold transition-transform group-hover:translate-x-0.5" />
        </button>
      )}

      {options.positions.length === 0 ? (
        <Card>
          <CardContent className="py-8">
            <EmptyState
              icon={ClipboardList}
              title="Nothing scheduled today"
              description="No shifts are on today's schedule for your store yet."
            />
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {options.positions.map((p) => {
            const Icon = (p.department && DEPT_ICON[p.department]) || DEPT_FALLBACK_ICON;
            const tone = (p.department && DEPT_TONE[p.department]) || 'text-gold';
            const needsDept = !p.department;
            return (
              <div
                key={p.position}
                className="group relative overflow-hidden rounded-lg border border-navy-secondary bg-navy-secondary/20 p-4 transition-colors hover:border-gold/40"
              >
                <div className="flex items-start gap-3">
                  <span
                    className={cn(
                      'grid h-12 w-12 shrink-0 place-items-center rounded-lg border border-navy-secondary bg-navy/70',
                      tone,
                    )}
                  >
                    <Icon className="h-6 w-6" aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-white">
                      {p.position}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-silver">
                      <span>{p.department ?? 'Department?'}</span>
                      <span className="rounded-full border border-navy-secondary px-1.5 py-px text-2xs text-silver/70">
                        {PERIOD_LABEL[p.period]}
                      </span>
                      <span className="inline-flex items-center gap-1 tabular-nums text-silver/70">
                        <Users className="h-3 w-3 text-gold" aria-hidden="true" />
                        {p.scheduledCount} scheduled
                      </span>
                    </div>
                    {needsDept && (
                      <Select
                        size="sm"
                        className="mt-2"
                        aria-label={`Department for ${p.position}`}
                        value={manualDept[p.position] ?? ''}
                        onChange={(e) =>
                          setManualDept((prev) => ({
                            ...prev,
                            [p.position]: e.target.value,
                          }))
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
                  </div>
                </div>
                <Button
                  className="mt-3 w-full"
                  onClick={() => void open(p.position, manualDept[p.position] || undefined)}
                  loading={busy === p.position}
                  disabled={busy !== null || (needsDept && !manualDept[p.position])}
                >
                  Open shift
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            );
          })}
        </div>
      )}
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
  // The same crew member usually does consecutive tasks — remember the
  // last "done by" pick so tagging the next task is one tap.
  const [lastTagged, setLastTagged] = useState<{ id: string; name: string } | null>(null);

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
  const allDone = tasks.length > 0 && done === tasks.length;

  // Evidence + risk stats for the hero strip.
  const stats = useMemo(() => {
    const temps = tasks.filter((t) => t.responseType === 'TEMPERATURE');
    return {
      tempsDone: temps.filter((t) => t.answerNumber != null).length,
      tempsTotal: temps.length,
      photos: tasks.reduce((n, t) => n + t.photos.length, 0),
      blocked: tasks.filter((t) => t.status === 'BLOCKED').length,
      highOpen: tasks.filter((t) => t.priority === 'HIGH' && t.status !== 'DONE').length,
    };
  }, [tasks]);

  const scrollTo = (section: string) => {
    document
      .getElementById(`ops-section-${section}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const Icon = DEPT_ICON[shift.department] ?? DEPT_FALLBACK_ICON;

  return (
    <div className="space-y-4">
      {/* Hero: the shift's heartbeat. */}
      <div
        className={cn(
          'relative overflow-hidden rounded-lg border p-5 transition-colors',
          allDone
            ? 'border-success/50 bg-gradient-to-br from-success/[0.10] via-navy to-navy'
            : 'border-navy-secondary bg-gradient-to-br from-navy-secondary/60 via-navy to-navy',
        )}
      >
        <div
          aria-hidden
          className={cn(
            'pointer-events-none absolute -right-8 -top-8 h-40 w-40 rounded-full blur-3xl',
            allDone ? 'bg-success/15' : 'bg-gold/10',
          )}
        />
        <div className="relative flex flex-wrap items-center gap-4">
          <svg viewBox="0 0 72 72" className="h-[72px] w-[72px] shrink-0" aria-hidden="true">
            <circle
              cx="36"
              cy="36"
              r="30"
              fill="none"
              strokeWidth="6"
              className="stroke-navy-secondary"
            />
            <circle
              cx="36"
              cy="36"
              r="30"
              fill="none"
              strokeWidth="6"
              strokeLinecap="round"
              strokeDasharray={2 * Math.PI * 30}
              strokeDashoffset={2 * Math.PI * 30 * (1 - pct / 100)}
              transform="rotate(-90 36 36)"
              className={cn(
                'transition-all duration-700',
                allDone ? 'stroke-success' : 'stroke-gold',
              )}
            />
            <text
              x="36"
              y="41"
              textAnchor="middle"
              className="fill-white text-[15px] font-semibold tabular-nums"
            >
              {pct}%
            </text>
          </svg>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
              </span>
              <span className="text-2xs uppercase tracking-[0.2em] text-gold">
                Shift live · {shift.dateKey}
              </span>
            </div>
            <div className="mt-1 flex items-center gap-2 text-xl font-medium text-white">
              <Icon
                className={cn('h-5 w-5', DEPT_TONE[shift.department] ?? 'text-gold')}
                aria-hidden="true"
              />
              {shift.department}
              <span className="text-base font-normal text-gold">
                {PERIOD_LABEL[shift.period]}
              </span>
            </div>
            <div className="mt-0.5 truncate text-xs text-silver">
              {shift.clientName} · {shift.position}
              {shift.templateName ? ` · ${shift.templateName}` : ''}
            </div>
            {/* Evidence strip — the shift's proof, live. */}
            <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs tabular-nums">
              <span className="inline-flex items-center gap-1.5 text-silver">
                <Users className="h-3.5 w-3.5 text-gold" aria-hidden="true" />
                <span className="text-white">{shift.actualHeadcount}</span>/
                {shift.scheduledHeadcount} on the floor
              </span>
              {stats.tempsTotal > 0 && (
                <span
                  className={cn(
                    'inline-flex items-center gap-1.5',
                    shift.tempAlerts > 0
                      ? 'text-alert'
                      : stats.tempsDone === stats.tempsTotal
                        ? 'text-success'
                        : 'text-silver',
                  )}
                >
                  <Thermometer className="h-3.5 w-3.5" aria-hidden="true" />
                  {stats.tempsDone}/{stats.tempsTotal} temps
                </span>
              )}
              <span
                className={cn(
                  'inline-flex items-center gap-1.5',
                  stats.photos > 0 ? 'text-sky' : 'text-silver/60',
                )}
              >
                <Camera className="h-3.5 w-3.5" aria-hidden="true" />
                {stats.photos} photo{stats.photos === 1 ? '' : 's'}
              </span>
              {stats.highOpen > 0 && (
                <Badge variant="destructive">{stats.highOpen} high-priority open</Badge>
              )}
              {stats.blocked > 0 && (
                <Badge variant="destructive">{stats.blocked} blocked</Badge>
              )}
            </div>
          </div>
          <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
            <Button variant="outline" onClick={() => setAdhocOpen(true)}>
              <Plus className="h-4 w-4" />
              Add task
            </Button>
            <Button
              onClick={() => setCloseOpen(true)}
              className={cn(allDone && 'animate-pulse')}
            >
              {allDone ? 'Ready — close shift' : 'Close shift'}
            </Button>
          </div>
        </div>
      </div>

      {/* Section rail — one-thumb navigation with live progress. */}
      {sections.length > 1 && (
        <div className="sticky top-2 z-10 -mx-1 overflow-x-auto px-1 pb-1">
          <div className="flex w-max gap-2 rounded-full border border-navy-secondary bg-navy/95 p-1.5 backdrop-blur">
            {sections.map(([section, rows]) => {
              const secDone = rows.filter((r) => r.status === 'DONE').length;
              const complete = secDone === rows.length;
              return (
                <button
                  key={section}
                  type="button"
                  onClick={() => scrollTo(section)}
                  className={cn(
                    'flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
                    complete
                      ? 'bg-success/15 text-success'
                      : 'text-silver hover:bg-navy-secondary/60 hover:text-white',
                  )}
                >
                  {complete && <Check className="h-3 w-3" strokeWidth={3} />}
                  {section}
                  <span className="tabular-nums text-2xs opacity-70">
                    {secDone}/{rows.length}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Handover from the previous shift — the FIRST thing to deal with. */}
      {handoverIn.length > 0 && (
        <Card className="border-warning/50 bg-warning/[0.03]">
          <CardHeader>
            <CardTitle className="text-base">
              <Flag className="mr-1.5 inline h-4 w-4 text-warning" aria-hidden="true" />
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
      {sections.map(([section, rows], secIdx) => {
        const secDone = rows.filter((r) => r.status === 'DONE').length;
        const secPct = rows.length > 0 ? Math.round((secDone / rows.length) * 100) : 0;
        return (
          <Card
            key={section}
            id={`ops-section-${section}`}
            className="scroll-mt-16"
          >
            <CardHeader className="pb-2">
              <div className="flex items-center gap-2.5">
                <span
                  className={cn(
                    'grid h-6 w-6 shrink-0 place-items-center rounded-full text-2xs font-semibold tabular-nums',
                    secPct === 100
                      ? 'bg-success/20 text-success'
                      : 'bg-gold/15 text-gold',
                  )}
                >
                  {secPct === 100 ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : secIdx + 1}
                </span>
                <CardTitle className="text-base">
                  {section}
                  <span className="ml-2 text-xs font-normal text-silver/60 tabular-nums">
                    {secDone}/{rows.length}
                  </span>
                </CardTitle>
                <div className="ml-auto h-1.5 w-24 overflow-hidden rounded-full bg-navy-secondary">
                  <div
                    className={cn(
                      'h-full rounded-full transition-all duration-500',
                      secPct === 100 ? 'bg-success' : 'bg-gold',
                    )}
                    style={{ width: `${secPct}%` }}
                  />
                </div>
              </div>
            </CardHeader>
            <CardContent className="divide-y divide-navy-secondary/60">
              {rows.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  clockedIn={clockedIn}
                  onChanged={refresh}
                  lastTagged={lastTagged}
                  onTagged={setLastTagged}
                />
              ))}
            </CardContent>
          </Card>
        );
      })}

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
  lastTagged,
  onTagged,
}: {
  task: OpsTaskRow;
  clockedIn: { id: string; name: string }[];
  onChanged: () => void;
  /** Last "done by" pick this shift — powers one-tap re-tagging. */
  lastTagged: { id: string; name: string } | null;
  onTagged: (a: { id: string; name: string } | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [blockOpen, setBlockOpen] = useState(false);
  const [blockReason, setBlockReason] = useState('');
  const [numberDraft, setNumberDraft] = useState(
    task.answerNumber != null ? String(task.answerNumber) : '',
  );
  const [textDraft, setTextDraft] = useState(task.answerText ?? '');
  const fileRef = useRef<HTMLInputElement | null>(null);

  const patch = async (body: Parameters<typeof patchOpsTask>[1]) => {
    setBusy(true);
    try {
      const res = await patchOpsTask(task.id, body);
      if (body.doneAssociateId) {
        const a = clockedIn.find((x) => x.id === body.doneAssociateId);
        if (a) onTagged(a);
      }
      // The closed loop announcing itself: a triggering answer just
      // spawned a corrective task in this section.
      if (res.followUp) {
        toast.warning(`Follow-up added: ${res.followUp.title}`, { duration: 6000 });
      }
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
      const res = await uploadOpsTaskPhoto(task.id, file);
      toast.success(
        res.autoCompleted ? 'Photo attached — task complete.' : 'Photo attached.',
      );
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setBusy(false);
    }
  };

  const isDone = task.status === 'DONE';
  const isBlocked = task.status === 'BLOCKED';
  const isNumeric = task.responseType === 'TEMPERATURE' || task.responseType === 'NUMBER';
  const isChoice =
    task.responseType === 'YES_NO' || task.responseType === 'YES_NO_PARTIAL';
  const isPhotoTask = task.responseType === 'PHOTO';

  const recordNumber = () => {
    const n = Number(numberDraft);
    if (!Number.isFinite(n) || numberDraft.trim() === '') {
      toast.error('Enter a number.');
      return;
    }
    void patch({ answerNumber: n, status: 'DONE' });
  };

  return (
    <div className={cn('py-2.5', isDone && 'opacity-70')}>
      {/* Always-mounted camera input — inline and expanded buttons share it. */}
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
              {task.source === 'FOLLOWUP' && (
                <Badge variant="destructive">follow-up</Badge>
              )}
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
                <span className="tabular-nums">
                  {task.answerNumber} {task.unit ?? 'recorded'}
                </span>
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

          {/* Inline quick controls — the shift's core loop with no expand
              tax: type, tap, next. Expand stays for the rich extras. */}
          {!isDone && !isBlocked && (isNumeric || isChoice || isPhotoTask) && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {isNumeric && (
                <>
                  <Input
                    inputMode="decimal"
                    className="h-8 w-24 coarse:h-10 coarse:w-28 tabular-nums"
                    value={numberDraft}
                    onChange={(e) => setNumberDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') recordNumber();
                    }}
                    placeholder={
                      task.responseType === 'TEMPERATURE'
                        ? (task.tempLabel ?? '°F')
                        : (task.unit ?? 'count')
                    }
                    aria-label={`${task.title} — ${task.responseType === 'TEMPERATURE' ? 'temperature' : 'count'}`}
                  />
                  <Button size="sm" onClick={recordNumber} loading={busy}>
                    {task.responseType === 'TEMPERATURE' ? (
                      <Thermometer className="h-3.5 w-3.5" />
                    ) : (
                      <Check className="h-3.5 w-3.5" />
                    )}
                    Record
                  </Button>
                  {task.responseType === 'TEMPERATURE' &&
                    task.tempMin != null &&
                    task.tempMax != null && (
                      <span className="text-2xs tabular-nums text-silver/50">
                        {task.tempMin}–{task.tempMax}°F
                      </span>
                    )}
                </>
              )}
              {isChoice &&
                (task.responseType === 'YES_NO_PARTIAL'
                  ? (['YES', 'NO', 'PARTIAL'] as const)
                  : (['YES', 'NO'] as const)
                ).map((choice) => (
                  <Button
                    key={choice}
                    size="sm"
                    variant={task.answerChoice === choice ? 'primary' : 'outline'}
                    onClick={() => void patch({ answerChoice: choice, status: 'DONE' })}
                    disabled={busy}
                    aria-label={`${task.title} — answer ${choice.toLowerCase()}`}
                  >
                    {choice === 'YES' ? 'Yes' : choice === 'NO' ? 'No' : 'Partial'}
                  </Button>
                ))}
              {isPhotoTask && (
                <Button
                  size="sm"
                  onClick={() => fileRef.current?.click()}
                  loading={busy}
                  aria-label={`${task.title} — take the photo (completes the task)`}
                >
                  <Camera className="h-3.5 w-3.5" />
                  Take photo — done
                </Button>
              )}
            </div>
          )}

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
                  ).map((choice) => (
                    <Button
                      key={choice}
                      size="sm"
                      variant={task.answerChoice === choice ? 'primary' : 'outline'}
                      onClick={() => void patch({ answerChoice: choice, status: 'DONE' })}
                      disabled={busy}
                    >
                      {choice === 'YES' ? 'Yes' : choice === 'NO' ? 'No' : 'Partial'}
                    </Button>
                  ))}
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
                    <img
                      src={opsPhotoUrl(p.id)}
                      alt={`Evidence: ${p.filename}`}
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
                  {/* Same crew, consecutive tasks — one tap re-tags. */}
                  {lastTagged && task.doneAssociate?.id !== lastTagged.id && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void patch({ doneAssociateId: lastTagged.id })}
                      disabled={busy}
                    >
                      Tag {lastTagged.name.split(' ')[0]}
                    </Button>
                  )}
                </div>
              )}

              {/* Blocked / unblock. */}
              <div className="flex flex-wrap gap-2 pt-1">
                {!isBlocked ? (
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => {
                      setBlockReason('');
                      setBlockOpen(true);
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

      {/* Block-with-reason — a proper dialog, not a browser prompt. */}
      <Dialog open={blockOpen} onOpenChange={setBlockOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Mark blocked</DialogTitle>
            <DialogDescription>“{task.title}” — what&apos;s in the way?</DialogDescription>
          </DialogHeader>
          <Input
            value={blockReason}
            onChange={(e) => setBlockReason(e.target.value)}
            placeholder="e.g. Waiting on maintenance for the compactor"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter' && blockReason.trim()) {
                setBlockOpen(false);
                void patch({ status: 'BLOCKED', blockedReason: blockReason.trim() });
              }
            }}
          />
          <DialogFooter>
            <Button
              variant="destructive"
              disabled={!blockReason.trim()}
              onClick={() => {
                setBlockOpen(false);
                void patch({ status: 'BLOCKED', blockedReason: blockReason.trim() });
              }}
            >
              <Flag className="h-3.5 w-3.5" />
              Mark blocked
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
  const KindIcon = HANDOVER_KIND_ICON[item.kind];
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
      <div className="flex min-w-0 items-start gap-2.5">
        <span
          className={cn(
            'mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md border',
            item.priority === 'HIGH'
              ? 'border-alert/50 bg-alert/10 text-alert'
              : 'border-navy-secondary bg-navy/60 text-gold',
          )}
        >
          <KindIcon className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-2xs text-silver/60">
            <span className="font-medium text-silver">{HANDOVER_KIND_LABEL[item.kind]}</span>
            {item.priority === 'HIGH' && <Badge variant="destructive">high</Badge>}
            <span>
              from {item.from.position} · {item.from.dateKey}
            </span>
          </div>
          <p className="mt-0.5 text-sm text-white">{item.body}</p>
        </div>
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
  // One-tap handover: unfinished tasks become chips — tap to hand over
  // verbatim instead of re-typing them at the most tired moment of the
  // shift. Tap again to leave out.
  const [carriedIds, setCarriedIds] = useState<Set<string>>(new Set());

  const openRequired = tasks.filter((t) => t.required && t.status !== 'DONE');
  const openWork = tasks.filter((t) => t.status !== 'DONE');

  useEffect(() => {
    if (open) {
      setSummary('');
      setItems([]);
      setDraftBody('');
      setDraftKind('NOTE');
      // Required unfinished work defaults to handed-over — leaving it out
      // is the deliberate act, not the accident.
      setCarriedIds(
        new Set(tasks.filter((t) => t.required && t.status !== 'DONE').map((t) => t.id)),
      );
    }
  }, [open, tasks]);

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

          {/* Unfinished work as one-tap handover chips. */}
          {openWork.length > 0 && (
            <div className="rounded-md border border-navy-secondary bg-navy-secondary/20 p-3">
              <div className="text-xs font-medium text-white">
                Hand these over? <span className="text-silver/60">(tap to toggle)</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {openWork.map((t) => {
                  const on = carriedIds.has(t.id);
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() =>
                        setCarriedIds((prev) => {
                          const next = new Set(prev);
                          if (next.has(t.id)) next.delete(t.id);
                          else next.add(t.id);
                          return next;
                        })
                      }
                      aria-pressed={on}
                      className={cn(
                        'inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-xs transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
                        on
                          ? 'border-gold/60 bg-gold/10 text-white'
                          : 'border-navy-secondary text-silver/60 hover:border-gold/30 hover:text-silver',
                      )}
                    >
                      {on ? (
                        <Check className="h-3 w-3 shrink-0 text-gold" strokeWidth={3} />
                      ) : (
                        <Flag className="h-3 w-3 shrink-0" />
                      )}
                      <span className="truncate">{t.title}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Handover composer. */}
          <div className="rounded-md border border-navy-secondary bg-navy-secondary/20 p-3 space-y-2">
            <div className="text-xs font-medium text-white">
              Anything else for the next shift?
            </div>
            {items.map((i, idx) => {
              const KindIcon = HANDOVER_KIND_ICON[i.kind];
              return (
                <div
                  key={idx}
                  className="flex items-center justify-between gap-2 text-xs text-silver"
                >
                  <span className="flex min-w-0 items-center gap-1.5 truncate">
                    <KindIcon className="h-3.5 w-3.5 shrink-0 text-gold" aria-hidden="true" />
                    <span className="text-white">{HANDOVER_KIND_LABEL[i.kind]}:</span>{' '}
                    {i.body}
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
              );
            })}
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
                const chipItems = openWork
                  .filter((t) => carriedIds.has(t.id))
                  .map((t) => ({
                    kind: 'UNFINISHED_TASK' as const,
                    body: t.title,
                    priority: t.priority,
                  }));
                const all = [...chipItems, ...items];
                if (all.length > 0) {
                  await addOpsHandover(shift.id, all);
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
