import { useQuery } from '@tanstack/react-query';
import { QueryError } from '@/components/ui/QueryError';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { cn } from '@/lib/cn';
import { getOpsBoard, getOpsScorecard } from '@/lib/opsApi';
import { useI18n } from '@/lib/i18n';
import '@/lib/i18n/en/execPortal';
import { PulseCard } from './opsShared';

/**
 * Store operations, the last four weeks: are the {sites} doing the work to
 * standard? Standard-procedure shifts run, temperature checks out of range
 * (red only when there are any), shifts running right now — and the weakest
 * department by checklist completion when it is under 90%. Opens the ops
 * board.
 */
export function StoreOpsCard() {
  const { t } = useI18n();
  const q = useQuery({ queryKey: ['executive', 'legacy', 'ops-scorecard', 4], queryFn: () => getOpsScorecard(4), staleTime: 60_000 });
  const live = useQuery({ queryKey: ['executive', 'legacy', 'ops-board'], queryFn: () => getOpsBoard(), staleTime: 60_000 });
  const d = q.data ?? null;
  const running = live.data ? live.data.active.length : null;
  const worst = d ? [...d.rows].filter((r) => r.sopPct != null).sort((a, b) => (a.sopPct ?? 0) - (b.sopPct ?? 0))[0] : undefined;
  return (
    <PulseCard
      title={t('execPortal.ops.storeTitle')}
      description={t('execPortal.ops.storeDesc')}
      link={{ to: '/ops?tab=board', label: t('execPortal.ops.storeLink') }}
      testId="exec-ops-store"
    >
      {q.isError && !d ? (
        <QueryError what={t('execPortal.ops.storeWhat')} query={q} />
      ) : !d ? (
        <Skeleton className="h-20" />
      ) : d.totals.shifts === 0 ? (
        <EmptyState size="sm" title={t('execPortal.ops.storeNone')} description={t('execPortal.ops.storeNoneBody')} />
      ) : (
        <>
          <dl className="grid grid-cols-3 gap-3">
            <div>
              <dt className="text-xs2 text-ink-muted">{t('execPortal.ops.storeShifts')}</dt>
              <dd className="text-2xl font-medium tabular-nums text-ink">{d.totals.shifts.toLocaleString('en-US')}</dd>
            </div>
            <div>
              <dt className="text-xs2 text-ink-muted">{t('execPortal.ops.storeTemps')}</dt>
              <dd className={cn('text-2xl font-medium tabular-nums', d.totals.tempOutOfRange > 0 ? 'text-negative-800' : 'text-ink')} data-tone={d.totals.tempOutOfRange > 0 ? 'negative' : 'none'}>
                {d.totals.tempOutOfRange.toLocaleString('en-US')}
              </dd>
              <dd className="text-2xs text-ink-muted">{t('execPortal.ops.storeTempChecks', { count: d.totals.tempChecks })}</dd>
            </div>
            <div>
              <dt className="text-xs2 text-ink-muted">{t('execPortal.ops.storeLive')}</dt>
              <dd className="text-2xl font-medium tabular-nums text-ink">{running === null ? '—' : running.toLocaleString('en-US')}</dd>
            </div>
          </dl>
          {d.totals.onTimeOf > 0 && <p className="text-sm text-ink-muted">{t('execPortal.ops.storeOnTime', { onTime: d.totals.onTime, of: d.totals.onTimeOf })}</p>}
          {worst && worst.sopPct != null && worst.sopPct < 90 && (
            <p className="text-sm text-caution-800">{t('execPortal.ops.storeWeakest', { client: worst.clientName, dept: worst.department, pct: worst.sopPct })}</p>
          )}
        </>
      )}
    </PulseCard>
  );
}
