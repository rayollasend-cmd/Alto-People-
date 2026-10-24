import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Download,
  MessageSquare,
  MessageSquareText,
  Phone,
  Printer,
  Users,
  FileText,
} from '@/components/ui/icons';
import { LATE_GRACE_MINUTES } from '@alto-people/shared';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { regionOverview, type RegionOverview } from '@/lib/regionsApi';
import { useUrlParam } from '@/lib/useUrlState';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { fmtDate, fmtShiftRangeTz, fmtShiftTz, fmtTime, fmtTimeTz, parseYmd, phoneHref, ymdLocal } from '@/lib/format';
import { downloadCsv } from '@/lib/csv';
import { cn } from '@/lib/cn';
import { Card, CardContent } from '@/components/ui/Card';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryError } from '@/components/ui/QueryError';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Skeleton } from '@/components/ui/Skeleton';
import { groupWaves, waveName, wavePresent, type Wave, type WaveName, type WaveRow } from './waves';
import { ServiceReportDialog } from './ServiceReportDialog';
import { FocusToggle } from './FocusToggle';
import { clockInInWindows, crewOnFloor, inWindows, summarize, useShiftFocus, windowOf } from './shiftFocus';
import { ListTemplate } from '@/components/templates';
import { CrewTextDialog } from '@/components/floor/CrewTextDialog';
import { scopeParams, shiftDays } from './scope';
import '@/lib/i18n/en/floor';
import '@/lib/i18n/en/focus';
import '@/lib/i18n/en/portal';
import '@/lib/i18n/en/region';

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
  /** Every open clock-in right now (today only) — the live board's count. */
  onFloorNow?: Array<{ associateId: string; name: string; clockInAt: string; position: string | null }>;
  summary: { expected: number; worked: number; onFloor: number; missed: number; open: number };
  /** The store's named shift windows and who leads each. */
  windowLeads?: Array<{ locationId: string; label: string; startMinute: number; endMinute: number; leads: string[]; targetCount?: number }>;
  /** A day with no shifts: the next published one in the same scope (null: none). */
  nextShift?: { startsAt: string; endsAt: string; position: string; timezone: string } | null;
}

