import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Building2, CalendarDays, ShieldCheck, Users } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useI18n, type MessageKey } from '@/lib/i18n';
import {
  fmtDate,
  fmtHours,
  fmtMoney,
  fmtShiftRangeTz,
  parseYmd,
} from '@/lib/format';
import { cn } from '@/lib/cn';
import { enterStagger } from '@/lib/motion';
import { PageHeader } from '@/components/ui/PageHeader';
import { Card, CardContent } from '@/components/ui/Card';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { PortalRequests } from './PortalRequests';

/**
 * The client portal home — "the Walmart view." The store manager's
 * morning glance: who is on the floor RIGHT NOW (hero), today's roster
 * with faces, the week's fill, tomorrow's confirmed headcount, coverage
 * incidents, and statements with payment status. Read-only, one client,
 * refreshed every minute.
 *
 * Admins with view:executive / manage:org preview any client via
 * ?clientId= — the pitch-demo path ("your store gets this dashboard").
 */

interface PortalOverview {
  client: { id: string; name: string };
  generatedAt: string;
  now: {
    onFloor: Array<{
      associateId: string;
      name: string;
      position: string | null;
      clockInAt: string;
    }>;
    scheduledNow: number;
  };
  today: {
    date: string;
    roster: Array<{
      shiftId: string;
      associateId: string | null;
      name: string | null;
      position: string;
      startsAt: string;
      endsAt: string;
      timezone: string;
      locationName: string | null;
      state: 'open' | 'on-floor' | 'done' | 'confirmed' | 'unconfirmed';
    }>;
    filled: number;
    open: number;
  };
  week: {
    start: string;
    end: string;
    days: Array<{ date: string; filled: number; open: number }>;
    filled: number;
    open: number;
    fillRatePct: number | null;
    hours: number;
  };
  tomorrow: { confirmed: number; unconfirmed: number; open: number };
  statements: Array<{
    id: string;
    number: number | null;
    periodStart: string;
    periodEnd: string;
    amount: number | null;
    hours: number | null;
    finalizedAt: string | null;
    paidAt: string | null;
  }>;
  coverage: {
    weekStart: string;
    noCallNoShows: number;
    callOuts: number;
    lates: number;
    replacementsFound: number;
  };
}

const photoUrl = (associateId: string) => `/api/associates/${associateId}/photo`;

const STATE_STYLE: Record<
  PortalOverview['today']['roster'][number]['state'],
  string
> = {
  'on-floor': 'text-success',
  confirmed: 'text-silver',
  unconfirmed: 'text-warning',
  done: 'text-silver/60',
  open: 'text-alert',
};

