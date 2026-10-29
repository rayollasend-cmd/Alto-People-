import { Link } from 'react-router-dom';
import type { ExecWorkforceCounts } from '@alto-people/shared';
import { Card, CardContent } from '@/components/ui/Card';
import { PALETTE } from '@/components/ui/charts';
import { useI18n } from '@/lib/i18n';
import '@/lib/i18n/en/people';
import '@/lib/i18n/en/execPortal';

/**
 * Where everyone stands, in the People directory's own words (one status
 * per person, packages/shared/src/peopleStatus.ts): On the books is the
 * headline, then its parts — Working, No recent shifts, Not placed, Paused
 * — and Onboarding beside it, not hired yet. Every figure opens the people
 * it counts. Counts are ink: a count is not a status.
 */
export function WorkforceCounts({ counts }: { counts: ExecWorkforceCounts }) {
  const { t } = useI18n();
  const parts = [
    { key: 'active', label: t('people.ws.ACTIVE'), def: t('execPortal.people.def.active'), value: counts.active, href: '/people?workStatus=ACTIVE', color: PALETTE.series[0] },
    { key: 'placedNotActive', label: t('people.ws.PLACED_NOT_ACTIVE'), def: t('execPortal.people.def.placedNotActive'), value: counts.placedNotActive, href: '/people?workStatus=PLACED_NOT_ACTIVE', color: PALETTE.series[1] },
    { key: 'notPlaced', label: t('people.ws.NOT_PLACED'), def: t('people.wsDef.NOT_PLACED'), value: counts.notPlaced, href: '/people?workStatus=NOT_PLACED', color: PALETTE.series[2] },
    { key: 'deactivated', label: t('people.ws.DEACTIVATED'), def: t('people.wsDef.DEACTIVATED'), value: counts.deactivated, href: '/people?workStatus=DEACTIVATED', color: PALETTE.series[3] },
  ];
  const books = counts.onTheBooks;
  const share = (n: number) => (books > 0 ? Math.round((n / books) * 100) : null);
  return (
    <Card data-testid="exec-workforce-counts">
      <CardContent className="space-y-4 p-4 md:p-5">
        <ul className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-3 lg:grid-cols-6">
          <li>
            <Link to="/people" title={t('people.onTheBooksDef')} className="group block rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
              <div className="text-2xs font-semibold uppercase tracking-[0.18em] text-ink-muted">{t('people.onTheBooks')}</div>
              <div className="mt-1 font-display text-[1.75rem] leading-none tabular-nums text-ink group-hover:text-accent">{books.toLocaleString('en-US')}</div>
              <div className="mt-1 text-xs2 text-ink-muted">{t('execPortal.people.countsBooksSub')}</div>
            </Link>
          </li>
          {parts.map((p) => {
            const pct = share(p.value);
            return (
              <li key={p.key}>
                <Link to={p.href} title={p.def} className="group block rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                  <div className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.18em] text-ink-muted">
                    <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: p.color }} aria-hidden="true" />
                    <span className="truncate">{p.label}</span>
                  </div>
                  <div className="mt-1 text-2xl font-medium leading-none tabular-nums text-ink group-hover:text-accent">{p.value.toLocaleString('en-US')}</div>
                  <div className="mt-1 text-xs2 text-ink-muted">{pct === null ? '—' : t('execPortal.people.countsShare', { pct })}</div>
                </Link>
              </li>
            );
          })}
          <li>
            <Link to="/people?workStatus=ONBOARDING" title={t('people.wsDef.ONBOARDING')} className="group block rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
              <div className="text-2xs font-semibold uppercase tracking-[0.18em] text-ink-muted">{t('people.ws.ONBOARDING')}</div>
              <div className="mt-1 text-2xl font-medium leading-none tabular-nums text-ink group-hover:text-accent">{counts.onboarding.toLocaleString('en-US')}</div>
              <div className="mt-1 text-xs2 text-ink-muted">{t('execPortal.people.countsOnboardingSub')}</div>
            </Link>
          </li>
        </ul>
        {books > 0 && (
          <div className="flex h-2 w-full overflow-hidden rounded-full bg-neutral-100" role="img" aria-label={t('execPortal.people.countsBarAria', { books, working: counts.active })}>
            {parts
              .filter((p) => p.value > 0)
              .map((p) => (
                <span key={p.key} className="h-full border-r-2 border-surface last:border-r-0" style={{ width: `${(p.value / books) * 100}%`, background: p.color }} title={`${p.label}: ${p.value}`} />
              ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