type CrewView = 'list' | 'faces';
const CREW_VIEWS: readonly CrewView[] = ['list', 'faces'];

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
  // The store's supervisors — shift and floor — open this page on their
  // own client (the day route opts the roles in, clamped server-side) —
  // /today in their nav.
  const isFloorLead = user?.role === 'SHIFT_SUPERVISOR' || user?.role === 'FLOOR_SUPERVISOR';
  const canPreview = can('view:executive') || can('manage:org');
  const previewId = searchParams.get('clientId');
  const scope = scopeParams(searchParams, isPortal);
  const scopeQs = scope.toString() ? `?${scope.toString()}` : '';
  const date = searchParams.get('date') ?? ymdLocal();
  const qs = `?${new URLSearchParams([...scope.entries(), ['date', date]]).toString()}`;

  // A REGION account (the command center) has no store of its own: the day
  // API answers 400 "Pick a store in your region" until one is named, so the
  // page asks which store instead of a red banner Retry can't fix (F500 G2).
  const isRegion = isPortal && !user?.clientId && !!user?.regionId;
  const needsStore = isRegion && !searchParams.get('locationId');
  const enabled = (isPortal && !needsStore) || isFloorLead || (canPreview && !!previewId);
  const homeTo = isFloorLead ? '/' : isRegion ? '/region' : `/portal${scopeQs}`;
  const regionStores = useQuery({
    queryKey: ['region', 'overview', 'me'],
    queryFn: () => regionOverview(null),
    enabled: needsStore,
    staleTime: 60_000,
  });
  // Names in rows at every width; the face wall is an optional compact mode.
  const [crewView, setCrewView] = useUrlParam<CrewView>('view', 'list', CREW_VIEWS);
  const faces = crewView === 'faces';
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
  // A supervisor opens on their shift; "Whole store" is one tap away.
  const { windows: myWindows, focus, setFocus, mine } = useShiftFocus();
  const focusRows = useMemo(
    () => (data ? (mine ? data.roster.filter((r) => inWindows(r, myWindows)) : data.roster) : []),
    [data, mine, myWindows],
  );
  const waves = useMemo(() => groupWaves(focusRows), [focusRows]);
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

  if (needsStore) {
    return (
      <ListTemplate
        className="mx-auto max-w-5xl space-y-4"
        title={t('portal.todayNav')}
        topbarTitle={t('portal.todayNav')}
        breadcrumbs={[{ label: t('region.title'), to: '/region' }, { label: t('portal.todayNav') }]}
      >
        <RegionStorePicker query={regionStores} />
      </ListTemplate>
    );
  }

  const goDay = (next: string | null) => {
    const p = new URLSearchParams(searchParams);
    if (next === null) p.delete('date');
    else p.set('date', next);
    setSearchParams(p, { replace: true });
  };
  const isToday = date === ymdLocal();
  const isPast = date < ymdLocal();
  // The store's contracted windows (from the day payload): what an empty day is short of.
  const contracted = (data?.windowLeads ?? []).filter((w) => (w.targetCount ?? 0) > 0);
  const contractTotal = contracted.reduce((n, w) => n + (w.targetCount ?? 0), 0);
  const contractLine =
    contracted.length === 0
      ? null
      : t(isPast ? 'portal.contractGapPast' : 'portal.contractGap', {
          n: contractTotal,
          windows:
            contracted.length === 1
              ? contracted[0]!.label
              : contracted.map((w) => `${w.label} ${w.targetCount}`).join(', '),
        });
  const dayLabel = isToday
    ? t('portal.todayNav')
    : date === shiftDays(ymdLocal(), -1)
      ? t('portal.yesterday')
      : fmtDate(parseYmd(date));

  return (
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    <ListTemplate
        className={cn('mx-auto max-w-5xl space-y-4 print-area', switching && 'opacity-70 transition-opacity')}
        title={dayLabel}
        topbarTitle={t('portal.todayNav')}
        subtitle={
          data
            ? `${data.store ? data.store.name : data.client.name}${
                isToday ? ` · ${t('portal.asOf', { time: fmtTime(data.generatedAt) })}` : ''
              }`
            : undefined
        }
        // The trail is the way back to the store (the phone's Back too); the
        // "← My store" button beside it was a third control for the same trip.
        breadcrumbs={[{ label: isFloorLead ? t('floor.title') : isRegion ? t('region.title') : t('portal.title'), to: homeTo }, { label: t('portal.todayNav') }]}
        // One action list (PageHeader): on a phone everything sits behind one
        // "More" sheet; the row of Service report, CSV, Print and Full schedule
        // ran off a 390px screen (F500 G5).
        actions={[
          { key: 'report', label: t('portal.svcReport'), icon: FileText, onSelect: () => setReportOpen(true), hidden: isFloorLead },
          {
            key: 'schedule',
            label: t('portal.openSchedule'),
            icon: CalendarDays,
            to: isFloorLead ? '/scheduling' : `/portal/schedule${scope.toString() ? `?${scope.toString()}&` : '?'}week=${date}`,
            hidden: isFloorLead && !can('view:scheduling'),
          },
          {
            key: 'csv',
            label: 'CSV',
            icon: Download,
            disabled: !data || data.roster.length === 0,
            onSelect: () =>
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
              ]),
          },
          { key: 'print', label: t('portal.print'), icon: Printer, onSelect: () => window.print() },
        ]}
    >
      {!isFloorLead && <ServiceReportDialog open={reportOpen} onClose={() => setReportOpen(false)} scope={scope} initial={{ kind: 'day', date }} />}

      {/* ---- Date control: one row, above everything it scopes ---------- */}
      <div className="sticky top-0 z-10 -mx-4 flex items-center gap-2 bg-navy/95 px-4 py-2 backdrop-blur md:mx-0 md:px-0 print:hidden">
        <Button size="sm" variant="ghost" onClick={() => goDay(shiftDays(date, -1))} aria-label={t('portal.prevDay')}>
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        </Button>
        {/* One row on a phone: Today and the date; Yesterday joins from sm (the date wrapped under them). */}
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <Button size="sm" variant={isToday ? 'secondary' : 'ghost'} onClick={() => goDay(null)} className="shrink-0">
            {t('portal.todayNav')}
          </Button>
          <Button
            size="sm"
            variant={date === shiftDays(ymdLocal(), -1) ? 'secondary' : 'ghost'}
            onClick={() => goDay(shiftDays(ymdLocal(), -1))}
            className="hidden shrink-0 sm:inline-flex"
          >
            {t('portal.yesterday')}
          </Button>
          <label className="ml-1 flex min-w-0 flex-1 items-center gap-1.5 text-xs text-silver/70 sm:flex-none">
            <span className="sr-only">{t('portal.pickDate')}</span>
            <input
              type="date"
              value={date}
              onChange={(e) => e.target.value && goDay(e.target.value)}
              className="h-8 w-full min-w-0 rounded-md border border-navy-secondary bg-navy px-2 text-xs text-white coarse:h-11 coarse:text-base sm:w-auto"
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
        // The failure decides the words: a rule the request broke reads the
        // API's own sentence, not "Couldn't load your store view" (F500 G2).
        <QueryError what={t('portal.todayWhat')} query={query} />
      ) : !data ? (
        <div className="space-y-3">
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
      ) : (
        <>
          {(myWindows.length > 0 || waves.length > 0) && (
            <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
              {myWindows.length > 0 ? <FocusToggle windows={myWindows} focus={focus} onChange={setFocus} /> : <span />}
              {waves.length > 0 && (
                <SegmentedControl
                  className="hidden sm:inline-flex"
                  ariaLabel={t('portal.viewAria')}
                  value={crewView}
                  onChange={setCrewView}
                  options={[
                    { value: 'list', label: t('portal.viewList') },
                    { value: 'faces', label: t('portal.viewFaces') },
                  ]}
                />
              )}
            </div>
          )}
          {waves.length === 0 ? (
            <EmptyState
              icon={CalendarDays}
              title={mine ? t('focus.nothingToday') : isPast ? t('portal.noShiftsThatDay') : t('portal.noShiftsToday')}
              description={
                <>
                  {/* The contract the empty day is short of: "Nothing scheduled against your contracted 8 (Morning)". */}
                  {contractLine && (
                    <span className="block text-warning" data-testid="today-contract-gap">
                      {contractLine}
                    </span>
                  )}
                  {data.nextShift === undefined
                    ? null
                    : data.nextShift
                      ? t('portal.nextShiftAt', {
                          when: fmtShiftTz(data.nextShift.startsAt, data.nextShift.timezone),
                          position: data.nextShift.position,
                        })
                      : t('portal.noNextShift')}
                </>
              }
              action={
                <div className="flex flex-wrap justify-center gap-2 print:hidden">
                  {isPortal && (
                    <Button size="sm" asChild>
                      <Link
                        to={`/portal/requests?${new URLSearchParams([
                          ...scope.entries(),
                          ['new', 'STAFFING'],
                          ['subject', t('portal.coverageFor', { date: fmtDate(parseYmd(date)) })],
                        ]).toString()}`}
                      >
                        {t('portal.requestStaff')}
                      </Link>
                    </Button>
                  )}
                  {(!isFloorLead || can('view:scheduling')) && (
                    <Button size="sm" variant="outline" asChild>
                      <Link to={isFloorLead ? '/scheduling' : `/portal/schedule${scope.toString() ? `?${scope.toString()}&` : '?'}week=${date}`}>
                        {t('portal.openSchedule')}
                      </Link>
                    </Button>
                  )}
                </div>
              }
            />
          ) : (
            <>
              <DaySummary data={data} rows={focusRows} windows={mine ? myWindows : null} waves={waves.length} isToday={isToday} isPast={isPast} faces={faces} />
              {waves.map((w) => (
                <WaveCard
                  key={w.key}
                  wave={w}
                  faces={faces}
                  multiStore={multiStore}
                  focused={focusWave === w.startsAt}
                  window={waveWindow(w, data.windowLeads ?? [])}
                  // The shift supervisor reaches their crew from the wall:
                  // call, text, message — and one text to the whole wave.
                  canReach={user?.role === 'SHIFT_SUPERVISOR' && can('message:crew')}
                  floorLead={isFloorLead}
                />
              ))}
            </>
          )}
          {isToday && <OffScheduleCard data={data} windows={mine ? myWindows : null} faces={faces} />}
        </>
      )}
    </ListTemplate>
  );
}