export function ClientPortalHome() {
  const { t } = useI18n();
  const { user, can } = useAuth();
  const [searchParams] = useSearchParams();
  const isPortal = user?.role === 'CLIENT_PORTAL';
  const canPreview = can('view:executive') || can('manage:org');
  const previewId = searchParams.get('clientId');

  const enabled = isPortal || (canPreview && !!previewId);
  const query = useQuery({
    queryKey: ['clientPortal', 'overview', isPortal ? 'me' : previewId],
    queryFn: () =>
      apiFetch<PortalOverview>(
        `/client-portal/overview${!isPortal && previewId ? `?clientId=${previewId}` : ''}`,
      ),
    enabled,
    refetchInterval: 60_000,
  });

  if (!isPortal && !canPreview) {
    return (
      <EmptyState icon={Building2} title={t('portal.noAccess')} description="" />
    );
  }
  if (!isPortal && !previewId) {
    return (
      <EmptyState icon={Building2} title={t('portal.title')} description={t('portal.pickClient')} />
    );
  }

  const data = query.data;

  if (query.isError) {
    return (
      <div className="mx-auto">
        <PageHeader title={t('portal.title')} subtitle={t('portal.subtitle')} />
        <ErrorBanner
          action={
            <Button size="sm" variant="secondary" onClick={() => void query.refetch()}>
              {t('common.retry')}
            </Button>
          }
        >
          {t('portal.loadFailed')}
        </ErrorBanner>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-1/3" />
        <Skeleton className="h-40" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  const onFloor = data.now.onFloor;
  const coverageParts = [
    part(t, data.coverage.noCallNoShows, 'portal.covNoShowOne', 'portal.covNoShow'),
    part(t, data.coverage.callOuts, 'portal.covCallOutOne', 'portal.covCallOut'),
    part(t, data.coverage.lates, 'portal.covLateOne', 'portal.covLate'),
  ].filter(Boolean) as string[];
  const replaced = part(
    t,
    data.coverage.replacementsFound,
    'portal.covReplacedOne',
    'portal.covReplaced',
  );

  return (
    <div className="mx-auto space-y-4">
      <PageHeader title={data.client.name} subtitle={t('portal.subtitle')} />

      {/* ---- Hero: the floor right now -------------------------------- */}
      <Card className="relative overflow-hidden border-gold/30 bg-gradient-to-br from-gold/[0.14] via-transparent to-transparent animate-enter">
        <div
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute inset-0',
            onFloor.length > 0
              ? 'bg-[radial-gradient(circle_at_15%_0%,rgb(var(--color-success)/0.14),transparent_55%)]'
              : 'bg-[radial-gradient(circle_at_15%_0%,rgb(var(--color-gold)/0.14),transparent_55%)]',
          )}
        />
        <CardContent className="relative p-5">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-gold">
              <Users className="h-3.5 w-3.5" aria-hidden="true" />
              {t('portal.onFloorNow')}
            </span>
            <span className="flex items-center gap-1.5 text-xs text-silver/70">
              {onFloor.length > 0 && (
                <span className="relative flex h-2 w-2" aria-hidden="true">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60 motion-reduce:hidden" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
                </span>
              )}
              {t('portal.live')}
            </span>
          </div>
          <div className="mt-2 text-5xl font-bold tracking-tight tabular-nums text-white">
            {onFloor.length}
          </div>
          <p className="mt-1.5 text-sm text-silver tabular-nums">
            {data.now.scheduledNow > 0
              ? t('portal.onOfSched', {
                  on: onFloor.length,
                  sched: data.now.scheduledNow,
                })
              : onFloor.length > 0
                ? t('portal.onPlain', { on: onFloor.length })
                : t('portal.nobodyNow')}
          </p>
          {onFloor.length > 0 && (
            <div className="mt-3 flex items-center -space-x-2">
              {onFloor.slice(0, 8).map((p) => (
                <Avatar
                  key={p.associateId}
                  src={photoUrl(p.associateId)}
                  name={p.name}
                  email=""
                  size="md"
                  ringed
                />
              ))}
              {onFloor.length > 8 && (
                <span className="pl-4 text-sm text-silver tabular-nums">
                  +{onFloor.length - 8}
                </span>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---- Today's roster ------------------------------------------- */}
      <Card className="animate-enter" style={enterStagger(1)}>
        <CardContent className="p-5">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-medium text-white">{t('portal.today')}</h2>
            <span
              className={cn(
                'text-xs tabular-nums',
                data.today.open > 0 ? 'text-alert' : 'text-silver/60',
              )}
            >
              {t('portal.todayMeta', {
                filled: data.today.filled,
                open: data.today.open,
              })}
            </span>
          </div>
          {data.today.roster.length === 0 ? (
            <p className="mt-3 text-sm text-silver/60">{t('portal.noShiftsToday')}</p>
          ) : (
            <ul className="mt-3 divide-y divide-navy-secondary/60">
              {data.today.roster.map((r, i) => (
                <li
                  key={r.shiftId}
                  style={enterStagger(i)}
                  className="flex items-center gap-3 py-2.5 animate-enter"
                >
                  {r.associateId ? (
                    <Avatar
                      src={photoUrl(r.associateId)}
                      name={r.name ?? ''}
                      email=""
                      size="md"
                    />
                  ) : (
                    <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-dashed border-alert/50 text-alert text-xs">
                      ?
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-white">
                      {r.name ?? t('portal.state.open')}
                      <span className="font-normal text-silver/80"> · {r.position}</span>
                    </div>
                    <div className="text-xs text-silver tabular-nums">
                      {fmtShiftRangeTz(r.startsAt, r.endsAt, r.timezone)}
                      {r.locationName && (
                        <span className="text-silver/60"> · {r.locationName}</span>
                      )}
                    </div>
                  </div>
                  <span
                    className={cn(
                      'flex shrink-0 items-center gap-1.5 text-xs',
                      STATE_STYLE[r.state],
                    )}
                  >
                    {r.state === 'on-floor' && (
                      <span className="relative flex h-2 w-2" aria-hidden="true">
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60 motion-reduce:hidden" />
                        <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
                      </span>
                    )}
                    {t(`portal.state.${r.state}` as MessageKey)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* ---- This week ---------------------------------------------- */}
        <Card className="animate-enter" style={enterStagger(2)}>
          <CardContent className="p-5">
            <h2 className="flex items-center gap-1.5 text-sm font-medium text-white">
              <CalendarDays className="h-4 w-4 text-gold" aria-hidden="true" />
              {t('portal.week')}
            </h2>
            <div className="mt-3 grid grid-cols-7 gap-1.5 text-center">
              {data.week.days.map((d) => {
                const total = d.filled + d.open;
                const isToday = d.date === data.today.date;
                return (
                  <div
                    key={d.date}
                    className={cn(
                      'rounded-md border py-2',
                      isToday
                        ? 'border-gold/40 bg-gold/[0.06]'
                        : 'border-navy-secondary',
                    )}
                  >
                    <div className="text-2xs text-silver/60">
                      {dayInitial(d.date)}
                    </div>
                    <div
                      className={cn(
                        'mt-0.5 text-sm font-semibold tabular-nums',
                        d.open > 0
                          ? 'text-alert'
                          : total > 0
                            ? 'text-white'
                            : 'text-silver/40',
                      )}
                    >
                      {total > 0 ? `${d.filled}/${total}` : '—'}
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="mt-3 text-sm text-silver tabular-nums">
              {data.week.fillRatePct !== null
                ? t('portal.weekSentence', {
                    pct: data.week.fillRatePct,
                    hours: fmtHours(data.week.hours),
                  })
                : t('portal.weekHoursOnly', { hours: fmtHours(data.week.hours) })}
            </p>
          </CardContent>
        </Card>

        {/* ---- Tomorrow ------------------------------------------------ */}
        <Card className="animate-enter" style={enterStagger(3)}>
          <CardContent className="p-5">
            <h2 className="text-sm font-medium text-white">{t('portal.tomorrow')}</h2>
            {data.tomorrow.confirmed + data.tomorrow.unconfirmed + data.tomorrow.open ===
            0 ? (
              <p className="mt-3 text-sm text-silver/60">{t('portal.tomorrowNone')}</p>
            ) : (
              <>
                <div className="mt-2 text-4xl font-bold tracking-tight tabular-nums text-white">
                  {data.tomorrow.confirmed}
                  <span className="ml-2 text-base font-normal text-silver">
                    {t('portal.confirmedWord')}
                  </span>
                </div>
                <p className="mt-1.5 text-sm text-silver tabular-nums">
                  {[
                    data.tomorrow.unconfirmed > 0 &&
                      t('portal.awaiting', { count: data.tomorrow.unconfirmed }),
                    data.tomorrow.open > 0 &&
                      t('portal.openCount', { count: data.tomorrow.open }),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </>
            )}
          </CardContent>
        </Card>

        {/* ---- Coverage ------------------------------------------------ */}
        <Card className="animate-enter" style={enterStagger(4)}>
          <CardContent className="p-5">
            <h2 className="flex items-center gap-1.5 text-sm font-medium text-white">
              <ShieldCheck className="h-4 w-4 text-gold" aria-hidden="true" />
              {t('portal.coverage')}
            </h2>
            {coverageParts.length === 0 ? (
              <p className="mt-3 flex items-center gap-1.5 text-sm text-success">
                <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                {t('portal.covClean')}
              </p>
            ) : (
              <p className="mt-3 text-sm text-silver tabular-nums">
                {coverageParts.join(' · ')}
              </p>
            )}
            {replaced && (
              <p className="mt-1.5 text-sm text-success tabular-nums">{replaced}</p>
            )}
          </CardContent>
        </Card>

        {/* ---- Statements ---------------------------------------------- */}
        <Card className="animate-enter" style={enterStagger(5)}>
          <CardContent className="p-5">
            <h2 className="text-sm font-medium text-white">{t('portal.statements')}</h2>
            {data.statements.length === 0 ? (
              <p className="mt-3 text-sm text-silver/60">{t('portal.stNone')}</p>
            ) : (
              <ul className="mt-3 divide-y divide-navy-secondary/60">
                {data.statements.map((s) => (
                  <li
                    key={s.id}
                    className="flex items-center justify-between gap-3 py-2.5"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-white tabular-nums">
                        {s.number !== null
                          ? t('portal.stNumber', { n: s.number })
                          : t('portal.statements')}
                      </div>
                      <div className="text-xs text-silver/70 tabular-nums">
                        {fmtDate(parseYmd(s.periodStart))} –{' '}
                        {fmtDate(parseYmd(s.periodEnd))}
                        {s.hours !== null && ` · ${fmtHours(s.hours)}`}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2.5">
                      {s.amount !== null && (
                        <span className="text-sm font-semibold tabular-nums text-white">
                          {fmtMoney(s.amount)}
                        </span>
                      )}
                      {s.paidAt ? (
                        <Badge variant="success">
                          {t('portal.paidOn', { date: fmtDate(s.paidAt) })}
                        </Badge>
                      ) : (
                        <Badge variant="pending">{t('portal.due')}</Badge>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ---- Requests: the client in the loop -------------------------- */}
      {isPortal && <PortalRequests />}
    </div>
  );
}

/** "3 call-outs" / "1 call-out" / null when zero. */
function part(
  t: ReturnType<typeof useI18n>['t'],
  count: number,
  one: MessageKey,
  many: MessageKey,
): string | null {
  if (count === 0) return null;
  return count === 1 ? t(one) : t(many, { count });
}

/** Weekday initial for a YYYY-MM-DD key, locale-aware. */
function dayInitial(ymd: string): string {
  const d = parseYmd(ymd);
  if (!d) return '';
  return new Intl.DateTimeFormat(
    typeof document !== 'undefined' && document.documentElement.lang === 'es'
      ? 'es-US'
      : 'en-US',
    { weekday: 'narrow' },
  ).format(d);
}

