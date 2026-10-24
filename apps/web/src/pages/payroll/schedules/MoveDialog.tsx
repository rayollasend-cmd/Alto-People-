import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight } from '@/components/ui/icons';
import { becauseSentence, type MembershipImpact, type MoveInput, type PayScheduleSummary } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { applyMove, previewMove } from '@/lib/paySchedulesApi';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import { toast } from '@/components/ui/Toaster';
import { cn } from '@/lib/cn';
import { payDay, useChangeDate } from './scheduleKit';

/** "312 people · 18 move from Weekly · 4 new hires · 2 conflicts". */
export function impactLine(i: MembershipImpact): string {
  const parts = [`${i.joins} ${i.joins === 1 ? 'person' : 'people'} join`];
  for (const m of i.movingFrom) if (m.count > 0) parts.push(`${m.count} from ${m.name}`);
  if (i.leaves) parts.push(`${i.leaves} leave`);
  if (i.newHires) parts.push(`${i.newHires} new ${i.newHires === 1 ? 'hire' : 'hires'}`);
  if (i.unchanged) parts.push(`${i.unchanged} already on it`);
  if (i.conflicts) parts.push(`${i.conflicts} ${i.conflicts === 1 ? 'conflict' : 'conflicts'}`);
  return parts.join(' · ');
}

/** Every person who moves, from where, and the paychecks that bridge it. */
export function ImpactPeople({ impact, max = 200 }: { impact: MembershipImpact; max?: number }) {
  if (impact.people.length === 0) return <p className="text-sm text-ink-muted">Nobody moves.</p>;
  return (
    <ul className="divide-y divide-line rounded-lg border border-line">
      {impact.people.slice(0, max).map((p) => (
        <li key={p.associateId} className={cn('flex flex-wrap items-start gap-3 px-3 py-2.5', p.conflict && 'bg-alert/5')}>
          <Avatar src={p.photoUrl} name={p.name} size="sm" />
          <div className="min-w-0 flex-1 text-sm">
            <p className="flex flex-wrap items-center gap-1.5 text-ink">
              <span className="font-medium">{p.name}</span>
              <span className="inline-flex items-center gap-1 text-xs text-ink-muted">
                {p.fromScheduleName ?? 'No schedule'}
                <ArrowRight className="h-3 w-3" aria-label="to" />
                {p.toScheduleName ?? 'No schedule'}
              </span>
            </p>
            <p className="text-xs text-ink-muted">
              From {payDay(p.effectiveFrom, false)} · {becauseSentence(p.because, p.name.split(' ')[0])}
              {p.transition.lastOldPayDate && ` · last check on the old schedule ${payDay(p.transition.lastOldPayDate, false)}`}
              {p.transition.firstNewPayDate && ` · first on the new ${payDay(p.transition.firstNewPayDate, false)}`}
            </p>
            {p.transition.note && <p className="text-xs text-ink-muted">{p.transition.note}</p>}
            {p.conflict && (
              <p className="mt-0.5 flex items-center gap-1 text-xs text-alert">
                <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
                {p.conflict}
              </p>
            )}
          </div>
        </li>
      ))}
      {(impact.people.length > max || impact.truncated) && <li className="px-3 py-2 text-xs text-ink-muted">and more — the counts above are exact.</li>}
    </ul>
  );
}

/**
 * Moving people (or whole client groups) to another schedule: when it starts,
 * who moves from where, and the transition paychecks — then apply.
 */
export function MoveDialog({
  open,
  onOpenChange,
  input,
  target,
  title,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  input: Omit<MoveInput, 'effectiveFrom'> | null;
  target: PayScheduleSummary | null;
  title: string;
}) {
  const qc = useQueryClient();
  const first = useChangeDate(open ? target : null);
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => {
    if (open) setPicked(null);
  }, [open, target]);
  // The first period start until someone picks another day.
  const effectiveFrom = picked ?? first.date;
  const setEffectiveFrom = setPicked;
  const body: MoveInput | null = input && effectiveFrom ? { ...input, associateIds: input.associateIds ?? [], clientIds: input.clientIds ?? [], effectiveFrom } : null;
  const preview = useQuery({
    queryKey: ['paySchedules', 'movePreview', body],
    queryFn: () => previewMove(body!),
    enabled: open && !!body,
  });
  const apply = useMutation({
    mutationFn: () => applyMove(body!),
    onSuccess: (r) => {
      toast.success(`${r.impact.joins} ${r.impact.joins === 1 ? 'person moves' : 'people move'} to ${target?.name} from ${payDay(r.impact.effectiveFrom, false)}.`);
      void qc.invalidateQueries({ queryKey: ['paySchedules'] });
      onOpenChange(false);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not move them.'),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Nothing changes until the date you choose. Pay for days before it stays on their current schedule; days from it are paid on {target?.name ?? 'the new one'}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Field label="First day on the new schedule" hint={target && first.date ? `The start of ${target.name}’s next pay period is ${payDay(first.date)}.` : undefined}>
            {(p) => <Input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} {...p} />}
          </Field>
          {preview.isLoading ? (
            <Skeleton className="h-32" />
          ) : preview.isError ? (
            <p className="text-sm text-alert">{preview.error instanceof ApiError ? preview.error.message : 'Could not preview the move.'}</p>
          ) : preview.data ? (
            <>
              <p className="text-sm font-medium text-ink" aria-live="polite">
                {impactLine(preview.data)}
              </p>
              <div className="max-h-80 overflow-y-auto">
                <ImpactPeople impact={preview.data} />
              </div>
            </>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => apply.mutate()} loading={apply.isPending} disabled={!preview.data || apply.isPending || preview.data.joins + preview.data.leaves === 0}>
            Move {preview.data ? preview.data.joins : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
