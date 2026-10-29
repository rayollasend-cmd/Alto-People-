import { Link } from 'react-router-dom';
import type { ExecPeople } from '@alto-people/shared';
import { Avatar } from '@/components/ui/Avatar';
import { Card, CardContent } from '@/components/ui/Card';
import { fmtDateOnly } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import '@/lib/i18n/en/execPortal';

/**
 * The people behind the numbers, as a quiet close to the page: who has
 * started (only those whose first day has come), who carried the most
 * paid hours with a clean record, and whose work anniversary is coming.
 * Each name opens the person.
 */
const personHref = (id: string) => `/people?associateId=${id}`;
const HEAD = 'text-2xs font-semibold uppercase tracking-[0.18em] text-ink-muted';

export function PeopleBand({ data }: { data: Pick<ExecPeople, 'newHires' | 'topWorkers' | 'anniversaries'> }) {
  const { t } = useI18n();
  return (
    <Card data-testid="exec-people-band">
      <CardContent className="grid gap-6 p-4 md:grid-cols-3 md:p-5">
        <div className="min-w-0">
          <h3 className={HEAD}>{t('execPortal.people.newTitle')}</h3>
          {data.newHires.length === 0 ? (
            <p className="mt-2 text-sm text-ink-muted">{t('execPortal.people.newNone')}</p>
          ) : (
            <ul className="mt-3 flex flex-wrap gap-3">
              {data.newHires.slice(0, 8).map((h) => (
                <li key={h.id} className="w-[4.5rem] text-center">
                  <Link to={personHref(h.id)} className="group block rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" title={h.name}>
                    <Avatar src={h.photoUrl} name={h.name} size="md" className="mx-auto" />
                    <div className="mt-1 truncate text-xs text-ink group-hover:text-accent">{h.name.split(' ')[0]}</div>
                    <div className="text-2xs text-ink-muted">{fmtDateOnly(h.hireDate, { year: 'auto' })}</div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="min-w-0">
          <h3 className={HEAD}>{t('execPortal.people.topTitle')}</h3>
          {data.topWorkers.length === 0 ? (
            <p className="mt-2 text-sm text-ink-muted">{t('execPortal.people.topNone')}</p>
          ) : (
            <ol className="mt-2 divide-y divide-line">
              {data.topWorkers.slice(0, 5).map((p) => (
                <li key={p.id}>
                  <Link to={personHref(p.id)} className="flex min-h-11 items-center gap-3 py-1.5 text-sm hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                    <Avatar src={p.photoUrl} name={p.name} size="sm" />
                    <span className="min-w-0 flex-1 truncate text-ink">{p.name}</span>
                    <span className="shrink-0 tabular-nums text-ink-muted">{t('execPortal.people.hours', { hours: Math.round(p.hours).toLocaleString('en-US') })}</span>
                  </Link>
                </li>
              ))}
            </ol>
          )}
          <p className="mt-1 text-2xs text-ink-muted">{t('execPortal.people.topDef')}</p>
        </div>
        <div className="min-w-0">
          <h3 className={HEAD}>{t('execPortal.people.annivTitle')}</h3>
          {data.anniversaries.length === 0 ? (
            <p className="mt-2 text-sm text-ink-muted">{t('execPortal.people.annivNone')}</p>
          ) : (
            <ul className="mt-2 divide-y divide-line">
              {data.anniversaries.slice(0, 5).map((p) => (
                <li key={p.id}>
                  <Link to={personHref(p.id)} className="flex min-h-11 items-center gap-3 py-1.5 text-sm hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                    <span className="min-w-0 flex-1 truncate text-ink">{p.name}</span>
                    <span className="shrink-0 tabular-nums text-ink-muted">
                      {t('execPortal.people.annivYears', { count: p.years })} · {fmtDateOnly(p.date, { year: 'auto' })}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
