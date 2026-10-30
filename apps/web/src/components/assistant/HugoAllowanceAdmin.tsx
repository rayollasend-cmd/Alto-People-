import { useQuery } from '@tanstack/react-query';
import type { HugoAdminUsage, HugoUsagePurpose } from '@alto-people/shared';
import { SettingsSection } from '@/components/templates';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { useAuth, useTerm } from '@/lib/auth';
import { ApiError } from '@/lib/api';
import { fmtMoney, fmtMonth } from '@/lib/format';
import { getHugo, getHugoAdminUsage } from '@/lib/hugoApi';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/cn';
import { fmtSpend } from './HugoAllowance';
import '@/lib/i18n/en/hugoAdmin';

/**
 * "Hugo's thinking time" (Settings & trust › Agents & gates): what the
 * assistant's thinking cost the organization this month — the total, the
 * floor and the office, what it was for, how many people have used their
 * own allowance up, and the twenty who used the most (GET /hugo/admin/usage,
 * manage:org, company-wide). Office staff only, in English and Spanish.
 */

const PURPOSES: readonly HugoUsagePurpose[] = ['chat', 'goal', 'recurring', 'whatsapp'];

/** The month as a reader says it ("November 2026"), on the company's month (it starts at midnight there). */
function monthOf(u: HugoAdminUsage): string {
  return fmtMonth(new Date(new Date(u.periodStart).getTime() + 12 * 3_600_000), 'long');
}

export function HugoAllowanceAdminSection() {
  const { t } = useI18n();
  const { can } = useAuth();
  const term = useTerm();
  const allowed = can('manage:org');
  const assistant = useQuery({ queryKey: ['hugo', 'me'], queryFn: () => getHugo(), staleTime: 5 * 60_000, retry: false, retryOnMount: false, enabled: allowed });
  const usage = useQuery({ queryKey: ['hugo', 'adminUsage'], queryFn: () => getHugoAdminUsage(), enabled: allowed, staleTime: 60_000, retry: false });
  if (!allowed) return null;
  // A narrowed account is refused (the spend names people company-wide): nothing to show it.
  if (usage.error instanceof ApiError && usage.error.status === 403) return null;
  const name = assistant.data?.name ?? 'Hugo';
  const u = usage.data;
  const description = t('hugoAdmin.description', {
    floor: fmtMoney(u?.capUsd.floor ?? 1),
    staff: fmtMoney(u?.capUsd.staff ?? 10),
    workers: term('workers').toLowerCase(),
  });
  const most = Math.max(0, ...PURPOSES.map((p) => u?.byPurpose[p] ?? 0));
  return (
    <SettingsSection
      id="thinking-time"
      title={t('hugoAdmin.title', { name })}
      description={description}
      status={
        u ? (
          <Badge variant="outline" size="sm" withDot={false}>
            {monthOf(u)}
          </Badge>
        ) : undefined
      }
    >
      <div className="space-y-4" data-testid="hugo-admin-usage">
        {usage.isLoading ? (
          <SkeletonRows count={3} />
        ) : usage.error || !u ? (
          <div className="flex flex-wrap items-center gap-3 text-sm text-ink-muted" role="alert">
            {t('hugoAdmin.loadFailed')}
            <Button size="sm" variant="outline" onClick={() => void usage.refetch()}>
              {t('hugoAdmin.retry')}
            </Button>
          </div>
        ) : (
          <>
            {!u.on && <p className="text-sm text-ink-muted">{t('hugoAdmin.off', { name })}</p>}
            <MetricStrip label={t('hugoAdmin.title', { name })}>
              <MetricCard label={t('hugoAdmin.total')} value={fmtSpend(u.totalUsd)} hint={`${t('hugoAdmin.floor')} ${fmtSpend(u.byClass.floor)} · ${t('hugoAdmin.office')} ${fmtSpend(u.byClass.staff)}`} compact />
              <MetricCard label={t('hugoAdmin.people')} value={u.people} compact />
              <MetricCard label={t('hugoAdmin.usedUp')} value={u.exhaustedPeople} hint={u.exhaustedPeople ? t('hugoAdmin.usedUpHint') : t('hugoAdmin.noneUsedUp')} tone={u.exhaustedPeople ? 'warning' : 'neutral'} compact />
            </MetricStrip>

            {/* Side by side when the card is wide enough — measured by the card, not the window (the panel can narrow the page). */}
            <div className="flex flex-wrap gap-x-6 gap-y-4">
              <section aria-labelledby="hugo-usage-purpose" className="min-w-0 grow basis-[16rem]">
                <h3 id="hugo-usage-purpose" className="mb-2 text-xs font-medium uppercase tracking-wider text-ink-muted">
                  {t('hugoAdmin.byPurpose')}
                </h3>
                <ul className="space-y-2 text-sm">
                  {PURPOSES.map((p) => {
                    const v = u.byPurpose[p] ?? 0;
                    return (
                      <li key={p}>
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="text-ink">{t(`hugoAdmin.purpose.${p}` as const)}</span>
                          <span className="tabular-nums text-ink-muted">{fmtSpend(v)}</span>
                        </div>
                        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-sunken" aria-hidden="true">
                          <div className="h-full rounded-full bg-accent-fill" style={{ width: `${most ? Math.round((v / most) * 100) : 0}%` }} />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>

              <section aria-labelledby="hugo-usage-top" className="min-w-0 grow-[2] basis-[26rem]">
                <h3 id="hugo-usage-top" className="mb-2 text-xs font-medium uppercase tracking-wider text-ink-muted">
                  {t('hugoAdmin.top')}
                </h3>
                {u.top.length === 0 ? (
                  <p className="text-sm text-ink-muted">{t('hugoAdmin.empty', { name })}</p>
                ) : (
                  <ol className="divide-y divide-line text-sm" aria-label={t('hugoAdmin.top')}>
                    <li className="hidden grid-cols-[minmax(0,1fr)_11rem_6rem] gap-3 pb-1.5 text-xs text-ink-muted sm:grid" aria-hidden="true">
                      <span>{t('hugoAdmin.col.person')}</span>
                      <span>{t('hugoAdmin.col.used')}</span>
                      <span className="text-right">{t('hugoAdmin.col.spent')}</span>
                    </li>
                    {u.top.map((p) => (
                      <li key={p.userId} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 py-2 sm:grid-cols-[minmax(0,1fr)_11rem_6rem]" data-testid="hugo-usage-person">
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-ink">{p.name}</span>
                          <span className="block truncate text-xs text-ink-muted">{p.role}</span>
                        </span>
                        <span className="order-last col-span-2 flex items-center gap-2 sm:order-none sm:col-span-1">
                          <span className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-sunken" aria-hidden="true">
                            <span className={cn('block h-full rounded-full', p.exhausted ? 'bg-caution' : 'bg-accent-fill')} style={{ width: `${p.usedPercent}%` }} />
                          </span>
                          <span className="tabular-nums text-xs text-ink-muted">
                            <span className="sr-only">{t('hugoAdmin.col.used')}: </span>
                            {p.usedPercent}%
                          </span>
                          {p.exhausted && (
                            <Badge variant="pending" size="sm" withDot={false}>
                              {t('hugoAdmin.usedUpBadge')}
                            </Badge>
                          )}
                        </span>
                        <span className="text-right tabular-nums text-ink">
                          <span className="sr-only">{t('hugoAdmin.col.spent')}: </span>
                          {fmtSpend(p.spentUsd)}
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            </div>
          </>
        )}
      </div>
    </SettingsSection>
  );
}
