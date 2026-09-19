import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowRight, Check, Circle, ExternalLink } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Drawer, DrawerBody, DrawerDescription, DrawerHeader, DrawerTitle } from '@/components/ui/Drawer';
import { Select } from '@/components/ui/Select';
import { WorkThreadPanel } from '@/components/WorkThreadPanel';
import { DeskChip, OwnerControl } from './RelayParts';
import { dueText } from './RelayPipeline';
import {
  STAGE_ACTION,
  STAGE_LABELS,
  claimKey,
  type Claim,
  type CohortSummary,
  type Desk,
  type DeskPerson,
  type Lane,
} from './relayTypes';

/**
 * One new hire, opened: where their first paycheck stands stage by stage
 * (done when, due when, whose desk), the one move that unsticks it, who
 * holds it — and the conversation about them, with desk @mentions and
 * rulings, right beside the work.
 */
export function LaneDrawer({
  associateId,
  name,
  lane,
  claims,
  desks,
  meId,
  cohorts,
  canManageCohorts,
  onClose,
  onChanged,
}: {
  associateId: string | null;
  /** When there's no lane (a thread about someone already paid). */
  name: string | null;
  lane: Lane | undefined;
  claims: Record<string, Claim>;
  desks: Record<Desk, DeskPerson[]> | undefined;
  meId: string | undefined;
  cohorts: CohortSummary[];
  canManageCohorts: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const who = lane?.name ?? name ?? 'Associate';
  const current = lane?.stages.find((s) => s.key === lane.currentStage) ?? null;
  const action = current ? STAGE_ACTION[current.key] : null;
  return (
    <Drawer open={!!associateId} onOpenChange={(o) => !o && onClose()} width="max-w-xl">
      {associateId && (
        <>
          <DrawerHeader>
            <div className="flex items-center gap-3">
              <Avatar src={`/api/associates/${associateId}/photo`} name={who} size="lg" />
              <div className="min-w-0">
                <DrawerTitle className="truncate">{who}</DrawerTitle>
                <DrawerDescription>
                  {lane
                    ? `${lane.clientName ?? 'No client yet'} · approved ${fmtDate(lane.approvedAt)}`
                    : 'Their thread on the relay'}
                </DrawerDescription>
              </div>
            </div>
          </DrawerHeader>
          <DrawerBody>
            <div className="space-y-5">
              <div className="flex flex-wrap items-center gap-2">
                {lane && (
                  <OwnerControl
                    subjectType="LANE"
                    subjectKey={associateId}
                    what={`${who}’s lane`}
                    claim={claims[claimKey('LANE', associateId)]}
                    desks={desks}
                    meId={meId}
                    onChanged={onChanged}
                  />
                )}
                <Link
                  to={`/people?associateId=${associateId}&return=${encodeURIComponent('/relay')}`}
                  className="ml-auto inline-flex items-center gap-1 text-xs text-gold underline underline-offset-2 hover:text-gold-bright"
                >
                  Full record
                  <ExternalLink className="h-3 w-3" aria-hidden="true" />
                </Link>
              </div>

              {lane && (
                <section aria-label="First-paycheck lane">
                  <h3 className="mb-2 text-2xs font-semibold uppercase tracking-wider text-silver/70">Road to the first paycheck</h3>
                  <ol className="relative space-y-3 border-l border-navy-secondary pl-5">
                    {lane.stages.map((s) => {
                      const now = s.key === lane.currentStage;
                      const due = now ? dueText(s.dueAt, s.overdue) : null;
                      return (
                        <li key={s.key} className="relative">
                          <span
                            className={cn(
                              'absolute -left-[1.72rem] top-0.5 grid h-5 w-5 place-items-center rounded-full border',
                              s.done
                                ? 'border-success/60 bg-success/20 text-success'
                                : now
                                  ? s.overdue
                                    ? 'border-alert bg-alert/20 text-alert'
                                    : 'border-gold bg-gold/20 text-gold'
                                  : 'border-navy-secondary bg-navy text-silver/40',
                            )}
                            aria-hidden="true"
                          >
                            {s.done ? <Check className="h-3 w-3" /> : <Circle className="h-1.5 w-1.5 fill-current" />}
                          </span>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className={cn('text-sm', s.done ? 'text-silver' : now ? 'font-semibold text-white' : 'text-silver/60')}>
                              {STAGE_LABELS[s.key]}
                            </span>
                            <DeskChip desk={s.desk} />
                            <span className={cn('ml-auto text-xs tabular-nums', s.overdue && now ? 'font-semibold text-alert' : 'text-silver/70')}>
                              {s.done && s.at ? fmtDate(s.at) : due ?? (s.dueAt ? `by ${fmtDate(s.dueAt)}` : '')}
                            </span>
                          </div>
                          {now && action && (
                            <Button asChild size="sm" variant={s.overdue ? 'primary' : 'secondary'} className="mt-2">
                              <Link to={action.to(associateId)}>
                                {action.label}
                                <ArrowRight className="h-3.5 w-3.5" />
                              </Link>
                            </Button>
                          )}
                        </li>
                      );
                    })}
                  </ol>
                </section>
              )}

              {lane && canManageCohorts && cohorts.length > 0 && (
                <label className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-silver">Wave</span>
                  <Select
                    size="sm"
                    className="w-56"
                    value={lane.cohortId ?? ''}
                    onChange={(e) => {
                      void apiFetch('/cohorts/assign', { method: 'POST', body: { associateId, cohortId: e.target.value || null } })
                        .then(() => {
                          onChanged();
                          toast.success('Wave updated.');
                        })
                        .catch(() => toast.error('Could not move the lane.'));
                    }}
                  >
                    <option value="">No wave</option>
                    {cohorts.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                </label>
              )}

              <section aria-label="The conversation">
                <h3 className="mb-2 text-2xs font-semibold uppercase tracking-wider text-silver/70">The conversation</h3>
                <WorkThreadPanel associateId={associateId} onChanged={onChanged} />
              </section>
            </div>
          </DrawerBody>
        </>
      )}
    </Drawer>
  );
}
