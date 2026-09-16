import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, CalendarDays, Users } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { fmtDate, fmtShiftRangeTz, fmtTime, fmtTimeTz, parseYmd } from '@/lib/format';
import { cn } from '@/lib/cn';
import { PageHeader } from '@/components/ui/PageHeader';
import { Card, CardContent } from '@/components/ui/Card';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { groupWaves, type Wave, type WaveRow } from './waves';

/**
 * Today — who is on the floor, wave by wave. The page a store manager
 * opens when the district lead calls: each shift window with the people
 * clocked in (faces, positions, punch times), the gap ("7 of 8 in") with
 * who isn't in yet, unfilled slots, and finished waves folded to their
 * proof line. Punch times only — never a "late" label; the judgment
 * stays with Alto.
 *
 * Reads the same overview payload as the home page (one round trip,
 * shared cache), so the two never disagree.
 */

interface TodayPayload {
  client: { id: string; name: string };
  store: { id: string; name: string; timezone: string; address: string | null } | null;
  generatedAt: string;
  now: { onFloor: Array<{ associateId: string }>; target: number | null };
  today: { date: string; roster: WaveRow[]; filled: number; open: number };
}

const photoUrl = (associateId: string) => `/api/associates/${associateId}/photo`;

function scopeQuery(params: URLSearchParams, isPortal: boolean): string {
  const q = new URLSearchParams();
  const client = params.get('clientId');
  const loc = params.get('locationId');
  if (!isPortal && client) q.set('clientId', client);
  if (loc) q.set('locationId', loc);
  const s = q.toString();
  return s ? `?${s}` : '';
}

export function PortalToday() {
  const { t } = useI18n();
  const { user, can } = useAuth();
  const [searchParams] = useSearchParams();
  const isPortal = user?.role === 'CLIENT_PORTAL';
  const canPreview = can('view:executive') || can('manage:org');
  const previewId = searchParams.get('clientId');
  const qs = scopeQuery(searchParams, isPortal);

  const enabled = isPortal || (canPreview && !!previewId);
  const query = useQuery({
    queryKey: ['clientPortal', 'overview', isPortal ? 'me' : previewId, qs],
    queryFn: () => apiFetch<TodayPayload>(`/client-portal/overview${qs}`),
    enabled,
    refetchInterval: 60_000,
  });
  const data = query.data;
  const waves = useMemo(() => (data ? groupWaves(data.today.roster) : []), [data]);

  if (!isPortal && !canPreview) {
    return <EmptyState icon={Users} title={t('portal.noAccess')} description="" />;
  }
  if (!isPortal && !previewId) {
    return <EmptyState icon={Users} title={t('portal.todayNav')} description={t('portal.pickClient')} />;
  }

  const onFloor = data?.now.onFloor.length ?? 0;
  const expected = waves.reduce((a, w) => a + w.expected, 0);

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader
        title={t('portal.todayNav')}
        topbarTitle={t('portal.todayNav')}
        subtitle={
          data
            ? `${data.store ? data.store.name : data.client.name} · ${fmtDate(parseYmd(data.today.date))} · ${t('portal.asOf', { time: fmtTime(data.generatedAt) })}`
            : undefined
        }
        breadcrumbs={[{ label: t('portal.title'), to: `/portal${qs}` }]}
        secondaryActions={
          <Button size="sm" variant="ghost" asChild>
            <Link to={`/portal${qs}`}>
              <ArrowLeft className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              {t('portal.backHome')}
            </Link>
          </Button>
        }
        primaryAction={
          <Button size="sm" variant="outline" asChild>
            <Link to={`/portal/schedule${qs}`}>
              <CalendarDays className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              {t('portal.openSchedule')}
            </Link>
          </Button>
        }
      />

      {query.isError ? (
        <ErrorBanner
          action={
            <Button size="sm" variant="secondary" onClick={() => void query.refetch()}>
              {t('common.retry')}
            </Button>
          }
        >
          {t('portal.loadFailed')}
        </ErrorBanner>
      ) : !data ? (
        <div className="space-y-3">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
      ) : waves.length === 0 ? (
        <Card>
          <CardContent className="p-5 text-sm text-silver/60">{t('portal.noShiftsToday')}</CardContent>
        </Card>
      ) : (
        <>
          <p className="text-sm text-silver tabular-nums">
            {t('portal.todaySummary', { on: onFloor, expected, waves: waves.length })}
          </p>
          {waves.map((w) => (
            <WaveCard key={w.key} wave={w} showLocation={!data.store} />
          ))}
        </>
      )}
    </div>
  );
}

