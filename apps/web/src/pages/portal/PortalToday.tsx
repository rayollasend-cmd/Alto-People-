import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, CalendarDays, ChevronLeft, ChevronRight, Download, Printer, Users } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { fmtDate, fmtShiftRangeTz, fmtTime, fmtTimeTz, parseYmd, ymdLocal } from '@/lib/format';
import { downloadCsv } from '@/lib/csv';
import { cn } from '@/lib/cn';
import { PageHeader } from '@/components/ui/PageHeader';
import { Card, CardContent } from '@/components/ui/Card';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { groupWaves, wavePresent, type Wave, type WaveRow } from './waves';
import { scopeParams, shiftDays } from './scope';

/**
 * A day — who was on the floor, wave by wave. Today reads live; any
 * other date reads from the punch record, so "2 days ago" looks exactly
 * like today did at close: who worked (in/out times), who was expected
 * and never punched, unfilled slots, and finished waves folded to their
 * proof line. Punch times only — never a "late" label; the judgment
 * stays with Alto. The date lives in the URL so a link to last Tuesday
 * opens on last Tuesday.
 */

interface DayPayload {
  client: { id: string; name: string };
  store: { id: string; name: string; timezone: string } | null;
  date: string;
  today: string;
  generatedAt: string;
  target: number | null;
  roster: WaveRow[];
  summary: { expected: number; worked: number; onFloor: number; missed: number; open: number };
}

const photoUrl = (associateId: string) => `/api/associates/${associateId}/photo`;

