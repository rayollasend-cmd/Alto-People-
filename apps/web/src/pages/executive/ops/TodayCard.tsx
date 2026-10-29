import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/Badge';
import { QueryError } from '@/components/ui/QueryError';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { cn } from '@/lib/cn';
import { fmtExecExact, fmtExecMoney } from '@/lib/executiveFormat';
import { fmtExecAsOf } from '@/lib/executiveFormat';
import { fmtDateOnly, fmtWeekday } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import '@/lib/i18n/en/execPortal';
import { useLegacyBriefing } from './execLegacyApi';
import { PulseCard, isAttendanceKind } from './opsShared';

/**
 * Today, as the chairman reads it at a quarter to seven: how much of
 * today's schedule is covered, which shifts are still open and how soon
 * they start, the next six days at a glance, and who did not show in the
 * last 24 hours. Coverage is green only when every shift is filled; an
 * open shift is amber; one that has started or starts within three hours
 * is red.
 */
const HEAD = 'text-2xs font-semibold uppercase tracking-[0.18em] text-ink-muted';

export function TodayCard({ billRates }: { billRates: boolean }) {
  const { t } = useI18n();
  const q = useLegacyBriefing();
  const b = q.data ?? null;
  const today = b?.today ?? null;
  return (
    <PulseCard title={t('execPortal.ops.todayTitle')} description={today ? fmtDateOnly(today.dateKey, { weekday: true, year: 'auto' }) : undefined} link={{ to: '/scheduling', label: t('execPortal.ops.openScheduling') }} testId="exec-ops-today">
      {q.isError && !b ? (
        <QueryError what={t('execPortal.ops.todayWhat')} query={q} />
      ) : !b || !today ? (
        <Skeleton className="h-48" />
      ) : (
        <div className="space-y-5">
          {today.shiftsTotal === 0 ? (
            <EmptyState size="sm" title={t('execPortal.ops.noShiftsToday')} description={t('execPortal.ops.noShiftsTodayBody')} />
          ) : (
            <div>
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <div className="font-display text-[2rem] leading-none tabular-nums text-ink" data-testid="exec-ops-coverage">
                    {Math.round((today.shiftsAssigned / today.shiftsTotal) * 100)}%
                  </div>
                  <div className="mt-1 text-xs2 text-ink-muted">
                    {t('execPortal.ops.covered', { assigned: today.shiftsAssigned, total: today.shiftsTotal })}
                    {today.shiftsOpen > 0 && <span className="font-medium text-caution-800"> · {t('execPortal.ops.openCount', { count: today.shiftsOpen })}</span>}
                  </div>
                </div>
                {billRates && (
                  <div className="text-right">
                    <div className="text-lg font-medium tabular-nums text-ink" title={fmtExecExact(today.estBilledToday, 'money')}>
                      {fmtExecMoney(today.estBilledToday)}
                    </div>
                    <div className="text-xs2 text-ink-muted">{t('execPortal.ops.estBilledToday')}</div>
                  </div>
                )}
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-neutral-100" role="img" aria-label={t('execPortal.ops.covered', { assigned: today.shiftsAssigned, total: today.shiftsTotal })}>
                <div className={cn('h-full rounded-full', today.shiftsOpen === 0 ? 'bg-positive-700' : 'bg-caution-700')} style={{ width: `${(today.shiftsAssigned / today.shiftsTotal) * 100}%` }} />
              </div>
            </div>
          )}

          {today.openShifts.length > 0 && (
            <ul className="divide-y divide-line" aria-label={t('execPortal.ops.openShiftsAria')}>
              {today.openShifts.map((s, i) => {
                const hoursOut = (new Date(s.startsAt).getTime() - Date.now()) / 3_600_000;
                const started = hoursOut < 0;
                const soon = !started && hoursOut < 3;
                return (
                  <li key={i}>
                    <Link to="/scheduling" className="flex min-h-11 items-center justify-between gap-3 py-1.5 text-sm hover:text-accent">
                      <span className="min-w-0 truncate text-ink">
                        {s.count > 1 && <span className="font-medium">{s.count} × </span>}
                        {s.position}
                        <span className="text-ink-muted"> · {s.locationName ?? s.clientName}</span>
                      </span>
                      {started ? (
                        <Badge variant="destructive" size="sm">{t('execPortal.ops.started')}</Badge>
                      ) : soon ? (
                        <Badge variant="destructive" size="sm">{t('execPortal.ops.inHours', { count: Math.max(1, Math.round(hoursOut)) })}</Badge>
                      ) : (
                        <span className="shrink-0 text-xs2 tabular-nums text-ink-muted">{fmtExecAsOf(s.startsAt, b.timezone)}</span>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}

          {b.outlook.length > 0 && (
            <div>
              <h3 className={HEAD}>{t('execPortal.ops.nextDays', { count: b.outlook.length })}</h3>
              <ul className="mt-2 grid grid-cols-6 gap-1.5">
                {b.outlook.map((d) => {
                  const pct = d.published > 0 ? Math.round((d.assigned / d.published) * 100) : null;
                  const day = fmtWeekday(`${d.dateKey}T12:00:00Z`);
                  const label =
                    pct === null
                      ? t('execPortal.ops.dayNone', { day: fmtDateOnly(d.dateKey, { weekday: true, year: false }) })
                      : t('execPortal.ops.dayCovered', { day: fmtDateOnly(d.dateKey, { weekday: true, year: false }), assigned: d.assigned, published: d.published, open: d.open });
                  return (
                    <li key={d.dateKey}>
                      <Link to="/scheduling" className="group block text-center" title={label} aria-label={label}>
                        <div className="flex h-10 items-end overflow-hidden rounded bg-neutral-100">
                          <div className={cn('w-full', pct === null ? '' : d.open > 0 ? 'bg-caution-700' : 'bg-neutral-500')} style={{ height: `${pct ?? 0}%` }} />
                        </div>
                        <div className="mt-1 text-2xs text-ink-muted group-hover:text-accent">{day}</div>
                        <div className={cn('text-2xs tabular-nums', d.open > 0 ? 'font-medium text-caution-800' : 'text-ink-muted')}>
                          {d.open > 0 ? t('execPortal.ops.dayOpen', { count: d.open }) : pct === null ? '—' : t('execPortal.ops.dayFull')}
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          <div>
            <h3 className={HEAD}>{t('execPortal.ops.last24')}</h3>
            {today.incidents.length === 0 ? (
              <p className="mt-1 text-sm text-ink-muted">{t('execPortal.ops.last24None')}</p>
            ) : (
              <>
                <p className="mt-1 text-sm text-ink">{t('execPortal.ops.last24Count', { count: today.incidents.length })}</p>
                <ul className="mt-1 divide-y divide-line">
                  {today.incidents.slice(0, 5).map((inc, i) => (
                    <li key={i} className="flex flex-col py-1.5 text-sm sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                      <span className="min-w-0 truncate text-ink">{inc.associateName}</span>
                      <span className="min-w-0 text-xs2 text-ink-muted sm:shrink-0">
                        {isAttendanceKind(inc.kind) ? t(`execPortal.ops.kind.${inc.kind}`) : t('execPortal.ops.kindOther')}
                        {inc.clientName ? ` · ${inc.clientName}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
                {today.incidents.length > 5 && (
                  <Link to="/compliance" className="mt-1 inline-block text-xs2 text-accent hover:underline">
                    {t('execPortal.ops.last24More', { count: today.incidents.length - 5 })}
                  </Link>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </PulseCard>
  );
}
