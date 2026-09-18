import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Download,
  Printer,
  Users,
  FileText,
} from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useI18n, type MessageKey } from '@/lib/i18n';
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
import { groupWaves, waveName, wavePresent, type Wave, type WaveName, type WaveRow } from './waves';
import { ServiceReportDialog } from './ServiceReportDialog';
import { scopeParams, shiftDays } from './scope';

/**
 * A day — who was on the floor, wave by wave, as FACES.
 *
 * A 47-person overnight crew is a wall of names as a list and a glance
 * as a face wall: the photo where one exists, the system avatar (the
 * tinted initials every associate gets at onboarding) where it doesn't.
 * State rides the ring — green on the floor, red with no punch, muted
 * for a crew that hasn't started — and the name appears on tap, so the
 * page reads at arm's length on an iPad and still answers "who is that"
 * with one touch. Today reads live; any other date reads from the punch
 * record. Punch times only, never a "late" label. The date lives in the
 * URL so a link to last Tuesday opens on last Tuesday.
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
const WAVE_KEY: Record<WaveName, MessageKey> = {
  morning: 'portal.wave.morning',
  midday: 'portal.wave.midday',
  evening: 'portal.wave.evening',
  overnight: 'portal.wave.overnight',
};

export function PortalToday() {
  const { t } = useI18n();
  const { user, can } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const isPortal = user?.role === 'CLIENT_PORTAL';
  // The shift supervisor opens this page on their own client (the day
  // route opts the role in, clamped server-side) — /today in their nav.
  const isFloorLead = user?.role === 'SHIFT_SUPERVISOR';
  const canPreview = can('view:executive') || can('manage:org');
  const previewId = searchParams.get('clientId');
  const scope = scopeParams(searchParams, isPortal);
  const scopeQs = scope.toString() ? `?${scope.toString()}` : '';
  const date = searchParams.get('date') ?? ymdLocal();
  const qs = `?${new URLSearchParams([...scope.entries(), ['date', date]]).toString()}`;

  const enabled = isPortal || isFloorLead || (canPreview && !!previewId);
  const homeTo = isFloorLead ? '/' : `/portal${scopeQs}`;
  const homeLabel = isFloorLead ? t('floor.title') : t('portal.backHome');
  const query = useQuery({
    queryKey: ['clientPortal', 'day', qs],
    queryFn: () => apiFetch<DayPayload>(`/client-portal/day${qs}`),
    enabled,
    refetchInterval: date === ymdLocal() ? 60_000 : false,
    refetchOnWindowFocus: date === ymdLocal(),
    // Stepping between days keeps the page on screen until the next loads.
    placeholderData: (prev) => prev,
  });
  const data = query.data;
  const switching = !!data && data.date !== date;
  // An alert links here with ?wave=<start>: open that shift and bring it into view.
  const focusWave = searchParams.get('wave');
  useEffect(() => {
    if (!focusWave || !data || switching) return;
    const el = document.getElementById(`wave-${focusWave}`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focusWave, data, switching]);
  const waves = useMemo(() => (data ? groupWaves(data.roster) : []), [data]);
  const [reportOpen, setReportOpen] = useState(false);
  // The store name only earns a place on a row when rows span stores.
  const multiStore = useMemo(
    () => new Set((data?.roster ?? []).map((r) => r.locationName ?? '')).size > 1,
    [data],
  );

  if (!isPortal && !isFloorLead && !canPreview) {
    return <EmptyState icon={Users} title={t('portal.noAccess')} description="" />;
  }
  if (!isPortal && !isFloorLead && !previewId) {
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

  return (
    <div className={cn('mx-auto max-w-5xl space-y-4 print-area', switching && 'opacity-70 transition-opacity')}>
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
        breadcrumbs={[{ label: isFloorLead ? t('floor.title') : t('portal.title'), to: homeTo }]}
        secondaryActions={
          <Button size="sm" variant="ghost" asChild>
            <Link to={homeTo}>
              <ArrowLeft className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              {homeLabel}
            </Link>
          </Button>
        }
        primaryAction={
          <>
            {/* The service report is the client's document — portal only. */}
            {!isFloorLead && (
              <>
                <Button size="sm" variant="outline" className="print:hidden" onClick={() => setReportOpen(true)}>
                  <FileText className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                  {t('portal.svcReport')}
                </Button>
                <ServiceReportDialog open={reportOpen} onClose={() => setReportOpen(false)} scope={scope} initial={{ kind: 'day', date }} />
              </>
            )}
            <Button
              size="sm"
              variant="outline"
              className="hidden print:hidden sm:inline-flex"
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
            <Button size="sm" variant="outline" className="hidden print:hidden sm:inline-flex" onClick={() => window.print()}>
              <Printer className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              {t('portal.print')}
            </Button>
            <Button size="sm" variant="outline" className="print:hidden" asChild>
              <Link
                to={
                  isFloorLead
                    ? '/scheduling'
                    : `/portal/schedule${scope.toString() ? `?${scope.toString()}&` : '?'}week=${date}`
                }
              >
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
        <div className="flex flex-1 flex-wrap items-center gap-1">
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
              className="h-8 rounded-md border border-navy-secondary bg-navy px-2 text-xs text-white coarse:h-11 coarse:text-base"
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
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
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
                ? t('portal.daySummaryPast', {
                    worked: data.summary.worked,
                    expected: data.summary.expected,
                    missed: data.summary.missed,
                    open: data.summary.open,
                  })
                : t('portal.daySummaryFuture', { expected: data.summary.expected, open: data.summary.open })}
            <span className="text-silver/50"> · {t('portal.faceHint')}</span>
          </p>
          {waves.map((w) => (
            <WaveCard key={w.key} wave={w} multiStore={multiStore} focused={focusWave === w.startsAt} />
          ))}
        </>
      )}
    </div>
  );
}

