import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Circle, Banknote } from '@/components/ui/icons';
import { apiFetch } from '@/lib/api';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { fmtDate } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Card, CardContent } from '@/components/ui/Card';
import '@/lib/i18n/en/lane';

/**
 * "Road to your first paycheck" — the new hire's own view of their lane.
 * The same six stages the relay board tracks, in their language: no desk
 * names, no blame, just where they are and what's next. Every "where's
 * my check?" this answers is a case that never gets filed.
 */

type StageKey =
  | 'approved'
  | 'scheduled'
  | 'fieldglass'
  | 'firstShift'
  | 'hoursApproved'
  | 'paycheck';

interface LaneStage {
  key: StageKey;
  done: boolean;
  at: string | null;
  dueAt: string | null;
  overdue: boolean;
}

interface MyLane {
  stages: LaneStage[];
  currentStage: StageKey | null;
  completed: boolean;
  approvedAt: string;
}

const STAGE_KEY: Record<StageKey, MessageKey> = {
  approved: 'lane.approved',
  scheduled: 'lane.scheduled',
  fieldglass: 'lane.fieldglass',
  firstShift: 'lane.firstShift',
  hoursApproved: 'lane.hoursApproved',
  paycheck: 'lane.paycheck',
};

/** How long the "first paycheck has landed" moment stays on Home. */
export const LANE_KEPT_DAYS = 14;

/**
 * The lane shows while the road is being travelled, and for two weeks
 * after the first check lands — then it is done (ASSOC-18: it still sat
 * on Home four weeks after the check, with no end).
 */
export function laneShowing(lane: Pick<MyLane, 'completed' | 'stages'>, now: number = Date.now()): boolean {
  if (!lane.completed) return true;
  const paid = lane.stages.find((s) => s.key === 'paycheck')?.at ?? null;
  const landed = paid ? Date.parse(paid) : NaN;
  if (!Number.isFinite(landed)) return false;
  return now - landed < LANE_KEPT_DAYS * 86_400_000;
}

export function FirstPaycheckCard() {
  const { t } = useI18n();
  const query = useQuery({
    queryKey: ['me', 'first-paycheck'],
    queryFn: () => apiFetch<{ lane: MyLane | null }>('/me/first-paycheck'),
    staleTime: 5 * 60_000,
  });
  const lane = query.data?.lane;
  if (!lane || !laneShowing(lane)) return null;

  const current = lane.stages.find((s) => s.key === lane.currentStage) ?? null;

  return (
    <Card className="border-gold/30 animate-enter">
      <CardContent className="p-4">
        <h2 className="flex items-center gap-1.5 text-sm font-medium text-white">
          <Banknote className="h-4 w-4 text-gold" aria-hidden="true" />
          {t('lane.title')}
        </h2>
        {lane.completed ? (
          <p className="mt-2 flex items-center gap-1.5 text-sm text-success">
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            {t('lane.kept')}
          </p>
        ) : (
          <>
            <ol className="mt-3 space-y-1.5">
              {lane.stages.map((s) => {
                const isCurrent = s.key === lane.currentStage;
                return (
                  <li key={s.key} className="flex items-center gap-2 text-sm">
                    {s.done ? (
                      <CheckCircle2
                        className="h-4 w-4 shrink-0 text-success"
                        aria-hidden="true"
                      />
                    ) : (
                      <Circle
                        className={cn(
                          'h-4 w-4 shrink-0',
                          isCurrent ? 'text-gold' : 'text-silver/30',
                        )}
                        aria-hidden="true"
                      />
                    )}
                    <span
                      className={cn(
                        'flex-1',
                        s.done
                          ? 'text-silver'
                          : isCurrent
                            ? 'font-medium text-white'
                            : 'text-silver/50',
                      )}
                    >
                      {t(STAGE_KEY[s.key])}
                    </span>
                    {s.done && s.at && (
                      <span className="text-xs tabular-nums text-silver/50">
                        {fmtDate(s.at)}
                      </span>
                    )}
                    {isCurrent && (
                      <span className="text-xs text-gold">{t('lane.inProgress')}</span>
                    )}
                  </li>
                );
              })}
            </ol>
            {current?.dueAt && !current.overdue && (
              <p className="mt-2 text-xs text-silver/60 tabular-nums">
                {t('lane.expected', { date: fmtDate(current.dueAt) })}
              </p>
            )}
            {current?.overdue && (
              <p className="mt-2 text-xs text-silver/60">{t('lane.late')}</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
