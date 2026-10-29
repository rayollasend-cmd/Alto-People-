import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { ChevronDown } from '@/components/ui/icons';
import { DecisionRoom } from '@/components/DecisionRoom';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryError } from '@/components/ui/QueryError';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { ExecSection } from '@/components/executive/ExecPage';
import { ApiError, apiFetch } from '@/lib/api';
import { cn } from '@/lib/cn';
import { fmtExecExact, fmtExecMoney } from '@/lib/executiveFormat';
import { useI18n } from '@/lib/i18n';
import '@/lib/i18n/en/execPortal';

/**
 * The chairman's decisions (2026-10-27, from the old home's queue): ranked
 * by what is at stake, each workable in place — delegate it to the team,
 * snooze it a week, or dismiss it — with delegated items held in view
 * until their condition resolves. The top three show; the rest are one
 * tap away, so the home stays a page and not a queue.
 */
export interface ExecDecision {
  key: string;
  category: 'run' | 'develop' | 'move';
  severity: 'critical' | 'high' | 'normal';
  label: string;
  detail: string;
  stakes: number | null;
  ageDays: number | null;
  linkUrl: string;
  status: 'open' | 'delegated';
  delegatedDays: number | null;
  claimedBy: { id: string; name: string; photoUrl: string | null } | null;
}

/** The queue rides on the morning briefing (GET /executive/briefing). */
export const briefingKey = ['ExecutiveDashboard', 'briefing'] as const;

const TOP = 3;

const SEVERITY_EDGE: Record<ExecDecision['severity'], string> = {
  critical: 'border-negative-700',
  high: 'border-caution-700',
  normal: 'border-line',
};

type Action = 'dismiss' | 'snooze' | 'delegate';

/** The section: its title, the count in words, and the card. */
export function DecisionsForYou() {
  const { t } = useI18n();
  const q = useQuery({
    queryKey: briefingKey,
    queryFn: () => apiFetch<{ decisions: ExecDecision[] }>('/executive/briefing'),
    staleTime: 60_000,
  });
  const decisions = q.data?.decisions;
  const open = decisions?.filter((d) => d.status === 'open').length ?? 0;
  const team = decisions?.filter((d) => d.status === 'delegated').length ?? 0;
  const description = !decisions
    ? undefined
    : open + team === 0
      ? t('execPortal.home.decisionsNone')
      : [open > 0 ? t('execPortal.home.decisionsOpen', { count: open }) : null, team > 0 ? t('execPortal.home.decisionsWithTeam', { count: team }) : null]
          .filter(Boolean)
          .join(' · ');
  return (
    <ExecSection id="exec-home-decisions" title={t('execPortal.home.decisionsTitle')} description={description}>
      {decisions ? (
        <DecisionQueueCard decisions={decisions} onChanged={() => void q.refetch()} />
      ) : q.isError ? (
        <QueryError what={t('execPortal.home.decisionsWhat')} query={q} />
      ) : (
        <Card animate={false}>
          <CardContent className="p-4">
            <SkeletonRows count={3} rowHeight="h-14" />
          </CardContent>
        </Card>
      )}
    </ExecSection>
  );
}

