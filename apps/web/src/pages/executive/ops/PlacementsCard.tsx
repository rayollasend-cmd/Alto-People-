import { Link } from 'react-router-dom';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryError } from '@/components/ui/QueryError';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { useI18n } from '@/lib/i18n';
import '@/lib/i18n/en/execPortal';
import type { LegacySummary } from './execLegacyApi';
import { PulseCard } from './opsShared';

/**
 * Client placements: how many working people each client has, the
 * largest first, on one neutral bar each — a placement count is a fact,
 * not a status. Each client opens its record.
 */
export function PlacementsCard({ summary }: { summary: { data: LegacySummary | undefined; isError: boolean; error: unknown; refetch: () => unknown; isFetching?: boolean } }) {
  const { t } = useI18n();
  const s = summary.data ?? null;
  const clients = s ? [...s.clients].sort((a, b) => b.activeAssociates - a.activeAssociates) : [];
  const max = Math.max(1, ...clients.map((c) => c.activeAssociates));
  const total = clients.reduce((n, c) => n + c.activeAssociates, 0);
  return (
    <PulseCard
      title={t('execPortal.ops.placeTitle')}
      description={s && clients.length > 0 ? t('execPortal.ops.placeDesc', { total, count: clients.length }) : undefined}
      link={{ to: '/executive/clients', label: t('execPortal.ops.placeLink') }}
      testId="exec-ops-placements"
    >
      {summary.isError && !s ? (
        <QueryError what={t('execPortal.ops.placeWhat')} query={summary} />
      ) : !s ? (
        <SkeletonRows count={3} rowHeight="h-8" />
      ) : clients.length === 0 ? (
        <EmptyState size="sm" title={t('execPortal.ops.placeNone')} description={t('execPortal.ops.placeNoneBody')} />
      ) : (
        <ul className="space-y-3">
          {clients.slice(0, 6).map((c) => (
            <li key={c.clientId}>
              <div className="flex items-center justify-between gap-3 text-sm">
                <Link to={`/clients/${c.clientId}`} className="min-w-0 truncate text-ink hover:text-accent">
                  {c.clientName}
                </Link>
                <span className="shrink-0 tabular-nums text-ink-muted">{t('execPortal.ops.placed', { count: c.activeAssociates })}</span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-neutral-100">
                <div className="h-full rounded-full bg-neutral-500" style={{ width: `${Math.round((c.activeAssociates / max) * 100)}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </PulseCard>
  );
}
