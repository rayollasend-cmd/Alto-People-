import { useQuery } from '@tanstack/react-query';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryError } from '@/components/ui/QueryError';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';
import { fmtExecAsOf } from '@/lib/executiveFormat';
import { useI18n } from '@/lib/i18n';
import { floorNow } from '@/lib/schedulingApi';
import '@/lib/i18n/en/execPortal';
import { useLegacyBriefing } from './execLegacyApi';
import { PulseCard } from './opsShared';

/**
 * The live floor: who is clocked in at each site against what the site
 * expects at this hour (its shift window, else its floor target). A site
 * short of its number is amber; one at or above it is green. Refreshes
 * every two minutes, and says when it last did.
 */
export function LiveFloorCard({ showClient }: { showClient: boolean }) {
  const { t } = useI18n();
  const q = useQuery({ queryKey: ['executive', 'legacy', 'floor-now'], queryFn: () => floorNow(), refetchInterval: 120_000, staleTime: 60_000 });
  // The pulse's clock: the company's, from the briefing the page already reads.
  const tz = useLegacyBriefing().data?.timezone;
  const rows = q.data?.rows ?? null;
  const onFloor = rows ? rows.reduce((n, r) => n + r.clockedIn, 0) : 0;
  const expected = rows ? rows.reduce((n, r) => n + (r.expected ?? r.totalTarget ?? 0), 0) : 0;
  return (
    <PulseCard
      title={t('execPortal.ops.floorTitle')}
      description={q.data ? t('execPortal.ops.floorDesc', { time: fmtExecAsOf(q.data.generatedAt, tz) }) : undefined}
      link={{ to: '/labor-costs', label: t('execPortal.ops.floorLink') }}
      testId="exec-ops-floor"
    >
      {q.isError && !rows ? (
        <QueryError what={t('execPortal.ops.floorWhat')} query={q} />
      ) : !rows ? (
        <SkeletonRows count={4} rowHeight="h-8" />
      ) : rows.length === 0 ? (
        <EmptyState size="sm" title={t('execPortal.ops.floorNone')} description={t('execPortal.ops.floorNoneBody')} />
      ) : (
        <>
          <div>
            <div className="font-display text-[2rem] leading-none tabular-nums text-ink">{onFloor.toLocaleString('en-US')}</div>
            <div className="mt-1 text-xs2 text-ink-muted">{expected > 0 ? t('execPortal.ops.floorOf', { expected, count: rows.length }) : t('execPortal.ops.floorSites', { count: rows.length })}</div>
          </div>
          <ul className="space-y-3">
            {[...rows]
              .sort((a, b) => b.clockedIn - a.clockedIn || a.locationName.localeCompare(b.locationName))
              .slice(0, 8)
              .map((r) => {
                const target = r.expected ?? r.totalTarget ?? null;
                const pct = target ? Math.min(100, Math.round((r.clockedIn / target) * 100)) : r.clockedIn > 0 ? 100 : 0;
                const short = target !== null && r.clockedIn < target;
                return (
                  <li key={r.locationId}>
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <span className="min-w-0 truncate text-ink">{showClient ? `${r.clientName} — ${r.locationName}` : r.locationName}</span>
                      <span className="shrink-0 tabular-nums text-ink-muted">
                        {target !== null ? t('execPortal.ops.floorRow', { in: r.clockedIn, target }) : r.clockedIn}
                        {r.windowLabel ? ` · ${r.windowLabel}` : ''}
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-neutral-100">
                      <div className={cn('h-full rounded-full', short ? 'bg-caution-700' : 'bg-positive-700')} style={{ width: `${pct}%` }} />
                    </div>
                  </li>
                );
              })}
          </ul>
        </>
      )}
    </PulseCard>
  );
}
