import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Check, ChevronDown, Hand, PlayCircle, X } from 'lucide-react';
import { WORKER_CAPABILITIES, WORK_TASK_RISK_LABELS, WORK_TASK_STATUS_LABELS, type AssignmentReason, type RankedCandidate, type WorkTaskAssignmentView, type WorkTaskDetailView } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { getTask, handOffTask, autoAssignTask, recordTaskEvent } from '@/lib/tasksApi';
import { Badge, Button, Drawer, DrawerBody, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle, EmptyState, Skeleton } from '@/components/ui';
import { cn } from '@/lib/cn';
import { HolderIcon } from './TasksBoard';

/**
 * One task: who holds it and WHY (every factor the engine weighed, with
 * its points), the candidates it passed over and their reasons, the
 * timeline, and the actions: hand to a person, ask the engine again,
 * start, stall, fail, done, cancel.
 */

const CAP_LABEL = new Map<string, string>(WORKER_CAPABILITIES.map((c) => [c.code, c.label]));
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function ReasonList({ reasons }: { reasons: AssignmentReason[] }) {
  return (
    <ul className="space-y-1.5">
      {reasons.map((r, i) => (
        <li key={`${r.factor}-${i}`} className="flex items-start gap-2 text-sm">
          <span
            className={cn(
              'mt-0.5 w-10 shrink-0 text-right text-xs2 font-semibold tabular-nums',
              r.points > 0 ? 'text-success' : r.points < 0 ? 'text-alert' : 'text-ink-muted',
            )}
          >
            {r.points > 0 ? `+${r.points}` : r.points === 0 ? '·' : r.points}
          </span>
          <span className="min-w-0">
            <span className="text-xs2 uppercase tracking-[0.12em] text-ink-muted">{r.factor}</span>
            <span className="block text-ink">{r.note}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function Candidate({ c, chosen }: { c: RankedCandidate; chosen: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <li className={cn('rounded-md border px-3 py-2', chosen ? 'border-accent/60 bg-accent/[0.05]' : c.eligible ? 'border-line' : 'border-line opacity-80')}>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex w-full items-center gap-2 text-left">
        <HolderIcon type={c.workerType} className="text-ink-muted" />
        <span className="min-w-0 flex-1 truncate text-sm text-ink">{c.name}</span>
        {!c.eligible && (
          <Badge variant="outline" size="sm">
            Not eligible
          </Badge>
        )}
        <span className="text-xs2 tabular-nums text-ink-muted">{money(c.costCents)}</span>
        <span className="w-8 text-right text-sm font-semibold tabular-nums text-ink">{c.score}</span>
        <ChevronDown className={cn('h-4 w-4 text-ink-muted transition-transform', open && 'rotate-180')} aria-hidden="true" />
      </button>
      {open && (
        <div className="mt-2 border-t border-line pt-2">
          <ReasonList reasons={c.reasons} />
        </div>
      )}
    </li>
  );
}

function AssignmentCard({ a, title }: { a: WorkTaskAssignmentView; title: string }) {
  return (
    <section aria-label={title} className="rounded-lg border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-2 text-sm font-medium text-ink">
          <HolderIcon type={a.workerType} className="text-ink-muted" />
          {a.workerName}
        </span>
        <span className="text-xs2 text-ink-muted">
          {a.decidedBy === 'ENGINE' ? 'Assigned by the engine' : a.decidedBy === 'HANDOFF' ? 'Handed off' : 'Chosen by a person'} · score {a.score} · {money(a.costCents)}
        </span>
      </div>
      <div className="mt-3">
        <ReasonList reasons={a.reasons} />
      </div>
    </section>
  );
}

export function TaskDrawer({ taskId, onClose, onChanged, canManage }: { taskId: string; onClose: () => void; onChanged: () => void; canManage: boolean }) {
  const q = useQuery({ queryKey: ['tasks', 'detail', taskId], queryFn: () => getTask(taskId) });
  const t: WorkTaskDetailView | undefined = q.data;
  const [showRanking, setShowRanking] = useState(false);

  const act = useMutation({
    mutationFn: async (action: 'handoff' | 'auto' | 'STARTED' | 'STALLED' | 'FAILED' | 'DONE' | 'CANCELLED') => {
      if (action === 'handoff') return handOffTask(taskId);
      if (action === 'auto') return autoAssignTask(taskId);
      return recordTaskEvent(taskId, { kind: action });
    },
    onSuccess: (d, action) => {
      toast.success(action === 'handoff' ? 'Handed to a person.' : action === 'auto' ? 'The engine decided again.' : `Recorded: ${action.toLowerCase()}.`);
      for (const w of (d as { warnings?: string[] }).warnings ?? []) toast.warning(w);
      void q.refetch();
      onChanged();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'That did not go through.'),
  });

  const machineHolds = !!t?.assignment && t.assignment.workerType !== 'PERSON';
  const closed = t?.status === 'DONE' || t?.status === 'CANCELLED';

  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} width="max-w-2xl">
      <DrawerHeader>
        <DrawerTitle>{t ? t.type : 'Task'}</DrawerTitle>
        <DrawerDescription>
          {t ? (
            <>
              {t.locationName}
              {t.area ? ` · ${t.area}` : ''} · {CAP_LABEL.get(t.capability) ?? t.capability} · {WORK_TASK_RISK_LABELS[t.risk]} · {t.estimatedMinutes} min
              {t.reference ? ` · ${t.reference}` : ''}
            </>
          ) : (
            'Loading…'
          )}
        </DrawerDescription>
      </DrawerHeader>
      <DrawerBody>
        {!t ? (
          <div className="space-y-3">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={t.status === 'STALLED' || t.status === 'FAILED' ? 'destructive' : t.status === 'DONE' ? 'success' : t.status === 'QUEUED' ? 'pending' : 'default'}>
                {WORK_TASK_STATUS_LABELS[t.status]}
              </Badge>
              {t.queuedReason && <span className="text-sm text-warning">{t.queuedReason}</span>}
            </div>

            {t.assignment ? (
              <AssignmentCard a={t.assignment} title="Current assignment" />
            ) : (
              <EmptyState icon={Hand} title="Nobody holds this task" description={t.queuedReason ?? 'The engine has not decided yet.'} />
            )}

            {t.assignment && t.assignment.ranking.length > 0 && (
              <section aria-label="Every candidate the engine weighed">
                <button type="button" onClick={() => setShowRanking((v) => !v)} aria-expanded={showRanking} className="flex items-center gap-1.5 text-sm text-accent hover:underline">
                  <ChevronDown className={cn('h-4 w-4 transition-transform', showRanking && 'rotate-180')} aria-hidden="true" />
                  {showRanking ? 'Hide' : 'Show'} the {t.assignment.ranking.length} candidates weighed
                </button>
                {showRanking && (
                  <ul className="mt-2 space-y-2">
                    {t.assignment.ranking.map((c) => (
                      <Candidate key={c.workerId} c={c} chosen={c.workerId === t.assignment!.workerId} />
                    ))}
                  </ul>
                )}
              </section>
            )}

            {t.history.length > 0 && (
              <section aria-label="Earlier assignments" className="space-y-2">
                <h3 className="text-xs2 uppercase tracking-[0.14em] text-ink-muted">Earlier</h3>
                {t.history.map((a) => (
                  <AssignmentCard key={a.id} a={a} title="Earlier assignment" />
                ))}
              </section>
            )}

            <section aria-label="Timeline">
              <h3 className="text-xs2 uppercase tracking-[0.14em] text-ink-muted">Timeline</h3>
              <ol className="mt-2 space-y-1.5">
                {t.events.map((e) => (
                  <li key={e.id} className="flex items-baseline gap-3 text-sm">
                    <span className="w-36 shrink-0 text-xs2 tabular-nums text-ink-muted">{fmtDateTime(e.at)}</span>
                    <span className="text-ink">
                      {e.kind.replace('_', ' ').toLowerCase()}
                      {e.note ? <span className="text-ink-muted"> — {e.note}</span> : null}
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          </div>
        )}
      </DrawerBody>
      {canManage && t && !closed && (
        <DrawerFooter>
          <div className="flex flex-wrap items-center gap-2">
            {machineHolds && (
              <Button variant="secondary" size="sm" onClick={() => act.mutate('handoff')} loading={act.isPending}>
                <Hand className="h-4 w-4" /> Hand to a person
              </Button>
            )}
            {(t.status === 'QUEUED' || t.status === 'OPEN') && (
              <Button variant="secondary" size="sm" onClick={() => act.mutate('auto')} loading={act.isPending}>
                Ask the engine again
              </Button>
            )}
            {(t.status === 'ASSIGNED' || t.status === 'HANDED_OFF') && (
              <Button variant="ghost" size="sm" onClick={() => act.mutate('STARTED')} disabled={act.isPending}>
                <PlayCircle className="h-4 w-4" /> Started
              </Button>
            )}
            {t.status === 'IN_PROGRESS' && machineHolds && (
              <Button variant="ghost" size="sm" onClick={() => act.mutate('STALLED')} disabled={act.isPending}>
                Stalled
              </Button>
            )}
            {(t.status === 'IN_PROGRESS' || t.status === 'ASSIGNED' || t.status === 'HANDED_OFF') && (
              <Button variant="ghost" size="sm" onClick={() => act.mutate('FAILED')} disabled={act.isPending}>
                <X className="h-4 w-4" /> Failed
              </Button>
            )}
            {t.assignment && (
              <Button size="sm" onClick={() => act.mutate('DONE')} disabled={act.isPending}>
                <Check className="h-4 w-4" /> Done
              </Button>
            )}
            <Button variant="ghost" size="sm" className="ml-auto text-alert" onClick={() => act.mutate('CANCELLED')} disabled={act.isPending}>
              Cancel task
            </Button>
          </div>
        </DrawerFooter>
      )}
    </Drawer>
  );
}
