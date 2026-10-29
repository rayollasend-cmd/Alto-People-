import { Link } from 'react-router-dom';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryError } from '@/components/ui/QueryError';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { fmtDateOnlyRange, fmtRelativeDate } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import '@/lib/i18n/en/execPortal';
import { useLegacyPortalEngagement } from './execLegacyApi';
import { PulseCard } from './opsShared';

/**
 * Portal engagement: are the clients' managers using their portal? Each
 * account's last visit, its sign-ins this week and the latest report it
 * pulled. An account that has never signed in is the one to chase, said
 * in words (amber); everything else is ink.
 */
export function PortalEngagementCard() {
  const { t } = useI18n();
  const q = useLegacyPortalEngagement(true);
  const e = q.data ?? null;
  return (
    <PulseCard
      title={t('execPortal.ops.portalTitle')}
      description={
        e && e.totals.accounts > 0
          ? [
              t('execPortal.ops.portalActive', { active: e.totals.active7d, accounts: e.totals.accounts }),
              t('execPortal.ops.portalReports', { count: e.totals.downloads7d }),
              ...(e.totals.neverSignedIn > 0 ? [t('execPortal.ops.portalNever', { count: e.totals.neverSignedIn })] : []),
            ].join(' · ')
          : undefined
      }
      testId="exec-ops-portal"
    >
      {q.isError && !e ? (
        <QueryError what={t('execPortal.ops.portalWhat')} query={q} />
      ) : !e ? (
        <SkeletonRows count={2} rowHeight="h-10" />
      ) : e.accounts.length === 0 ? (
        <EmptyState size="sm" title={t('execPortal.ops.portalNone')} description={t('execPortal.ops.portalNoneBody')} />
      ) : (
        <ul className="divide-y divide-line">
          {e.accounts.map((a) => {
            const latest = a.downloads[0];
            return (
              <li key={a.id} className="space-y-0.5 py-2.5 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  {a.clientId ? (
                    <Link to={`/clients/${a.clientId}?section=portal`} className="min-w-0 truncate text-ink hover:text-accent">
                      {a.scope}
                    </Link>
                  ) : (
                    <span className="min-w-0 truncate text-ink">{a.scope}</span>
                  )}
                  <span className={a.lastSeenAt ? 'text-xs2 text-ink-muted' : 'text-xs2 font-medium text-caution-800'}>
                    {a.lastSeenAt ? t('execPortal.ops.portalSeen', { when: fmtRelativeDate(a.lastSeenAt) }) : a.status === 'INVITED' ? t('execPortal.ops.portalInvited') : t('execPortal.ops.portalNeverOne')}
                  </span>
                </div>
                <div className="break-words text-xs2 text-ink-muted">
                  {a.email} · {t('execPortal.ops.portalSignIns', { count: a.signIns7d })} ·{' '}
                  {latest ? t('execPortal.ops.portalLatest', { range: fmtDateOnlyRange(latest.from, latest.to), when: fmtRelativeDate(latest.at) }) : t('execPortal.ops.portalNoReports')}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </PulseCard>
  );
}