/* ---- One wave: the headline, the meter, the face wall ------------------ */

type FaceTone = 'on-floor' | 'worked' | 'missing' | 'upcoming';

function WaveCard({ wave: w, multiStore, focused = false }: { wave: Wave; multiStore: boolean; focused?: boolean }) {
  const { t } = useI18n();
  const [selected, setSelected] = useState<WaveRow | null>(null);
  const range = fmtShiftRangeTz(w.startsAt, w.endsAt, w.timezone);
  const present = wavePresent(w);
  const short = w.phase === 'live' && w.clockedIn.length < w.expected;
  const missedSome = w.phase === 'finished' && present < w.expected;
  const pct = w.expected > 0 ? Math.round((present / w.expected) * 100) : 0;
  const headline =
    w.phase === 'finished'
      ? t('portal.waveWorked', { worked: present, expected: w.expected })
      : w.phase === 'upcoming'
        ? t('portal.waveStarts', { time: fmtTimeTz(w.startsAt, w.timezone), expected: w.expected })
        : t('portal.waveInOf', { in: w.clockedIn.length, expected: w.expected });

  const allGroups: Array<{ key: string; label: string; rows: WaveRow[]; tone: FaceTone }> = [
    { key: 'in', label: t('portal.faceOnFloor'), rows: w.clockedIn, tone: 'on-floor' },
    { key: 'worked', label: t('portal.faceWorked'), rows: w.worked, tone: 'worked' },
    {
      key: 'missing',
      label: w.phase === 'finished' ? t('portal.faceNoPunch') : t('portal.faceNotIn'),
      rows: w.notIn,
      tone: 'missing',
    },
    { key: 'upcoming', label: t('portal.faceUpcoming'), rows: w.upcoming, tone: 'upcoming' },
  ];
  const groups = allGroups.filter((g) => g.rows.length > 0);

  const caption = (r: WaveRow) => {
    const who = `${r.name ?? ''} · ${r.position}${r.isLead ? ` · ${t('portal.leadTag')}` : ''}`;
    const where = multiStore && r.locationName ? ` · ${r.locationName}` : '';
    const when =
      r.state === 'on-floor' && r.clockInAt
        ? t('portal.clockedInAt', { time: fmtTimeTz(r.clockInAt, r.timezone) })
        : r.state === 'worked' && r.clockInAt
          ? r.clockOutAt
            ? t('portal.punchRange', { in: fmtTimeTz(r.clockInAt, r.timezone), out: fmtTimeTz(r.clockOutAt, r.timezone) })
            : t('portal.clockedInAt', { time: fmtTimeTz(r.clockInAt, r.timezone) })
          : r.state === 'missed'
            ? t('portal.faceNoPunch')
            : r.state === 'not-in'
              ? t('portal.faceNotIn')
              : r.state === 'confirmed'
                ? t('portal.state.confirmed')
                : t('portal.state.unconfirmed');
    return `${who}${where} · ${when}`;
  };

  const body = (
    <div className="space-y-4">
      {groups.map((g) => (
        <div key={g.key}>
          <div className="mb-2 flex items-baseline gap-2 text-2xs uppercase tracking-wider text-silver/60">
            <span
              className={cn(
                'inline-block h-1.5 w-1.5 rounded-full',
                g.tone === 'on-floor'
                  ? 'bg-success'
                  : g.tone === 'missing'
                    ? 'bg-alert'
                    : g.tone === 'worked'
                      ? 'bg-silver/70'
                      : 'bg-silver/30',
              )}
              aria-hidden="true"
            />
            {g.label}
            <span className="tabular-nums text-silver/40">{g.rows.length}</span>
          </div>
          <ul className="flex flex-wrap gap-2" role="list">
            {g.rows.map((r) => {
              const isSel = selected?.shiftId === r.shiftId;
              return (
                <li key={r.shiftId}>
                  <button
                    type="button"
                    onClick={() => setSelected(isSel ? null : r)}
                    aria-pressed={isSel}
                    aria-label={caption(r)}
                    title={caption(r)}
                    className={cn(
                      'relative block rounded-full transition-transform focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
                      'coarse:active:scale-95',
                      isSel && 'scale-110',
                    )}
                  >
                    <Avatar
                      src={r.associateId ? photoUrl(r.associateId) : null}
                      name={r.name ?? ''}
                      email=""
                      size="lg"
                      className={cn(
                        'ring-2 ring-offset-2 ring-offset-navy',
                        g.tone === 'on-floor' && 'ring-success',
                        g.tone === 'worked' && 'ring-navy-secondary',
                        g.tone === 'missing' && 'ring-alert/70 opacity-60 grayscale',
                        g.tone === 'upcoming' &&
                          (r.state === 'confirmed' ? 'ring-navy-secondary opacity-80' : 'ring-warning/50 opacity-60'),
                        isSel && 'ring-gold',
                      )}
                    />
                    {r.isLead && (
                      <span
                        className="absolute -bottom-0.5 -right-0.5 grid h-4 w-4 place-items-center rounded-full bg-gold text-[9px] font-bold text-on-accent"
                        aria-hidden="true"
                      >
                        L
                      </span>
                    )}
                    {g.tone === 'on-floor' && (
                      <span className="absolute -right-0.5 -top-0.5 inline-flex h-2.5 w-2.5 rounded-full bg-success ring-2 ring-navy" aria-hidden="true" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {w.open.length > 0 && (
        <div>
          <div className="mb-2 flex items-baseline gap-2 text-2xs uppercase tracking-wider text-silver/60">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-alert" aria-hidden="true" />
            {t('portal.faceUnfilled')}
            <span className="tabular-nums text-silver/40">{w.open.length}</span>
          </div>
          <ul className="flex flex-wrap gap-2" role="list">
            {w.open.map((r) => (
              <li key={r.shiftId}>
                <button
                  type="button"
                  onClick={() => setSelected(selected?.shiftId === r.shiftId ? null : r)}
                  aria-pressed={selected?.shiftId === r.shiftId}
                  className={cn(
                    'grid h-12 w-12 place-items-center rounded-full border-2 border-dashed border-alert/50 text-sm text-alert focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
                    selected?.shiftId === r.shiftId && 'border-gold text-gold',
                  )}
                  title={r.position}
                  aria-label={`${t('portal.faceUnfilled')} · ${r.position}`}
                >
                  ?
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-xs text-alert/80">
            {[...new Set(w.open.map((r) => r.position))].join(', ')}
          </p>
        </div>
      )}
      <div
        className={cn(
          'min-h-5 text-sm transition-opacity',
          selected ? 'text-white opacity-100' : 'text-silver/40 opacity-0',
        )}
        aria-live="polite"
      >
        {selected ? caption(selected) : ''}
      </div>
    </div>
  );

  const header = (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <h2 className={cn('text-sm font-medium', w.phase === 'finished' ? 'text-silver' : 'text-white')}>
        <span className="text-gold">{t(WAVE_KEY[waveName(w.startsAt, w.timezone)])}</span> · {range}
        {w.phase === 'live' && (
          <span className="ml-2 text-2xs font-medium uppercase tracking-wider text-success">{t('portal.live')}</span>
        )}
      </h2>
      <span
        className={cn(
          'text-sm font-semibold tabular-nums',
          short ? 'text-warning' : missedSome ? 'text-alert' : w.phase === 'finished' ? 'text-silver/70' : 'text-white',
        )}
      >
        {headline}
      </span>
    </div>
  );
  const meter = w.phase !== 'upcoming' && w.expected > 0 && (
    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-gold/15" aria-hidden="true">
      <div
        className={cn('h-full rounded-full', short || missedSome ? (pct < 70 ? 'bg-alert' : 'bg-warning') : 'bg-success')}
        style={{ width: `${pct}%` }}
      />
    </div>
  );

  return (
    <Card
      id={`wave-${w.startsAt}`}
      className={cn(
        'scroll-mt-20',
        w.phase === 'live' && (short ? 'border-warning/40' : 'border-success/30'),
        missedSome && 'border-alert/30',
        focused && 'ring-2 ring-gold/70',
      )}
    >
      <CardContent className="p-4 sm:p-5">
        {w.phase === 'finished' ? (
          <details className="group" open={missedSome || focused}>
            <summary className="cursor-pointer list-none">
              {header}
              {meter}
            </summary>
            <div className="mt-4">{body}</div>
          </details>
        ) : (
          <>
            {header}
            {meter}
            <div className="mt-4">{body}</div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