/** The line above the waves — recounted over the shift in view. */
function DaySummary({
  data,
  rows,
  windows,
  waves,
  isToday,
  isPast,
  faces = false,
}: {
  data: DayPayload;
  rows: WaveRow[];
  windows: Parameters<typeof crewOnFloor>[2] | null;
  waves: number;
  isToday: boolean;
  isPast: boolean;
  faces?: boolean;
}) {
  const { t } = useI18n();
  const sum = windows ? summarize(rows) : data.summary;
  const record = isPast ? dayRecord(rows) : null;
  const onNow = data.onFloorNow
    ? (windows ? crewOnFloor(data.onFloorNow, data.roster, windows) : data.onFloorNow).length
    : sum.onFloor;
  return (
    <p className="text-sm text-silver tabular-nums">
      {isToday
        ? t('portal.todaySummary', { on: onNow, expected: sum.expected, waves })
        : isPast
          ? t('portal.daySummaryPast', {
              worked: sum.worked,
              expected: sum.expected,
              missed: sum.missed,
              open: sum.open,
            })
          : t('portal.daySummaryFuture', { expected: sum.expected, open: sum.open })}
      {/* A past day also says the hours and the late arrivals (counts, never names). */}
      {record && record.scheduledMin > 0 && (
        <>
          {' · '}
          {t('portal.dayHours', { worked: hoursOf(record.workedMin), scheduled: hoursOf(record.scheduledMin) })}
          {' · '}
          {t('portal.dayLate', { count: record.late, n: record.late })}
        </>
      )}
      {faces && <span className="hidden text-silver/50 sm:inline"> · {t('portal.faceHint')}</span>}
    </p>
  );
}