export function DecisionQueueCard({ decisions, onChanged }: { decisions: ExecDecision[]; onChanged: () => void }) {
  const { t } = useI18n();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [roomKey, setRoomKey] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const open = decisions.filter((d) => d.status === 'open');
  const delegated = decisions.filter((d) => d.status === 'delegated');
  const shown = all ? open : open.slice(0, TOP);

  const act = async (key: string, action: Action) => {
    if (busyKey) return;
    setBusyKey(`${key}:${action}`);
    try {
      await apiFetch('/executive/decisions/action', { method: 'POST', body: { key, action } });
      toast.success(t(`execPortal.home.decisionDone.${action}`));
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError && err.status < 500 && err.message.trim() ? err.message : t('execPortal.home.decisionFailed'));
    } finally {
      setBusyKey(null);
    }
  };

  if (open.length === 0 && delegated.length === 0) {
    return (
      <Card animate={false}>
        <CardContent className="p-4">
          <EmptyState size="sm" title={t('execPortal.home.decisionsClear')} description={t('execPortal.home.decisionsClearBody')} />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card animate={false} data-testid="exec-decisions">
      <CardContent className="space-y-3 p-4">
        {open.length > 0 && (
          <ul role="list" className="space-y-2.5">
            {shown.map((d) => (
              <li key={d.key} className={cn('rounded-md border-l-2 bg-neutral-50 px-3 py-2.5', SEVERITY_EDGE[d.severity])} data-testid="exec-decision">
                {/* The label opens the item's room — its thread and timeline. */}
                <button
                  type="button"
                  onClick={() => setRoomKey(d.key)}
                  className="group block w-full rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
                    <span className="text-sm font-medium text-ink group-hover:text-accent">{d.label}</span>
                    <span className="flex items-center gap-1.5 text-xs2 tabular-nums text-ink-muted">
                      {d.stakes !== null && d.stakes > 0 && (
                        <span className={d.severity === 'critical' ? 'font-medium text-negative-800' : undefined} title={fmtExecExact(d.stakes, 'money')}>
                          {t('execPortal.home.decisionStakes', { amount: fmtExecMoney(d.stakes) })}
                        </span>
                      )}
                      {d.ageDays !== null && d.ageDays > 0 && <span>· {t('execPortal.home.decisionWaiting', { count: d.ageDays })}</span>}
                      <Badge size="sm" className="border-neutral-200 bg-neutral-100 text-neutral-800">
                        {t(`execPortal.home.decisionCategory.${d.category}`)}
                      </Badge>
                    </span>
                  </div>
                  <div className="mt-0.5 text-xs text-ink-muted">{d.detail}</div>
                  {d.claimedBy && (
                    <div className="mt-1 flex items-center gap-1.5 text-xs2 text-ink-muted">
                      <Avatar src={d.claimedBy.photoUrl} name={d.claimedBy.name} size="xs" />
                      {t('execPortal.home.decisionClaimed', { name: d.claimedBy.name })}
                    </div>
                  )}
                </button>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {(['delegate', 'snooze', 'dismiss'] as const).map((action) => (
                    <Button
                      key={action}
                      size="xs"
                      variant="ghost"
                      loading={busyKey === `${d.key}:${action}`}
                      disabled={busyKey !== null}
                      onClick={() => void act(d.key, action)}
                      title={action === 'delegate' ? t('execPortal.home.decisionDelegateTitle') : undefined}
                    >
                      {t(`execPortal.home.decisionAction.${action}`)}
                    </Button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
        {open.length > TOP && (
          <Button size="sm" variant="ghost" onClick={() => setAll((v) => !v)} aria-expanded={all} className="w-full">
            {all ? t('execPortal.home.decisionsFewer') : t('execPortal.home.decisionsSeeAll', { count: open.length })}
            <ChevronDown className={cn('h-4 w-4 transition-transform', all && 'rotate-180')} aria-hidden="true" />
          </Button>
        )}
        {delegated.length > 0 && (
          <div>
            <div className="mb-1 text-2xs font-semibold uppercase tracking-[0.14em] text-ink-muted">{t('execPortal.home.decisionsTeamHeading')}</div>
            <ul role="list" className="space-y-1">
              {delegated.map((d) => (
                <li key={d.key} className="flex items-center justify-between gap-2 text-xs">
                  <Link to={d.linkUrl} className="min-w-0 truncate rounded text-ink hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent coarse:py-3">
                    {d.label}
                  </Link>
                  <span className="shrink-0 tabular-nums text-ink-muted">
                    {d.delegatedDays !== null && d.delegatedDays > 0
                      ? t('execPortal.home.decisionDelegatedAgo', { count: d.delegatedDays })
                      : t('execPortal.home.decisionDelegatedToday')}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <DecisionRoom itemKey={roomKey} onClose={() => setRoomKey(null)} />
      </CardContent>
    </Card>
  );
}