function WaveCard({ wave: w, showLocation }: { wave: Wave; showLocation: boolean }) {
  const { t } = useI18n();
  const range = fmtShiftRangeTz(w.startsAt, w.endsAt, w.timezone);
  const short = w.phase === 'live' && w.clockedIn.length < w.expected;
  const headline =
    w.phase === 'finished'
      ? t('portal.waveWorked', { worked: w.worked, expected: w.expected })
      : w.phase === 'upcoming'
        ? t('portal.waveStarts', { time: fmtTimeTz(w.startsAt, w.timezone), expected: w.expected })
        : t('portal.waveInOf', { in: w.clockedIn.length, expected: w.expected });

  const people = (rows: WaveRow[], muted: boolean) => (
    <ul className={cn('divide-y divide-navy-secondary/60', muted && 'opacity-70')}>
      {rows.map((r) => (
        <li key={r.shiftId} className="flex items-center gap-3 py-2.5">
          {r.associateId ? (
            <Avatar src={photoUrl(r.associateId)} name={r.name ?? ''} email="" size="md" />
          ) : null}
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-white">
              {r.name}
              <span className="font-normal text-silver/80"> · {r.position}</span>
              {r.isLead && (
                <span className="ml-1.5 rounded bg-gold/15 px-1 py-px text-2xs font-medium uppercase tracking-wider text-gold">
                  {t('portal.leadTag')}
                </span>
              )}
            </div>
            {showLocation && r.locationName && (
              <div className="text-xs text-silver/60">{r.locationName}</div>
            )}
          </div>
          {r.clockInAt ? (
            <span className="flex shrink-0 items-center gap-1.5 text-xs text-success tabular-nums">
              <span className="relative flex h-2 w-2" aria-hidden="true">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60 motion-reduce:hidden" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
              </span>
              {t('portal.clockedInAt', { time: fmtTimeTz(r.clockInAt, r.timezone) })}
            </span>
          ) : (
            <span className="shrink-0 text-xs text-silver/60">
              {r.state === 'confirmed' ? t('portal.state.confirmed') : t('portal.state.unconfirmed')}
            </span>
          )}
        </li>
      ))}
    </ul>
  );

  const body = (
    <>
      {w.clockedIn.length > 0 && people(w.clockedIn, false)}
      {w.notIn.length > 0 && (
        <p className="mt-2 text-xs text-warning tabular-nums">
          {t('portal.waveNotIn', { names: w.notIn.map((r) => r.name).join(', ') })}
        </p>
      )}
      {w.upcoming.length > 0 && people(w.upcoming, true)}
      {w.open.length > 0 && (
        <p className="mt-2 flex items-center gap-2 text-xs text-alert tabular-nums">
          <span className="grid h-6 w-6 place-items-center rounded-full border border-dashed border-alert/50 text-2xs">
            ?
          </span>
          {t('portal.waveUnfilled', {
            count: w.open.length,
            positions: [...new Set(w.open.map((r) => r.position))].join(', '),
          })}
        </p>
      )}
    </>
  );

  return (
    <Card className={cn(w.phase === 'live' && (short ? 'border-warning/40' : 'border-success/30'))}>
      <CardContent className="p-5">
        {w.phase === 'finished' ? (
          <details className="group">
            <summary className="flex cursor-pointer list-none items-baseline justify-between gap-3">
              <span className="text-sm font-medium text-silver">{range}</span>
              <span className="text-xs text-silver/60 tabular-nums">{headline}</span>
            </summary>
            <div className="mt-3">{body}</div>
          </details>
        ) : (
          <>
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-sm font-medium text-white">
                {range}
                {w.phase === 'live' && (
                  <span className="ml-2 text-2xs font-medium uppercase tracking-wider text-success">
                    {t('portal.live')}
                  </span>
                )}
              </h2>
              <span className={cn('text-sm font-semibold tabular-nums', short ? 'text-warning' : 'text-white')}>
                {headline}
              </span>
            </div>
            <div className="mt-3">{body}</div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