export function PortalToday() {
  const { t } = useI18n();
  const { user, can } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const isPortal = user?.role === 'CLIENT_PORTAL';
  const canPreview = can('view:executive') || can('manage:org');
  const previewId = searchParams.get('clientId');
  const scope = scopeParams(searchParams, isPortal);
  const scopeQs = scope.toString() ? `?${scope.toString()}` : '';
  const date = searchParams.get('date') ?? ymdLocal();
  const qs = `?${new URLSearchParams([...scope.entries(), ['date', date]]).toString()}`;

  const enabled = isPortal || (canPreview && !!previewId);
  const query = useQuery({
    queryKey: ['clientPortal', 'day', qs],
    queryFn: () => apiFetch<DayPayload>(`/client-portal/day${qs}`),
    enabled,
    refetchInterval: date === ymdLocal() ? 60_000 : false,
  });
  const data = query.data;
  const waves = useMemo(() => (data ? groupWaves(data.roster) : []), [data]);

  if (!isPortal && !canPreview) {
    return <EmptyState icon={Users} title={t('portal.noAccess')} description="" />;
  }
  if (!isPortal && !previewId) {
    return <EmptyState icon={Users} title={t('portal.todayNav')} description={t('portal.pickClient')} />;
  }

  const goDay = (next: string | null) => {
    const p = new URLSearchParams(searchParams);
    if (next === null) p.delete('date');
    else p.set('date', next);
    setSearchParams(p, { replace: true });
  };
  const isToday = date === ymdLocal();
  const isPast = date < ymdLocal();
  const dayLabel = isToday
    ? t('portal.todayNav')
    : date === shiftDays(ymdLocal(), -1)
      ? t('portal.yesterday')
      : fmtDate(parseYmd(date));
  const present = data ? data.summary.worked : 0;

  return (
    <div className="mx-auto max-w-4xl space-y-4 print-area">
      <PageHeader
        title={dayLabel}
        topbarTitle={t('portal.todayNav')}
        subtitle={
          data
            ? `${data.store ? data.store.name : data.client.name} · ${fmtDate(parseYmd(data.date))}${
                isToday ? ` · ${t('portal.asOf', { time: fmtTime(data.generatedAt) })}` : ''
              }`
            : undefined
        }
        breadcrumbs={[{ label: t('portal.title'), to: `/portal${scopeQs}` }]}
        secondaryActions={
          <Button size="sm" variant="ghost" asChild>
            <Link to={`/portal${scopeQs}`}>
              <ArrowLeft className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              {t('portal.backHome')}
            </Link>
          </Button>
        }
        primaryAction={
          <>
            <Button
              size="sm"
              variant="outline"
              className="print:hidden"
              disabled={!data || data.roster.length === 0}
              onClick={() =>
                data &&
                downloadCsv(`day-${date}.csv`, [
                  ['Date', 'Store', 'Shift start', 'Shift end', 'Name', 'Position', 'Lead', 'Status', 'Clock in', 'Clock out'],
                  ...data.roster.map((r) => [
                    data.date,
                    r.locationName ?? data.store?.name ?? data.client.name,
                    fmtTimeTz(r.startsAt, r.timezone),
                    fmtTimeTz(r.endsAt, r.timezone),
                    r.name ?? '',
                    r.position,
                    r.isLead ? 'yes' : '',
                    r.state,
                    r.clockInAt ? fmtTimeTz(r.clockInAt, r.timezone) : '',
                    r.clockOutAt ? fmtTimeTz(r.clockOutAt, r.timezone) : '',
                  ]),
                ])
              }
            >
              <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              CSV
            </Button>
            <Button size="sm" variant="outline" className="print:hidden" onClick={() => window.print()}>
              <Printer className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              {t('portal.print')}
            </Button>
            <Button size="sm" variant="outline" className="print:hidden" asChild>
              <Link to={`/portal/schedule${scope.toString() ? `?${scope.toString()}&` : '?'}week=${date}`}>
                <CalendarDays className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                {t('portal.openSchedule')}
              </Link>
            </Button>
          </>
        }
      />

      {/* ---- Date control: one row, above everything it scopes ---------- */}
      <div className="sticky top-0 z-10 -mx-4 flex items-center gap-2 bg-navy/95 px-4 py-2 backdrop-blur md:mx-0 md:px-0 print:hidden">
        <Button size="sm" variant="ghost" onClick={() => goDay(shiftDays(date, -1))} aria-label={t('portal.prevDay')}>
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        </Button>
        <div className="flex flex-1 items-center gap-1 overflow-x-auto">
          <Button size="sm" variant={isToday ? 'secondary' : 'ghost'} onClick={() => goDay(null)}>
            {t('portal.todayNav')}
          </Button>
          <Button
            size="sm"
            variant={date === shiftDays(ymdLocal(), -1) ? 'secondary' : 'ghost'}
            onClick={() => goDay(shiftDays(ymdLocal(), -1))}
          >
            {t('portal.yesterday')}
          </Button>
          <label className="ml-1 flex items-center gap-1.5 text-xs text-silver/70">
            <span className="sr-only">{t('portal.pickDate')}</span>
            <input
              type="date"
              value={date}
              onChange={(e) => e.target.value && goDay(e.target.value)}
              className="h-8 rounded-md border border-navy-secondary bg-navy px-2 text-xs text-white coarse:h-10"
              aria-label={t('portal.pickDate')}
            />
          </label>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => goDay(shiftDays(date, 1))}
          aria-label={t('portal.nextDay')}
          disabled={date >= shiftDays(ymdLocal(), 14)}
        >
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>

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
          <CardContent className="p-5 text-sm text-silver/60">
            {isPast ? t('portal.noShiftsThatDay') : t('portal.noShiftsToday')}
          </CardContent>
        </Card>
      ) : (
        <>
          <p className="text-sm text-silver tabular-nums">
            {isToday
              ? t('portal.todaySummary', { on: data.summary.onFloor, expected: data.summary.expected, waves: waves.length })
              : isPast
                ? t('portal.daySummaryPast', { worked: present, expected: data.summary.expected, missed: data.summary.missed, open: data.summary.open })
                : t('portal.daySummaryFuture', { expected: data.summary.expected, open: data.summary.open })}
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
  const present = wavePresent(w);
  const short = w.phase === 'live' && w.clockedIn.length < w.expected;
  const missedAll = w.phase === 'finished' && present < w.expected;
  const headline =
    w.phase === 'finished'
      ? t('portal.waveWorked', { worked: present, expected: w.expected })
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
          {r.state === 'on-floor' && r.clockInAt ? (
            <span className="flex shrink-0 items-center gap-1.5 text-xs text-success tabular-nums">
              <span className="relative flex h-2 w-2" aria-hidden="true">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60 motion-reduce:hidden" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
              </span>
              {t('portal.clockedInAt', { time: fmtTimeTz(r.clockInAt, r.timezone) })}
            </span>
          ) : r.state === 'worked' && r.clockInAt ? (
            <span className="shrink-0 text-xs text-silver tabular-nums">
              {r.clockOutAt
                ? t('portal.punchRange', {
                    in: fmtTimeTz(r.clockInAt, r.timezone),
                    out: fmtTimeTz(r.clockOutAt, r.timezone),
                  })
                : t('portal.clockedInAt', { time: fmtTimeTz(r.clockInAt, r.timezone) })}
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
      {w.worked.length > 0 && people(w.worked, false)}
      {w.notIn.length > 0 && (
        <p className={cn('mt-2 text-xs tabular-nums', w.phase === 'finished' ? 'text-alert' : 'text-warning')}>
          {w.phase === 'finished'
            ? t('portal.waveNoPunch', { names: w.notIn.map((r) => r.name).join(', ') })
            : t('portal.waveNotIn', { names: w.notIn.map((r) => r.name).join(', ') })}
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
    <Card
      className={cn(
        w.phase === 'live' && (short ? 'border-warning/40' : 'border-success/30'),
        missedAll && 'border-alert/30',
      )}
    >
      <CardContent className="p-5">
        {w.phase === 'finished' ? (
          <details className="group" open={missedAll}>
            <summary className="flex cursor-pointer list-none items-baseline justify-between gap-3">
              <span className="text-sm font-medium text-silver">{range}</span>
              <span className={cn('text-xs tabular-nums', missedAll ? 'text-alert' : 'text-silver/60')}>
                {headline}
              </span>
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