type WindowLead = NonNullable<DayPayload['windowLeads']>[number];

/** 12 → "12m", 75 → "1h 15m". */
function lateSpan(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/**
 * A past day's record from the roster: hours scheduled (every staffed
 * shift), hours worked (each completed punch), and how many punched in
 * more than the grace period after their start.
 */
export function dayRecord(rows: WaveRow[]): { scheduledMin: number; workedMin: number; late: number } {
  let scheduledMin = 0;
  let workedMin = 0;
  let late = 0;
  for (const r of rows) {
    if (r.state === 'open') continue;
    scheduledMin += Math.max(0, (Date.parse(r.endsAt) - Date.parse(r.startsAt)) / 60_000);
    if (r.clockInAt && r.clockOutAt) workedMin += Math.max(0, (Date.parse(r.clockOutAt) - Date.parse(r.clockInAt)) / 60_000);
    if (r.clockInAt && Date.parse(r.clockInAt) - Date.parse(r.startsAt) > LATE_GRACE_MINUTES * 60_000) late += 1;
  }
  return { scheduledMin, workedMin, late };
}

/** 450 → "7.5", 480 → "8". */
function hoursOf(minutes: number): string {
  const h = Math.round((minutes / 60) * 10) / 10;
  return Number.isInteger(h) ? String(h) : h.toFixed(1);
}

/** A region account picks the store whose day to read. */
function RegionStorePicker({ query }: { query: UseQueryResult<RegionOverview> }) {
  const { t } = useI18n();
  if (query.isError) return <QueryError what={t('portal.todayWhat')} query={query} />;
  if (!query.data) return <Skeleton className="h-40" />;
  const stores = query.data.stores;
  return (
    <Card>
      <CardContent>
        <SectionTitle size="sm" title={t('portal.pickStoreTitle')} description={stores.length ? t('portal.pickStoreHint') : undefined} />
        {stores.length === 0 ? (
          <p className="mt-2 text-sm text-silver/70">{t('portal.pickStoreNone')}</p>
        ) : (
          <ul className="mt-3 grid gap-2 sm:grid-cols-2" data-testid="region-store-picker">
            {stores.map((st) => (
              <li key={st.id}>
                <Link
                  to={`/today?locationId=${encodeURIComponent(st.id)}`}
                  className="flex items-center justify-between gap-3 rounded-md border border-navy-secondary px-3 py-2.5 hover:border-gold/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright coarse:min-h-11"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-ink">{st.name}</span>
                    <span className="block truncate text-xs text-silver/70">{st.clientName}</span>
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-silver">{t('portal.storeOnFloor', { n: st.now.onFloor })}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** The store shift window a wave starts in — its name and its leads. */
function waveWindow(w: Wave, windows: WindowLead[]): WindowLead | null {
  const row = [...w.clockedIn, ...w.worked, ...w.notIn, ...w.upcoming, ...w.open].find((r) => r.locationId);
  return row ? windowOf(row, windows) : null;
}

/* ---- Clocked in, but not on a scheduled shift -------------------------- */

/**
 * People on the floor right now whose punch isn't matched to an assigned
 * shift — a walk-in, someone covering a shift under another name, a shift
 * still in draft, or a person staying past their end. They count in "on
 * the floor now"; this is where they have a face.
 */
function OffScheduleCard({
  data,
  windows = null,
  faces = false,
}: {
  data: DayPayload;
  /** My shift: only the walk-ins who clocked in for it. */
  windows?: Parameters<typeof clockInInWindows>[1] | null;
  /** The optional face wall; rows (name · clocked in at · position) otherwise. */
  faces?: boolean;
}) {
  const { t } = useI18n();
  const [selected, setSelected] = useState<string | null>(null);
  const inShift = new Set(
    data.roster.filter((r) => r.state === 'on-floor' && r.associateId).map((r) => r.associateId!),
  );
  const people = (data.onFloorNow ?? []).filter(
    (e) => !inShift.has(e.associateId) && (!windows || clockInInWindows(e.clockInAt, windows)),
  );
  if (people.length === 0) return null;
  const tz = data.store?.timezone ?? data.roster[0]?.timezone ?? null;
  const caption = (e: (typeof people)[number]) =>
    `${e.name}${e.position ? ` · ${e.position}` : ''} · ${t('portal.clockedInAt', { time: fmtTimeTz(e.clockInAt, tz) })}`;
  const picked = people.find((e) => e.associateId === selected) ?? null;
  return (
    <Card className="border-success/30">
      <CardContent>
        <SectionTitle
          size="sm"
          className="mb-0"
          title={t('portal.offSchedule')}
          trailing={<span className="text-sm font-semibold tabular-nums text-ink">{people.length}</span>}
        />
        {!faces && (
          <ul className="mt-2 grid grid-cols-1 lg:grid-cols-2 lg:gap-x-6" data-testid="off-schedule-rows">
            {people.map((e) => (
              <li key={e.associateId} className="flex items-center gap-3 border-b border-navy-secondary/40 py-2">
                <Avatar src={photoUrl(e.associateId)} name={e.name} email="" size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-ink">{e.name}</div>
                  <div className="truncate text-xs">
                    <span className="text-success">{t('portal.rowIn', { time: fmtTimeTz(e.clockInAt, tz) })}</span>
                    {e.position && <span className="text-ink-muted"> · {e.position}</span>}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
        {faces && (
        <>
        <ul className="mt-3 flex flex-wrap gap-2" role="list">
          {people.map((e) => {
            const isSel = selected === e.associateId;
            return (
              <li key={e.associateId}>
                <button
                  type="button"
                  onClick={() => setSelected(isSel ? null : e.associateId)}
                  aria-pressed={isSel}
                  aria-label={caption(e)}
                  title={caption(e)}
                  className={cn(
                    'relative block rounded-full transition-transform focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
                    'coarse:active:scale-95',
                    isSel && 'scale-110',
                  )}
                >
                  <Avatar
                    src={photoUrl(e.associateId)}
                    name={e.name}
                    email=""
                    size="lg"
                    className={cn('ring-2 ring-offset-2 ring-offset-navy', isSel ? 'ring-gold' : 'ring-success')}
                  />
                  <span className="absolute -right-0.5 -top-0.5 inline-flex h-2.5 w-2.5 rounded-full bg-success ring-2 ring-navy" aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
        <div
          className={cn('mt-3 min-h-5 text-sm transition-opacity', picked ? 'text-white opacity-100' : 'opacity-0')}
          aria-live="polite"
        >
          {picked ? caption(picked) : ''}
        </div>
        </>
        )}
      </CardContent>
    </Card>
  );
}

/* ---- One wave: the headline, the meter, the face wall ------------------ */

type FaceTone = 'on-floor' | 'worked' | 'missing' | 'upcoming';

function WaveCard({
  wave: w,
  faces = false,
  multiStore,
  focused = false,
  window: win = null,
  canReach = false,
  floorLead = false,
}: {
  wave: Wave;
  /** The face wall from sm (an optional compact mode); rows at every width otherwise. */
  faces?: boolean;
  multiStore: boolean;
  focused?: boolean;
  /** The store's name for this shift and who leads it, when it has one. */
  window?: WindowLead | null;
  /** The shift supervisor: contact actions on a face, a text to the wave. */
  canReach?: boolean;
  /** The store's own supervisors: "Late 12m" on a row. The client portal reads punch times only. */
  floorLead?: boolean;
}) {
  const { t } = useI18n();
  const [selected, setSelected] = useState<WaveRow | null>(null);
  const [crewTextOpen, setCrewTextOpen] = useState(false);
  const crew = [...w.clockedIn, ...w.notIn, ...w.upcoming, ...w.worked].filter((r) => r.associateId);
  const range = fmtShiftRangeTz(w.startsAt, w.endsAt, w.timezone);
  const present = wavePresent(w);
  const short = w.phase === 'live' && w.clockedIn.length < w.expected;
  // A finished wave with a slot nobody filled says so on its line ("Worked · 0 of 0" hid it).
  const unfilledAfter = w.phase === 'finished' ? w.open.length : 0;
  const missedSome = w.phase === 'finished' && (present < w.expected || unfilledAfter > 0);
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

  // Names, not faces (role walk floor 20; F500 G2 at every width): one row
  // per person with what they're doing now and a call/text button, so
  // finding who is missing is a glance, not a tap per face. Two columns on
  // a wide screen; the face wall is the optional compact mode.
  const rowStatus = (r: WaveRow): { text: string; tone: 'good' | 'bad' | 'muted' } => {
    if (r.state === 'on-floor' && r.clockInAt) return { text: t('portal.rowIn', { time: fmtTimeTz(r.clockInAt, r.timezone) }), tone: 'good' };
    if (r.state === 'worked' && r.clockInAt)
      return {
        text: r.clockOutAt
          ? t('portal.punchRange', { in: fmtTimeTz(r.clockInAt, r.timezone), out: fmtTimeTz(r.clockOutAt, r.timezone) })
          : t('portal.rowIn', { time: fmtTimeTz(r.clockInAt, r.timezone) }),
        tone: 'muted',
      };
    if (r.state === 'missed') return { text: t('portal.faceNoPunch'), tone: 'bad' };
    if (r.state === 'not-in') {
      const late = Math.floor((Date.now() - Date.parse(r.startsAt)) / 60_000);
      return { text: floorLead && late > 0 ? t('portal.rowLate', { span: lateSpan(late) }) : t('portal.faceNotIn'), tone: 'bad' };
    }
    return { text: r.state === 'confirmed' ? t('portal.state.confirmed') : t('portal.state.unconfirmed'), tone: 'muted' };
  };
  const phoneRows = groups.flatMap((g) => g.rows);
  const phoneList = (
    <ul
      className={cn('grid grid-cols-1 lg:grid-cols-2 lg:gap-x-6', faces && 'sm:hidden')}
      aria-label={t('portal.rosterAria')}
      data-testid="roster-rows"
    >
      {phoneRows.map((r) => {
        const st = rowStatus(r);
        const tel = phoneHref(r.phone);
        return (
          <li key={r.shiftId} className="flex items-center gap-3 border-b border-navy-secondary/40 py-2">
            <Avatar src={r.associateId ? photoUrl(r.associateId) : null} name={r.name ?? ''} email="" size="sm" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-ink">
                {r.name ?? '—'}
                {r.isLead && <span className="ml-1.5 text-2xs font-semibold uppercase text-gold">{t('portal.leadTag')}</span>}
              </div>
              <div className="truncate text-xs">
                <span className={cn(st.tone === 'good' ? 'text-success' : st.tone === 'bad' ? 'text-alert' : 'text-ink-muted')}>{st.text}</span>
                <span className="text-ink-muted"> · {r.position}{multiStore && r.locationName ? ` · ${r.locationName}` : ''}</span>
              </div>
            </div>
            {canReach && r.phone && (
              <>
                <a
                  href={tel ?? `tel:${r.phone}`}
                  className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-navy-secondary text-silver active:bg-navy-secondary/50"
                  aria-label={t('portal.callX', { name: r.name ?? '' })}
                >
                  <Phone className="h-4 w-4" aria-hidden="true" />
                </a>
                <a
                  href={`sms:${r.phone}`}
                  className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-navy-secondary text-silver active:bg-navy-secondary/50"
                  aria-label={t('portal.textX', { name: r.name ?? '' })}
                >
                  <MessageSquareText className="h-4 w-4" aria-hidden="true" />
                </a>
              </>
            )}
            {canReach && r.messageUserId && (
              <Link
                to={`/messages?to=${r.messageUserId}`}
                className="hidden h-11 w-11 shrink-0 place-items-center rounded-full border border-navy-secondary text-silver hover:text-ink sm:grid"
                aria-label={`${t('portal.message')} · ${r.name ?? ''}`}
              >
                <MessageSquare className="h-4 w-4" aria-hidden="true" />
              </Link>
            )}
          </li>
        );
      })}
    </ul>
  );

  const body = (
    <div className="space-y-4">
      {phoneList}
      {faces && (
      <div className="hidden space-y-4 sm:block">
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
      </div>
      )}
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
          'hidden min-h-5 text-sm transition-opacity sm:block',
          selected ? 'text-white opacity-100' : 'text-silver/40 opacity-0',
        )}
        aria-live="polite"
      >
        {selected ? caption(selected) : ''}
      </div>
      {faces && canReach && selected?.associateId && (
        <div className="hidden flex-wrap gap-2 sm:flex" data-testid="face-reach">
          {selected.phone && (
            <Button size="sm" variant="outline" asChild>
              <a href={`tel:${selected.phone}`}>
                <Phone className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                {t('portal.call')}
              </a>
            </Button>
          )}
          {selected.phone && (
            <Button size="sm" variant="outline" asChild>
              <a href={`sms:${selected.phone}`}>
                <MessageSquareText className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                {t('portal.text')}
              </a>
            </Button>
          )}
          {selected.messageUserId && (
            <Button size="sm" variant="outline" asChild>
              <Link to={`/messages?to=${selected.messageUserId}`}>
                <MessageSquare className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                {t('portal.message')}
              </Link>
            </Button>
          )}
        </div>
      )}
      {canReach && crew.length > 0 && w.phase !== 'finished' && (
        <>
          <CrewTextDialog
            open={crewTextOpen}
            onOpenChange={setCrewTextOpen}
            shiftIds={crew.map((r) => r.shiftId)}
            label={`${win ? win.label : t(WAVE_KEY[waveName(w.startsAt, w.timezone)])} · ${range}`}
            count={crew.length}
          />
        </>
      )}
    </div>
  );

  const header = (
    <SectionTitle
      size="sm"
      wrap
      className="mb-0"
      title={
        <span className={w.phase === 'finished' ? 'text-silver' : undefined}>
          <span className="text-gold">{win ? win.label : t(WAVE_KEY[waveName(w.startsAt, w.timezone)])}</span> · {range}
          {w.phase === 'live' && (
            <span className="ml-2 text-2xs font-medium uppercase tracking-wider text-success">{t('portal.live')}</span>
          )}
          {win && win.leads.length > 0 && (
            <span className="mt-0.5 block text-xs font-normal text-silver/70">
              {t('portal.waveLead', { names: win.leads.join(', ') })}
            </span>
          )}
        </span>
      }
      trailing={
        <span className="flex items-center gap-2">
          {/* One text to everyone on this shift, from its header (floor 20). */}
          {canReach && crew.length > 0 && w.phase !== 'finished' && (
            <Button size="sm" variant="outline" className="h-8 print:hidden" onClick={() => setCrewTextOpen(true)}>
              <MessageSquareText className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              {t('portal.textShift', { n: crew.length })}
            </Button>
          )}
          <span
            className={cn(
              'text-sm font-semibold tabular-nums',
              short ? 'text-warning' : missedSome ? 'text-alert' : w.phase === 'finished' ? 'text-silver/70' : 'text-white',
            )}
          >
            {headline}
          </span>
          {unfilledAfter > 0 && (
            <span className="text-sm font-semibold tabular-nums text-alert" data-testid="wave-unfilled">
              {t('portal.waveUnfilled', { count: unfilledAfter })}
            </span>
          )}
        </span>
      }
    />
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
      <CardContent>
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
