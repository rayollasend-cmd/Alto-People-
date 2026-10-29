import { Link } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { QueryError } from '@/components/ui/QueryError';
import { fmtMonth } from '@/lib/format';
import { useTenant } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import '@/lib/i18n/en/execPortal';
import { useLegacyBriefing } from '../ops/execLegacyApi';

/**
 * Seasonal capacity: can the company say yes to growth, and when does
 * the seasonal workforce roll off? People hired and ready to place, the
 * onboarding funnel, and — for a company with J-1 programs — the months
 * their visa documents run out over the next 120 days. A month's bar is
 * amber for any count and red once it is a quarter of the J-1 workforce.
 */
const CELL = 'rounded-md border border-line-subtle p-3';

export function SeasonalCapacityCard() {
  const { t } = useI18n();
  const programs = useTenant().moduleOn('programs');
  const q = useLegacyBriefing();
  const cap = q.data?.capacity ?? null;
  return (
    <Card data-testid="exec-seasonal-capacity">
      <CardContent className="space-y-4 p-4 md:p-5">
        {q.isError && !cap ? (
          <QueryError what={t('execPortal.risk.capWhat')} query={q} />
        ) : !cap ? (
          <Skeleton className="h-24" />
        ) : (
          <>
            <div className={programs ? 'grid grid-cols-1 gap-2 sm:grid-cols-3' : 'grid grid-cols-1 gap-2 sm:grid-cols-2'}>
              <Link to="/people?workStatus=NOT_PLACED" className={`${CELL} block hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent`}>
                <div className="text-2xl font-medium tabular-nums text-ink">{cap.bench}</div>
                <div className="text-xs2 text-ink-muted">{t('execPortal.risk.capBench')}</div>
              </Link>
              <Link to="/onboarding" className={`${CELL} block hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent`}>
                <div className="text-2xl font-medium tabular-nums text-ink">{cap.funnel.inFlight}</div>
                <div className="text-xs2 text-ink-muted">{t('execPortal.risk.capFunnel', { approved: cap.funnel.approved30d })}</div>
              </Link>
              {programs && (
                <div className={CELL}>
                  <div className="text-2xl font-medium tabular-nums text-ink">{cap.j1Active}</div>
                  <div className="text-xs2 text-ink-muted">{t('execPortal.risk.capJ1')}</div>
                </div>
              )}
            </div>
            {programs &&
              (cap.j1Cliff.length > 0 ? (
                <div>
                  <h3 className="mb-2 text-2xs font-semibold uppercase tracking-[0.18em] text-ink-muted">{t('execPortal.risk.capCliffTitle')}</h3>
                  <ul className="space-y-1.5">
                    {cap.j1Cliff.map((m) => {
                      const max = Math.max(...cap.j1Cliff.map((x) => x.count));
                      const heavy = m.count >= Math.max(3, cap.j1Active * 0.25);
                      return (
                        <li key={m.month} className="flex items-center gap-2 text-xs">
                          <span className="w-16 shrink-0 tabular-nums text-ink-muted">{fmtMonth(m.month)}</span>
                          <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-neutral-100">
                            <div className={`h-full rounded-full ${heavy ? 'bg-negative-700' : 'bg-caution-700'}`} style={{ width: `${(m.count / max) * 100}%` }} />
                          </div>
                          <span className="w-6 shrink-0 text-right tabular-nums text-ink">{m.count}</span>
                        </li>
                      );
                    })}
                  </ul>
                  <p className="mt-2 text-xs2 text-ink-muted">{t('execPortal.risk.capCliffHint')}</p>
                </div>
              ) : (
                <p className="text-sm text-ink-muted">{t('execPortal.risk.capCliffNone')}</p>
              ))}
          </>
        )}
      </CardContent>
    </Card>
  );
}
