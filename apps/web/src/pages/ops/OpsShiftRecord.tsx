import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Camera,
  Check,
  CornerDownRight,
  Flag,
  Users,
  X,
} from 'lucide-react';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/Badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Skeleton } from '@/components/ui/Skeleton';
import {
  getOpsShift,
  opsPhotoUrl,
  type OpsShiftDetail,
  type OpsTaskRow,
} from '@/lib/opsApi';
import {
  DEPT_TONE,
  HANDOVER_KIND_ICON,
  HANDOVER_KIND_LABEL,
  PERIOD_LABEL,
} from './opsVisuals';

/**
 * The Shift Record — the read-only door into everything a shift
 * collected: every answer with its evidence, follow-up chains shown
 * parent → child, the handover ledger with decisions, photos inline.
 * This is what oversight opens from the board; nothing here mutates.
 */
export function OpsShiftRecordDialog({
  shiftId,
  onClose,
}: {
  shiftId: string;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<OpsShiftDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getOpsShift(shiftId)
      .then(setDetail)
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : 'Could not load the record.'),
      );
  }, [shiftId]);

  // Sections in order; follow-up children slot directly under their parent.
  const sections = useMemo(() => {
    if (!detail) return [];
    const children = new Map<string, OpsTaskRow[]>();
    for (const t of detail.tasks) {
      if (t.parentTaskId) {
        const list = children.get(t.parentTaskId) ?? [];
        list.push(t);
        children.set(t.parentTaskId, list);
      }
    }
    const bySection = new Map<string, { task: OpsTaskRow; children: OpsTaskRow[] }[]>();
    for (const t of detail.tasks) {
      if (t.parentTaskId) continue; // rendered under the parent
      const key = t.section ?? 'Tasks';
      const list = bySection.get(key) ?? [];
      list.push({ task: t, children: children.get(t.id) ?? [] });
      bySection.set(key, list);
    }
    return [...bySection.entries()];
  }, [detail]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        {error && <ErrorBanner>{error}</ErrorBanner>}
        {!detail && !error && <Skeleton className="h-64" />}
        {detail && (
          <>
            <DialogHeader>
              <DialogTitle>
                <span className={DEPT_TONE[detail.shift.department] ?? 'text-gold'}>
                  {detail.shift.department}
                </span>{' '}
                — {PERIOD_LABEL[detail.shift.period]}
                {detail.shift.status === 'CLOSED' ? (
                  detail.shift.closedIncomplete ? (
                    <Badge variant="destructive" className="ml-2 align-middle">
                      closed incomplete
                    </Badge>
                  ) : (
                    <Badge variant="success" className="ml-2 align-middle">
                      complete
                    </Badge>
                  )
                ) : (
                  <Badge variant="pending" className="ml-2 align-middle">
                    live
                  </Badge>
                )}
              </DialogTitle>
              <DialogDescription>
                {detail.shift.clientName} · {detail.shift.position} · {detail.shift.dateKey}
                {detail.shift.templateName ? ` · ${detail.shift.templateName}` : ''} — the
                shift as it was recorded. Nothing here can be edited.
              </DialogDescription>
            </DialogHeader>

            {/* Fact strip */}
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-md border border-navy-secondary bg-navy-secondary/20 px-3 py-2 text-xs tabular-nums">
              <span className="inline-flex items-center gap-1.5 text-silver">
                <Users className="h-3.5 w-3.5 text-gold" aria-hidden="true" />
                {detail.shift.actualHeadcount}/{detail.shift.scheduledHeadcount} floor
              </span>
              <span className="text-silver">
                SOP <span className="text-white">{detail.shift.sopDone}</span>/
                {detail.shift.sopTotal}
              </span>
              <span className="text-silver">
                All tasks <span className="text-white">{detail.shift.taskDone}</span>/
                {detail.shift.taskTotal}
              </span>
              {detail.shift.tempAlerts > 0 && (
                <span className="inline-flex items-center gap-1 text-alert">
                  <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                  {detail.shift.tempAlerts} temp alert
                  {detail.shift.tempAlerts === 1 ? '' : 's'}
                </span>
              )}
            </div>

            {detail.shift.closingSummary && (
              <p className="rounded-md border-l-2 border-l-gold bg-navy-secondary/20 px-3 py-2 text-sm italic text-silver">
                “{detail.shift.closingSummary}”
              </p>
            )}

            {/* The checklist, with lineage. */}
            {sections.map(([section, rows]) => (
              <div key={section}>
                <div className="mb-1.5 text-2xs uppercase tracking-wider text-silver/60">
                  {section}
                </div>
                <div className="divide-y divide-navy-secondary/50 rounded-md border border-navy-secondary">
                  {rows.map(({ task, children }) => (
                    <div key={task.id} className="px-3 py-2">
                      <RecordTaskLine task={task} />
                      {children.map((child) => (
                        <div key={child.id} className="mt-1.5 flex gap-1.5 pl-4">
                          <CornerDownRight
                            className="mt-1 h-3.5 w-3.5 shrink-0 text-warning"
                            aria-hidden="true"
                          />
                          <div className="min-w-0 flex-1">
                            <RecordTaskLine task={child} isFollowUp />
                          </div>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            ))}

            {/* Handover ledger. */}
            {detail.handoverOut.length > 0 && (
              <div>
                <div className="mb-1.5 text-2xs uppercase tracking-wider text-silver/60">
                  Handed to the next shift
                </div>
                <div className="divide-y divide-navy-secondary/50 rounded-md border border-navy-secondary">
                  {detail.handoverOut.map((h) => {
                    const KindIcon = HANDOVER_KIND_ICON[h.kind];
                    return (
                      <div
                        key={h.id}
                        className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                      >
                        <span className="flex min-w-0 items-center gap-2 text-sm">
                          <KindIcon
                            className="h-3.5 w-3.5 shrink-0 text-gold"
                            aria-hidden="true"
                          />
                          <span className="shrink-0 text-2xs text-silver/60">
                            {HANDOVER_KIND_LABEL[h.kind]}
                          </span>
                          <span className="min-w-0 truncate text-white">{h.body}</span>
                        </span>
                        <span className="shrink-0 text-2xs">
                          {h.status === 'PENDING' ? (
                            <Badge variant="pending">awaiting next shift</Badge>
                          ) : (
                            <span
                              className={cn(
                                h.status === 'CARRIED'
                                  ? 'text-success'
                                  : h.status === 'DISMISSED'
                                    ? 'text-silver/60'
                                    : 'text-silver',
                              )}
                            >
                              {h.status.toLowerCase()}
                              {h.decidedByEmail ? ` · ${h.decidedByEmail}` : ''}
                            </span>
                          )}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RecordTaskLine({ task, isFollowUp = false }: { task: OpsTaskRow; isFollowUp?: boolean }) {
  const isDone = task.status === 'DONE';
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span
          className={cn(
            'grid h-4.5 w-4.5 h-[18px] w-[18px] shrink-0 place-items-center rounded-full border',
            isDone
              ? 'border-success/60 bg-success/15 text-success'
              : task.status === 'BLOCKED'
                ? 'border-alert/60 bg-alert/15 text-alert'
                : 'border-navy-secondary text-silver/30',
          )}
        >
          {isDone ? (
            <Check className="h-3 w-3" strokeWidth={3} />
          ) : task.status === 'BLOCKED' ? (
            <X className="h-3 w-3" strokeWidth={3} />
          ) : (
            <span className="h-1.5 w-1.5 rounded-full bg-current" />
          )}
        </span>
        <span className={cn('text-sm', isDone ? 'text-silver' : 'text-white')}>
          {task.title}
        </span>
        {isFollowUp && <Badge variant="destructive">follow-up</Badge>}
        {task.source === 'ADHOC' && !isFollowUp && (
          <span className="text-2xs text-silver/50">ad-hoc</span>
        )}
        {task.source === 'CARRYOVER' && <Badge variant="pending">carried in</Badge>}
        {task.tempOutOfRange && (
          <span className="inline-flex items-center gap-1 text-2xs text-alert">
            <AlertTriangle className="h-3 w-3" aria-hidden="true" />
            out of range
          </span>
        )}
        {!task.required && <span className="text-2xs text-silver/40">optional</span>}
      </div>
      {/* The recorded answer + evidence. */}
      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 pl-6 text-xs text-silver/80">
        {task.responseType === 'TEMPERATURE' && task.answerNumber != null && (
          <span className={cn('tabular-nums', task.tempOutOfRange && 'text-alert')}>
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
        {task.answerText && <span className="italic">“{task.answerText}”</span>}
        {task.note && <span className="italic text-silver/60">note: {task.note}</span>}
        {task.status === 'BLOCKED' && task.blockedReason && (
          <span className="inline-flex items-center gap-1 text-alert">
            <Flag className="h-3 w-3" aria-hidden="true" />
            {task.blockedReason}
          </span>
        )}
        {task.doneAssociate && <span>by {task.doneAssociate.name}</span>}
        {task.photos.map((p) => (
          <a
            key={p.id}
            href={opsPhotoUrl(p.id)}
            target="_blank"
            rel="noreferrer"
            className="inline-block h-10 w-10 overflow-hidden rounded border border-navy-secondary align-middle"
            title={p.filename}
          >
            <img
              src={opsPhotoUrl(p.id)}
              alt={`Evidence for: ${task.title}`}
              loading="lazy"
              className="h-full w-full object-cover"
            />
          </a>
        ))}
        {(task.photoRequired || task.responseType === 'PHOTO') && task.photos.length === 0 && (
          <span className="inline-flex items-center gap-1 text-warning">
            <Camera className="h-3 w-3" aria-hidden="true" />
            photo missing
          </span>
        )}
      </div>
    </div>
  );
}
