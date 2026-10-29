import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  AlarmClock,
  AlertTriangle,
  Ban,
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleSlash,
  ClipboardCheck,
  ClipboardX,
  Download,
  FileWarning,
  ImageOff,
  Moon,
  Printer,
  ShieldCheck,
  Thermometer,
  Wrench,
  type LucideIcon,
} from '@/components/ui/icons';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { useI18n, type MessageKey, type Translate } from '@/lib/i18n';
import { useMinWidth } from '@/lib/useViewport';
import { downloadCsv } from '@/lib/csv';
import { fmtDate, fmtTimeTz, parseYmd, ymdLocal } from '@/lib/format';
import { metricLabel } from '@/lib/opsApi';
import {
  getStoreOps,
  storeOpsPhotoUrl,
  type AttentionKind,
  type BlockState,
  type StoreOpsAttention,
  type StoreOpsDay,
  type StoreOpsRun,
  type StoreOpsTemp,
} from '@/lib/storeOpsApi';
import { Badge } from '@/components/ui/Badge';
import { DateField } from '@/components/ui/DateField';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryError } from '@/components/ui/QueryError';
import { AsOf } from '@/components/ui/AsOf';
import { FilterSheet } from '@/components/FilterSheet';
import { Select } from '@/components/ui/Select';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Skeleton } from '@/components/ui/Skeleton';
import { DEPT_FALLBACK_ICON, DEPT_ICON, DEPT_TONE, HANDOVER_KIND_ICON } from '../ops/opsVisuals';
import { ListTemplate } from '@/components/templates';
import { scopeParams, shiftDays } from './scope';
import '@/lib/i18n/en/portal';
import '@/lib/i18n/en/portalOps';

/**
 * Store operations — the store manager's (and their team leads') read of
 * every department's SOP, without opening a checklist.
 *
 * What a Walmart store manager wants at 7 AM, in this order:
 *   1. Is anything wrong right now? — the verdict and "Needs you now":
 *      a cooler out of range and not re-checked, a block past its due
 *      time, a shift whose SOP never started, equipment down.
 *   2. Did every department do its SOP, every shift? — the grid.
 *   3. Is the food safe? — the temperature log, downloadable for an
 *      inspector.
 *   4. What did the freight crews get done? — trucks, cases, picks,
 *      overstock, claims, discards, donations.
 *   5. What did each shift hand the next? — handoffs, and whether they
 *      were taken.
 * Tap any department's shift for its block-by-block timeline and the
 * final-zone photo.
 */

const KIND_ICON: Record<AttentionKind, LucideIcon> = {
  TEMP: Thermometer,
  EQUIPMENT: Wrench,
  NOT_STARTED: CircleSlash,
  NOT_SUBMITTED: ClipboardX,
  OVERDUE: AlarmClock,
  BLOCKED: Ban,
  COMPLIANCE: AlertTriangle,
  INCOMPLETE: FileWarning,
};
const kindLabel = (t: Translate, k: AttentionKind) => t(`portalOps.kind.${k}` as MessageKey);
const blockLabel = (t: Translate, b: BlockState) => t(`portalOps.block.${b}` as MessageKey);

const HANDOFF_VARIANT: Record<string, 'pending' | 'success' | 'default'> = {
  PENDING: 'pending',
  CARRIED: 'success',
  REVIEWED: 'success',
  DISMISSED: 'default',
};
const handoffLabel = (t: Translate, status: string) =>
  HANDOFF_VARIANT[status] ? t(`portalOps.handoff.${status}` as MessageKey) : status;
const handoverKindLabel = (t: Translate, kind: string) => t(`portalOps.handoverKind.${kind}` as MessageKey);
/** One period vocabulary on the page: Morning, Evening, Closing, Overnight. */
const periodLabel = (t: Translate, p: string) =>
  ['MORNING', 'EVENING', 'CLOSING', 'OVERNIGHT'].includes(p) ? t(`portalOps.period.${p}` as MessageKey) : p;
/** The store window's name after the period — only when it says something
 *  the period doesn't ("Overnight · Swing"), never "Morning · Morning". */
export const windowSuffix = (t: Translate, period: string, windowLabel: string | null | undefined): string => {
  const w = windowLabel?.trim();
  if (!w) return '';
  const same = (x: string) => x.trim().toLowerCase() === w.toLowerCase();
  return same(period) || same(periodLabel(t, period)) ? '' : ` · ${w}`;
};

/** /portal/ops — the store manager's page (and an admin's preview). */
export function PortalOps() {
  const { t } = useI18n();
  const { user, can } = useAuth();
  const [searchParams] = useSearchParams();
  const isPortal = user?.role === 'CLIENT_PORTAL';
  const canPreview = can('view:executive') || can('manage:org');
  const previewId = searchParams.get('clientId');
  const scope = scopeParams(searchParams, isPortal);
  const scopeQs = scope.toString() ? `?${scope.toString()}` : '';

  if (!isPortal && !canPreview) {
    return <EmptyState icon={ClipboardCheck} title={t('portalOps.noAccess')} description="" />;
  }
  if (!isPortal && !previewId) {
    return <EmptyState icon={ClipboardCheck} title={t('portalOps.title')} description={t('portalOps.pickClient')} />;
  }
  return (
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    <ListTemplate
        className="mx-auto max-w-6xl print-area"
        title={t('portalOps.title')}
        // "Checklist" — the word a client uses; "SOP" is the floor's (F500 G5).
        subtitle={t('portalOps.subtitle')}
        // The trail is the way back to the store (the phone's Back too); the
        // "← My store" button beside it was a third control for the same trip.
        breadcrumbs={[{ label: t('portal.homeCrumb'), to: `/portal${scopeQs}` }, { label: t('portalOps.title') }]}
    >
      <StoreOps />
    </ListTemplate>
  );
}

/**
 * The page body — also the team leads' "Store today" tab in Store Ops. The
 * date lives in ?date= so a link to last Tuesday opens on last Tuesday.
 */
export function StoreOps() {
  const { t } = useI18n();
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const isPortal = user?.role === 'CLIENT_PORTAL';
  const scope = scopeParams(searchParams, isPortal);
  const scopeQs = scope.toString() ? `?${scope.toString()}` : '';
  // No ?date= is the STORE's today, which the server answers with: at
  // 11:30 PM Pacific a Chicago store is already on tomorrow, and the
  // browser's day opened its manager on yesterday (LEAD-17).
  const dateParam = searchParams.get('date');
  // The two narrowings a store manager actually asks for. "What happened
  // overnight" is a filter on this page, not a different page.
  const period = searchParams.get('period') ?? '';
  const department = searchParams.get('department') ?? '';
  const qs = `?${new URLSearchParams([
    ...scope.entries(),
    ...(dateParam ? ([['date', dateParam]] as [string, string][]) : []),
    ...(period ? ([['period', period]] as [string, string][]) : []),
    ...(department ? ([['department', department]] as [string, string][]) : []),
  ]).toString()}`;
  const query = useQuery({
    queryKey: ['clientPortal', 'ops', qs],
    queryFn: () => getStoreOps(qs),
    refetchInterval: (q) => (!dateParam || q.state.data?.date === q.state.data?.storeToday ? 60_000 : false),
    refetchOnWindowFocus: true,
    placeholderData: (prev) => prev,
  });
  const data = query.data;
  const storeToday = data?.storeToday ?? ymdLocal();
  const date = dateParam ?? (query.isPlaceholderData ? storeToday : data?.date ?? storeToday);
  const isToday = date === storeToday;
  const switching = query.isPlaceholderData;
  const [openRun, setOpenRun] = useState<string | null>(null);

  const goDay = (next: string | null) => {
    const p = new URLSearchParams(searchParams);
    if (next === null) p.delete('date');
    else p.set('date', next);
    setSearchParams(p, { replace: true });
  };
  const setFilter = (key: 'period' | 'department', value: string) => {
    const p = new URLSearchParams(searchParams);
    if (value) p.set(key, value);
    else p.delete(key);
    setSearchParams(p, { replace: true });
  };
  /** "Last night" is one button: yesterday, narrowed to the overnight. */
  const goLastNight = () => {
    const p = new URLSearchParams(searchParams);
    p.set('date', shiftDays(storeToday, -1));
    p.set('period', 'OVERNIGHT');
    setSearchParams(p, { replace: true });
  };
  const clearFilters = () => {
    const p = new URLSearchParams(searchParams);
    p.delete('period');
    p.delete('department');
    p.delete('date');
    setSearchParams(p, { replace: true });
  };
  const lastNightOn = date === shiftDays(storeToday, -1) && period === 'OVERNIGHT';

  const run = data?.runs.find((r) => r.id === openRun) ?? null;
  return (
    <div className={cn('space-y-4', switching && 'opacity-70 transition-opacity')}>
      <DateBar
        date={date}
        today={storeToday}
        onDate={goDay}
        data={data}
        period={period}
        department={department}
        onFilter={setFilter}
        onLastNight={goLastNight}
        onClear={clearFilters}
        lastNightOn={lastNightOn}
        updatedAt={query.dataUpdatedAt}
        refreshing={query.isFetching}
        onRefresh={() => void query.refetch()}
      />
      {query.error ? (
        <QueryError what={t('portalOps.title')} query={query} />
      ) : !data ? (
        <div className="space-y-3">
          <Skeleton className="h-36 w-full" />
          <Skeleton className="h-56 w-full" />
        </div>
      ) : (
        <>
          <Verdict data={data} isToday={isToday} onOpen={setOpenRun} />
          <OnTheFloorNow data={data} onOpen={setOpenRun} />
          <DepartmentGrid data={data} onOpen={setOpenRun} />
          <FromTheFloor data={data} scopeQs={scopeQs} onOpen={setOpenRun} />
          {/* minmax(0, …) tracks: a truncating title set the column's
              min-content width and pushed the card 74px off a phone (LEAD-11). */}
          <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <FoodSafety data={data} />
            <Production data={data} />
          </div>
          <Handoffs data={data} />
        </>
      )}
      {run && data && (
        <RunDialog run={run} data={data} scopeQs={scopeQs} onClose={() => setOpenRun(null)} />
      )}
    </div>
  );
}


/* ----- on the floor now -------------------------------------------------- */

/**
 * What is happening in the store AT THIS MOMENT.
 *
 * The page could tell a manager how their day finished and not who was
 * standing in the building. A shift that opened at 22:00 and is still
 * running at 06:00 is the most current thing on the page, and it was the
 * one thing the day view could not show.
 */
function OnTheFloorNow({ data, onOpen }: { data: StoreOpsDay; onOpen: (id: string) => void }) {
  const { t } = useI18n();
  const live = data.live ?? [];
  if (live.length === 0) return null;
  return (
    <Card>
      <CardContent>
        <SectionTitle
          size="sm"
          className="mb-0"
          title={
            <span className="flex items-center gap-2">
              <span className="relative flex h-2 w-2" aria-hidden="true">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-70" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
              </span>
              {t('portalOps.onFloorNow')}
              <span className="text-xs font-normal text-silver/60">{t('portalOps.shiftsRunning', { count: live.length })}</span>
            </span>
          }
        />
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {live.map((l) => {
            const pct = l.total > 0 ? Math.round((l.done / l.total) * 100) : null;
            return (
              <li key={l.id}>
                <button
                  type="button"
                  onClick={() => onOpen(l.id)}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
                    l.overdueItems > 0
                      ? 'border-warning/50 bg-warning/[0.06]'
                      : 'border-navy-secondary hover:border-gold/30',
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-white">
                      {l.department}
                      <span className="ml-1.5 text-xs text-gold">{periodLabel(t, l.period).toLowerCase()}</span>
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-silver/70">
                      {t('portalOps.startedBy', { name: l.runBy, time: fmtTimeTz(l.openedAt, data.tz) })}
                      {l.dueAt && ` · ${t('portalOps.dueAt', { time: fmtTimeTz(l.dueAt, data.tz) })}`}
                    </span>
                    {l.current?.section && (
                      <span className="mt-0.5 block truncate text-xs text-silver/60">
                        {t('portalOps.onSection', { section: l.current.section, count: l.current.open })}
                      </span>
                    )}
                    {l.overdueItems > 0 && (
                      <span className="mt-0.5 block text-xs text-warning">{t('portalOps.itemsPastDue', { count: l.overdueItems })}</span>
                    )}
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block text-lg font-semibold tabular-nums text-white">
                      {pct === null ? '—' : `${pct}%`}
                    </span>
                    <span className="block text-2xs tabular-nums text-silver/60">
                      {l.done}/{l.total}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

/* ----- the photographs --------------------------------------------------- */

/**
 * From the floor.
 *
 * The page counted photographs — "14 photos on record" — and showed none
 * of them. The whole point of asking a supervisor to photograph a faced
 * aisle or a cooler probe is that somebody can LOOK at it, and the person
 * who most needs to look is the store manager who was not there.
 */
function FromTheFloor({
  data,
  scopeQs,
  onOpen,
}: {
  data: StoreOpsDay;
  scopeQs: string;
  onOpen: (id: string) => void;
}) {
  const { t } = useI18n();
  const photos = data.photos ?? [];
  return (
    <Card>
      <CardContent>
        <SectionTitle
          size="sm"
          className="mb-0"
          icon={Camera}
          title={t('portalOps.fromTheFloor')}
          trailing={
            <span className="text-xs text-silver/60 tabular-nums">
              {photos.length === 0 ? t('portalOps.noPhotos') : t('portalOps.photos', { count: photos.length })}
            </span>
          }
        />
        {photos.length === 0 ? (
          // It stays on the page when empty: a card that disappears is a
          // card nobody learns exists, and "no photos" is itself a finding.
          <p className="mt-3 text-sm text-silver/70">
            {data.date === data.storeToday ? t('portalOps.photosEmptyToday') : t('portalOps.photosEmptyDay')}
          </p>
        ) : (
          <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {photos.map((ph) => (
              <li key={ph.id} className="group">
                <a
                  href={storeOpsPhotoUrl(ph.id, scopeQs)}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={t('portalOps.photoOpen', {
                    what: [ph.title, ph.department, ph.period ? periodLabel(t, ph.period).toLowerCase() : null].filter(Boolean).join(', '),
                    time: fmtTimeTz(ph.at, data.tz),
                  })}
                  className="block overflow-hidden rounded-lg border border-navy-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
                >
                  <OpsPhoto
                    src={storeOpsPhotoUrl(ph.id, scopeQs)}
                    alt={ph.title}
                    className="aspect-[4/3] w-full object-cover transition-transform group-hover:scale-[1.03]"
                  />
                </a>
                <div className="mt-1.5 min-w-0">
                  <button
                    type="button"
                    onClick={() => onOpen(ph.shiftId)}
                    className="block max-w-full truncate text-left text-xs font-medium text-white hover:text-gold hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright coarse:min-h-11"
                    aria-label={t('portalOps.photoShift', { dept: ph.department ?? t('portalOps.thisShift') })}
                  >
                    {ph.title}
                  </button>
                  <div className="truncate text-2xs text-silver/60">
                    {[ph.department, ph.period ? periodLabel(t, ph.period).toLowerCase() : null].filter(Boolean).join(' · ')}
                  </div>
                  <div className="text-2xs tabular-nums text-silver/50">
                    {fmtTimeTz(ph.at, data.tz)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * A floor photo, or — when its file is gone — a quiet "Photo unavailable"
 * tile instead of the browser's broken-image box with the alt text wrapped
 * across it (LEAD-19).
 */
export function OpsPhoto({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span
        role="img"
        aria-label={`${alt} — ${t('portalOps.photoUnavailable')}`}
        className={cn(className, 'flex flex-col items-center justify-center gap-1 bg-navy-secondary/40 text-silver/60')}
        data-testid="ops-photo-unavailable"
      >
        <ImageOff className="h-5 w-5" aria-hidden="true" />
        <span className="text-2xs">{t('portalOps.photoUnavailable')}</span>
      </span>
    );
  }
  return <img src={src} alt={alt} loading="lazy" className={className} onError={() => setFailed(true)} />;
}

/* ----- date bar ---------------------------------------------------------- */

/**
 * The day and its filters. On a phone the first row is the day only —
 * previous · Today · last night · the date · next — and the shift and
 * department filters (with Clear) sit behind one "Filters" chip; the row
 * used to hold all eight controls and ran 135px off a 390px screen
 * ("Last nigh", "All shif", the next-day arrow out of reach — F500 G5).
 */
function DateBar({
  date,
  today,
  onDate,
  data,
  period,
  department,
  onFilter,
  onLastNight,
  onClear,
  lastNightOn,
  updatedAt,
  refreshing,
  onRefresh,
}: {
  date: string;
  /** The store's today (the server's), not the browser's. */
  today: string;
  onDate: (d: string | null) => void;
  data?: StoreOpsDay;
  period: string;
  department: string;
  onFilter: (key: 'period' | 'department', value: string) => void;
  onLastNight: () => void;
  onClear: () => void;
  lastNightOn: boolean;
  updatedAt?: number;
  refreshing?: boolean;
  onRefresh?: () => void;
}) {
  const { t } = useI18n();
  const wide = useMinWidth(640);
  const [sheetOpen, setSheetOpen] = useState(false);
  const yesterday = shiftDays(today, -1);
  const narrowed = period !== '' || department !== '' || date !== today;
  const filterCount = (period ? 1 : 0) + (department ? 1 : 0);
  const filters = (
    <>
      <Select
        size="sm"
        value={period}
        onChange={(e) => onFilter('period', e.target.value)}
        aria-label={t('portalOps.filterShift')}
        className="w-full sm:w-auto print:hidden"
      >
        <option value="">{t('portalOps.allShifts')}</option>
        {(['MORNING', 'EVENING', 'CLOSING', 'OVERNIGHT'] as const).map((p) => (
          <option key={p} value={p}>
            {periodLabel(t, p)}
          </option>
        ))}
      </Select>
      {(data?.departments?.length ?? 0) > 1 && (
        <Select
          size="sm"
          value={department}
          onChange={(e) => onFilter('department', e.target.value)}
          aria-label={t('portalOps.filterDept')}
          className="w-full sm:w-auto sm:max-w-[10rem] print:hidden"
        >
          <option value="">{t('portalOps.allDepts')}</option>
          {data!.departments.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </Select>
      )}
    </>
  );
  return (
    <div className="sticky top-0 z-10 -mx-4 space-y-2 bg-navy/95 px-4 py-2 backdrop-blur md:mx-0 md:px-0 print:static" data-testid="ops-date-bar">
      <div className="flex items-center gap-1 sm:gap-2">
        <Button size="sm" variant="ghost" onClick={() => onDate(shiftDays(date, -1))} aria-label={t('portalOps.prevDay')} className="shrink-0 print:hidden">
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        </Button>
        <Button size="sm" variant={date === today ? 'secondary' : 'ghost'} onClick={() => onDate(null)} className="shrink-0 print:hidden">
          {t('portalOps.today')}
        </Button>
        <Button
          size="sm"
          variant={date === yesterday && !lastNightOn ? 'secondary' : 'ghost'}
          onClick={() => onDate(yesterday)}
          className="hidden shrink-0 sm:inline-flex print:hidden"
        >
          {t('portalOps.yesterday')}
        </Button>
        {/* The question this page is asked most: what happened overnight.
            One button, rather than a date and a filter and a guess — the
            moon alone on a phone, with its name for a screen reader. */}
        <Button
          size="sm"
          variant={lastNightOn ? 'secondary' : 'ghost'}
          onClick={onLastNight}
          aria-label={t('portalOps.lastNight')}
          className="shrink-0 print:hidden"
        >
          <Moon className="h-3.5 w-3.5 sm:mr-1" aria-hidden="true" />
          <span className="hidden sm:inline">{t('portalOps.lastNight')}</span>
        </Button>
        <DateField
          size="sm"
          clearable={false}
          value={date}
          max={today}
          onChange={(v) => v && onDate(v)}
          className="min-w-0 flex-1 print:hidden sm:flex-none"
          aria-label={t('portalOps.pickDate')}
        />
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onDate(shiftDays(date, 1))}
          aria-label={t('portalOps.nextDay')}
          disabled={date >= today}
          className="shrink-0 print:hidden"
        >
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </Button>
        {wide && <div className="flex items-center gap-2 print:hidden">{filters}</div>}
        {narrowed && wide && (
          <Button size="sm" variant="ghost" onClick={onClear} className="shrink-0 print:hidden">
            {t('portalOps.clear')}
          </Button>
        )}
        <span className="ml-auto hidden text-xs text-silver lg:inline">
          {[data?.scope.location?.name ?? data?.scope.client.name, fmtDate(parseYmd(date))].filter(Boolean).join(' · ')}
        </span>
        <Button size="sm" variant="outline" className="hidden shrink-0 print:hidden sm:inline-flex" onClick={() => window.print()}>
          <Printer className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          {t('portalOps.print')}
        </Button>
      </div>
      {(!wide || date === today) && (
        <div className="flex flex-wrap items-center gap-2 print:hidden">
          {!wide && (
            <FilterSheet
              mobile
              open={sheetOpen}
              onOpenChange={setSheetOpen}
              activeCount={filterCount}
              onClear={() => {
                onClear();
                setSheetOpen(false);
              }}
              description={t('portalOps.filtersHint')}
              testId="ops-filters"
            >
              {filters}
            </FilterSheet>
          )}
          {!wide && narrowed && filterCount === 0 && (
            <Button size="sm" variant="ghost" onClick={onClear}>
              {t('portalOps.clear')}
            </Button>
          )}
          {/* A page that polls every minute owes its reader the minute. */}
          {date === today && <AsOf at={updatedAt} refreshing={refreshing} onRefresh={onRefresh} className="ml-auto" />}
        </div>
      )}
    </div>
  );
}

/* ----- the verdict + what needs you now --------------------------------- */

function Verdict({ data, isToday, onOpen }: { data: StoreOpsDay; isToday: boolean; onOpen: (id: string) => void }) {
  const { t } = useI18n();
  const s = data.summary;
  const urgent = data.attention.filter((a) => a.severity === 'high');
  const noRuns = s.sops === 0 && s.notStarted === 0;
  // "On track" never sits over a checklist that closed short or was never
  // submitted (LEAD-27): those are findings, not a track being kept.
  const findings = data.attention.some((a) => a.kind === 'INCOMPLETE' || a.kind === 'NOT_SUBMITTED');
  const tone = urgent.length > 0 ? 'alert' : data.attention.length > 0 ? 'warning' : noRuns ? 'quiet' : 'success';
  // A past day is the record, not a call to act: "needed attention", never "needs you now".
  const headline =
    urgent.length > 0
      ? isToday
        ? t('portalOps.needsNow', { count: urgent.length })
        : t('portalOps.neededPast', { count: urgent.length })
      : data.attention.length > 0
        ? isToday && !findings
          ? t('portalOps.toReview', { count: data.attention.length })
          : t('portalOps.toReviewPast', { count: data.attention.length })
        : noRuns
          ? isToday
            ? t('portalOps.noneYetToday')
            : t('portalOps.noneThatDay')
          : isToday
            ? t('portalOps.allOnTrack')
            : t('portalOps.allDone');
  // No reading taken is not "all in range" (it read "Temperatures 0 · all in range").
  const noReadings = s.tempChecks === 0 && !s.tempOpen && !s.tempsDue;
  return (
    <Card
      className={cn(
        'overflow-hidden',
        tone === 'alert' && 'border-alert/50',
        tone === 'warning' && 'border-warning/40',
        tone === 'success' && 'border-success/40',
      )}
    >
      <div
        className={cn(
          'flex items-center gap-3 px-5 py-4',
          tone === 'alert' && 'bg-alert/[0.08]',
          tone === 'warning' && 'bg-warning/[0.06]',
          tone === 'success' && 'bg-success/[0.07]',
        )}
      >
        <span
          className={cn(
            'grid h-10 w-10 shrink-0 place-items-center rounded-full',
            tone === 'alert' && 'bg-alert/15 text-alert',
            tone === 'warning' && 'bg-warning/15 text-warning',
            tone === 'success' && 'bg-success/15 text-success',
            tone === 'quiet' && 'bg-navy-secondary text-silver',
          )}
          aria-hidden="true"
        >
          {tone === 'alert' ? <AlertTriangle className="h-5 w-5" /> : tone === 'success' ? <ShieldCheck className="h-5 w-5" /> : <ClipboardCheck className="h-5 w-5" />}
        </span>
        <div className="min-w-0">
          <div className="text-lg font-semibold text-white">{headline}</div>
          <div className="text-xs text-silver">
            {data.scope.location?.name ?? data.scope.client.name} · {fmtDate(parseYmd(data.date))}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-px bg-navy-secondary/60 sm:grid-cols-4">
        <Kpi
          label={t('portalOps.kpiSubmitted')}
          value={s.sops + s.notStarted > 0 ? `${s.submitted}/${s.sops + s.notStarted}` : '—'}
          sub={
            [
              s.running ? t('portalOps.running', { count: s.running }) : null,
              s.expired ? t('portalOps.neverSubmitted', { count: s.expired }) : null,
              s.notStarted ? t('portalOps.notStarted', { count: s.notStarted }) : null,
            ]
              .filter(Boolean)
              .join(' · ') || t('portalOps.nothingOpen')
          }
          subTone={s.notStarted > 0 || (s.expired ?? 0) > 0 ? 'alert' : undefined}
        />
        <Kpi
          label={t('portalOps.kpiOnTime')}
          value={s.onTimePct !== null ? `${s.onTimePct}%` : '—'}
          sub={s.overdueBlocks ? t('portalOps.blocksOverdue', { count: s.overdueBlocks }) : t('portalOps.doneByDue')}
          tone={s.onTimePct === null ? undefined : s.onTimePct >= 90 ? 'success' : s.onTimePct < 75 ? 'alert' : undefined}
          subTone={s.overdueBlocks > 0 ? 'alert' : undefined}
        />
        <Kpi
          label={t('portalOps.kpiTemps')}
          value={noReadings ? '—' : String(s.tempChecks)}
          sub={
            noReadings
              ? isToday
                ? t('portalOps.noReadings')
                : t('portalOps.noReadingsDay')
              : s.tempOpen
                ? t('portalOps.outOfRange', { count: s.tempOpen })
                : s.tempsDue
                  ? t('portalOps.tempsMissed', { count: s.tempsDue })
                  : s.tempAlerts
                    ? t('portalOps.corrected', { count: s.tempAlerts })
                    : t('portalOps.allInRange')
          }
          subTone={s.tempOpen || s.tempsDue ? 'alert' : s.tempChecks ? 'success' : undefined}
        />
        <Kpi
          label={t('portalOps.kpiChecklist')}
          value={s.completionPct !== null ? `${s.completionPct}%` : '—'}
          sub={t('portalOps.photosOnRecord', { count: s.photos })}
        />
      </div>
      {data.attention.length > 0 && (
        <ul className="divide-y divide-navy-secondary/60 border-t border-navy-secondary/60" aria-label={t('portalOps.needsAttention')}>
          {data.attention.map((a, i) => (
            <AttentionRow key={`${a.kind}-${a.shiftId}-${i}`} item={a} tz={data.tz} onOpen={onOpen} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function Kpi({
  label,
  value,
  sub,
  tone,
  subTone,
}: {
  label: string;
  value: string;
  sub: string;
  tone?: 'alert' | 'success';
  subTone?: 'alert' | 'success';
}) {
  return (
    <div className="bg-navy px-4 py-3">
      <div className="text-2xs uppercase tracking-wider text-silver/70">{label}</div>
      <div
        className={cn(
          'mt-0.5 text-2xl font-semibold tabular-nums',
          tone === 'alert' ? 'text-alert' : tone === 'success' ? 'text-success' : 'text-white',
        )}
      >
        {value}
      </div>
      <div
        className={cn(
          'truncate text-xs',
          subTone === 'alert' ? 'font-medium text-alert' : subTone === 'success' ? 'text-success' : 'text-silver',
        )}
      >
        {sub}
      </div>
    </div>
  );
}

function AttentionRow({ item, tz, onOpen }: { item: StoreOpsAttention; tz: string; onOpen: (id: string) => void }) {
  const { t } = useI18n();
  const Icon = KIND_ICON[item.kind];
  const body = (
    <>
      <span
        className={cn(
          'mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full',
          item.severity === 'high' ? 'bg-alert/15 text-alert' : 'bg-warning/15 text-warning',
        )}
        aria-hidden="true"
      >
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-white">{item.title}</span>
        <span className="block text-xs text-silver">
          <span className={item.severity === 'high' ? 'text-alert' : 'text-warning'}>{kindLabel(t, item.kind)}</span>
          {' · '}
          {item.department} · {periodLabel(t, item.period)}
          {item.at ? ` · ${fmtTimeTz(item.at, tz)}` : ''}
        </span>
        {item.detail && <span className="mt-0.5 block text-xs text-silver/80">{item.detail}</span>}
      </span>
      {item.shiftId && <ChevronRight className="mt-2 h-4 w-4 shrink-0 text-silver/60" aria-hidden="true" />}
    </>
  );
  return (
    <li>
      {item.shiftId ? (
        <button
          type="button"
          onClick={() => onOpen(item.shiftId!)}
          className="flex w-full items-start gap-3 px-5 py-3 text-left transition-colors hover:bg-navy-secondary/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gold-bright"
        >
          {body}
        </button>
      ) : (
        <div className="flex items-start gap-3 px-5 py-3">{body}</div>
      )}
    </li>
  );
}

/* ----- department × shift ------------------------------------------------ */

function DepartmentGrid({ data, onOpen }: { data: StoreOpsDay; onOpen: (id: string) => void }) {
  const { t } = useI18n();
  const runs = useMemo(() => new Map(data.runs.map((r) => [r.id, r])), [data.runs]);
  if (data.grid.length === 0) {
    return (
      <Card>
        <CardContent className="py-8">
          <EmptyState
            icon={ClipboardCheck}
            title={t('portalOps.noDeptChecklists')}
            description={t('portalOps.noDeptChecklistsHint')}
          />
        </CardContent>
      </Card>
    );
  }
  const cols = data.periods.length;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{t('portalOps.deptsByShift')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {data.grid.map((row) => {
          const Icon = DEPT_ICON[row.department] ?? DEPT_FALLBACK_ICON;
          return (
            <div key={row.department} className="rounded-lg border border-navy-secondary/70 p-3">
              <div className="mb-2 flex items-center gap-2 text-sm font-medium text-white">
                <Icon className={cn('h-4 w-4', DEPT_TONE[row.department] ?? 'text-gold')} aria-hidden="true" />
                {row.department}
              </div>
              <div className={cn('grid gap-2', cols >= 3 ? 'sm:grid-cols-3' : cols === 2 ? 'sm:grid-cols-2' : '', cols >= 4 && 'lg:grid-cols-4')}>
                {row.cells.map((cell) => (
                  <div key={cell.period} className="space-y-2">
                    {cell.runIds.map((id) => {
                      const r = runs.get(id);
                      return r ? <RunCell key={id} run={r} tz={data.tz} onOpen={onOpen} /> : null;
                    })}
                    {cell.expected.map((e) => (
                      <div
                        key={`${e.storeName}-${e.windowLabel}`}
                        className={cn(
                          'rounded-md border px-3 py-2.5',
                          e.missed ? 'border-alert/40 bg-alert/[0.06]' : 'border-dashed border-navy-secondary',
                        )}
                      >
                        <div className="flex items-center justify-between text-2xs uppercase tracking-wider text-silver/70">
                          {periodLabel(t, cell.period)}
                          {e.missed && <Badge variant="destructive" size="sm">{kindLabel(t, 'NOT_STARTED')}</Badge>}
                        </div>
                        {/* "Scheduled 2:00 PM · not started" — it read "Started 2:00 PM — no SOP open" beside a NOT STARTED chip. */}
                        <div className={cn('mt-1 text-sm', e.missed ? 'text-alert' : 'text-silver')}>
                          {e.missed
                            ? Date.parse(e.endsAt) <= Date.now()
                              ? t('portalOps.scheduledNoneRun', { time: fmtTimeTz(e.startsAt, data.tz) })
                              : t('portalOps.scheduledNotStarted', { time: fmtTimeTz(e.startsAt, data.tz) })
                            : t('portalOps.startsAt', { time: fmtTimeTz(e.startsAt, data.tz) })}
                        </div>
                      </div>
                    ))}
                    {cell.runIds.length === 0 && cell.expected.length === 0 && (
                      <div className="rounded-md border border-dashed border-navy-secondary/60 px-3 py-2.5 text-2xs uppercase tracking-wider text-silver/40">
                        {periodLabel(t, cell.period)} · —
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function runState(t: Translate, run: StoreOpsRun): { label: string; variant: 'success' | 'pending' | 'destructive' | 'accent' } {
  if (run.status === 'CLOSED') {
    // Closed by the expiry sweep: nobody submitted it (LEAD-2).
    if (run.expired) return { label: t('portalOps.state.expired'), variant: 'destructive' };
    return run.closedIncomplete ? { label: t('portalOps.state.incomplete'), variant: 'pending' } : { label: t('portalOps.state.submitted'), variant: 'success' };
  }
  if (run.dueAt && Date.parse(run.dueAt) < Date.now()) return { label: t('portalOps.state.notSubmitted'), variant: 'destructive' };
  if (run.overdueItems > 0) return { label: t('portalOps.state.overdue', { count: run.overdueItems }), variant: 'destructive' };
  return { label: t('portalOps.state.running'), variant: 'accent' };
}

function RunCell({ run, tz, onOpen }: { run: StoreOpsRun; tz: string; onOpen: (id: string) => void }) {
  const { t } = useI18n();
  const pct = run.total > 0 ? Math.round((run.done / run.total) * 100) : 0;
  const st = runState(t, run);
  const bad = st.variant === 'destructive';
  return (
    <button
      type="button"
      onClick={() => onOpen(run.id)}
      className={cn(
        'block w-full rounded-md border px-3 py-2.5 text-left transition-colors hover:border-gold/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
        bad ? 'border-alert/40 bg-alert/[0.05]' : st.variant === 'success' ? 'border-success/30 bg-success/[0.04]' : 'border-navy-secondary',
      )}
      aria-label={t('portalOps.runAria', { dept: run.department, period: periodLabel(t, run.period), state: st.label, done: run.done, total: run.total })}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-2xs uppercase tracking-wider text-silver/70">
          {periodLabel(t, run.period)}
          {run.storeName ? windowSuffix(t, run.period, run.windowLabel) : ''}
        </span>
        <Badge variant={st.variant} size="sm">
          {st.label}
        </Badge>
      </div>
      <div className="mt-1.5 flex items-baseline justify-between gap-2">
        <span className="text-lg font-semibold tabular-nums text-white">{pct}%</span>
        <span className="text-xs tabular-nums text-silver">
          {run.done}/{run.total}
          {run.onTimePct !== null ? ` · ${t('portalOps.pctOnTime', { pct: run.onTimePct })}` : ''}
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-navy-secondary" aria-hidden="true">
        <div
          className={cn('h-full rounded-full', st.variant === 'success' ? 'bg-success' : bad ? 'bg-alert' : 'bg-gold')}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-1.5 truncate text-xs text-silver">
        {run.status === 'CLOSED'
          ? run.expired
            ? t('portalOps.expiredBy', { name: run.runBy })
            : t('portalOps.submittedBy', { name: run.runBy, time: fmtTimeTz(run.closedAt, tz) })
          : run.current
            ? t('portalOps.nowSection', { section: run.current.section, time: fmtTimeTz(run.current.dueAt, tz) })
            : run.runBy}
      </div>
    </button>
  );
}

/* ----- one run, block by block ------------------------------------------ */

function RunDialog({ run, data, scopeQs, onClose }: { run: StoreOpsRun; data: StoreOpsDay; scopeQs: string; onClose: () => void }) {
  const { t } = useI18n();
  const Icon = DEPT_ICON[run.department] ?? DEPT_FALLBACK_ICON;
  const st = runState(t, run);
  const temps = data.temps.filter((temp) => temp.shiftId === run.id);
  const handoffs = data.handoffs.filter((h) => h.shiftId === run.id);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon className={cn('h-5 w-5', DEPT_TONE[run.department] ?? 'text-gold')} aria-hidden="true" />
            {run.department} · {periodLabel(t, run.period)}
            <Badge variant={st.variant} className="ml-1">
              {st.label}
            </Badge>
          </DialogTitle>
          <DialogDescription>
            {run.templateName ?? t('portalOps.checklist')} · {t('portalOps.runBy', { name: run.runBy, time: fmtTimeTz(run.openedAt, data.tz) })}
            {run.closedAt
              ? ` · ${run.expired ? t('portalOps.expiredAt', { time: fmtTimeTz(run.closedAt, data.tz) }) : t('portalOps.submittedAt', { time: fmtTimeTz(run.closedAt, data.tz) })}`
              : ''}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm tabular-nums">
            <span className="text-white">
              {run.done}/{run.total} <span className="text-silver">{t('portalOps.done')}</span>
            </span>
            {run.onTimePct !== null && (
              <span className={run.onTimePct >= 90 ? 'text-success' : 'text-warning'}>{t('portalOps.pctOnTime', { pct: run.onTimePct })}</span>
            )}
            {run.overdueItems > 0 && <span className="text-alert">{t('portalOps.state.overdue', { count: run.overdueItems })}</span>}
          </div>
          {run.closedIncomplete && run.incompleteReason && (
            <div className="rounded-md border border-warning/40 bg-warning/[0.06] p-3 text-sm text-white">
              <div className="text-2xs uppercase tracking-wider text-warning">
                {run.expired ? t('portalOps.state.expired') : t('portalOps.whyIncomplete')}
              </div>
              {run.incompleteReason}
            </div>
          )}
          {run.blocks.length > 0 ? (
            <ol className="relative ml-2 space-y-0.5 border-l border-navy-secondary pl-4" aria-label={t('portalOps.blocks')}>
              {run.blocks.map((b) => (
                <li key={`${b.dueAt}-${b.section}`} className="relative py-1.5">
                  <span
                    className={cn(
                      'absolute -left-[21px] top-2.5 grid h-2.5 w-2.5 place-items-center rounded-full ring-4 ring-navy',
                      b.state === 'done' && 'bg-success',
                      b.state === 'late' && 'bg-warning',
                      b.state === 'overdue' && 'bg-alert',
                      b.state === 'open' && 'bg-gold',
                      b.state === 'upcoming' && 'bg-navy-secondary',
                    )}
                    aria-hidden="true"
                  />
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="text-sm text-white">{b.section}</span>
                    <span
                      className={cn(
                        'text-xs tabular-nums',
                        b.state === 'overdue' ? 'text-alert' : b.state === 'late' ? 'text-warning' : b.state === 'done' ? 'text-success' : 'text-silver',
                      )}
                    >
                      {blockLabel(t, b.state)}
                      {b.finishedAt ? ` ${fmtTimeTz(b.finishedAt, data.tz)}` : ''} · {t('portalOps.dueAt', { time: fmtTimeTz(b.dueAt, data.tz) })} · {b.done}/{b.total}
                    </span>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-silver">{t('portalOps.noBlocks')}</p>
          )}
          {temps.length > 0 && (
            <div>
              <div className="mb-1 text-2xs uppercase tracking-wider text-silver/70">{t('portalOps.kpiTemps')}</div>
              <ul className="space-y-1">
                {temps.map((temp) => (
                  <li key={temp.taskId} className="flex items-center justify-between gap-3 text-sm">
                    <span className="truncate text-white">{temp.title}</span>
                    <TempReading t={temp} tz={data.tz} />
                  </li>
                ))}
              </ul>
            </div>
          )}
          {handoffs.length > 0 && (
            <div>
              <div className="mb-1 text-2xs uppercase tracking-wider text-silver/70">{t('portalOps.handedNext')}</div>
              <ul className="space-y-1.5">
                {handoffs.map((h) => (
                  <li key={h.id} className="text-sm text-white">
                    {h.body}{' '}
                    <Badge variant={HANDOFF_VARIANT[h.status] ?? 'default'} size="sm">
                      {handoffLabel(t, h.status)}
                    </Badge>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {run.summary && (
            <div>
              <div className="mb-1 text-2xs uppercase tracking-wider text-silver/70">{t('portalOps.leadSummary')}</div>
              <p className="text-sm text-white">{run.summary}</p>
            </div>
          )}
          {run.finalPhotoId && (
            <figure>
              <figcaption className="mb-1 flex items-center gap-1.5 text-2xs uppercase tracking-wider text-silver/70">
                <Camera className="h-3.5 w-3.5" aria-hidden="true" />
                {t('portalOps.finalZone')}
              </figcaption>
              <OpsPhoto
                src={storeOpsPhotoUrl(run.finalPhotoId, scopeQs)}
                alt={t('portalOps.finalZoneAlt', { dept: run.department })}
                className="max-h-80 min-h-24 w-full rounded-md border border-navy-secondary object-cover"
              />
            </figure>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ----- food safety -------------------------------------------------------- */

function TempReading({ t: temp, tz }: { t: StoreOpsTemp; tz: string }) {
  const { t } = useI18n();
  const range = temp.min !== null && temp.max !== null ? `${temp.min}–${temp.max}°F` : '';
  if (temp.value === null) {
    const missed = temp.dueAt !== null && Date.parse(temp.dueAt) < Date.now();
    return (
      <span className={cn('shrink-0 text-xs tabular-nums', missed ? 'text-alert' : 'text-silver')}>
        {missed
          ? t('portalOps.tempMissedDue', { time: fmtTimeTz(temp.dueAt, tz) })
          : temp.dueAt
            ? t('portalOps.tempDue', { time: fmtTimeTz(temp.dueAt, tz) })
            : t('portalOps.tempNotTaken')}
      </span>
    );
  }
  if (!temp.outOfRange) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-xs tabular-nums text-success" title={t('portalOps.tempRange', { range })}>
        <Check className="h-3 w-3" aria-hidden="true" />
        {temp.value}°F
      </span>
    );
  }
  const fixed = temp.recheck && temp.recheck.value !== null && !temp.recheck.outOfRange;
  return (
    <span className="shrink-0 text-right text-xs tabular-nums">
      <span className="font-semibold text-alert">{temp.value}°F</span>
      <span className="text-silver"> {t('portalOps.tempRangeParen', { range })}</span>
      <span className={cn('block', fixed ? 'text-success' : 'text-alert')}>
        {fixed ? (
          <span className="inline-flex items-center gap-1">
            {t('portalOps.recheckedOk', { value: temp.recheck!.value! })}
            <Check className="h-3 w-3" aria-hidden="true" />
          </span>
        ) : temp.recheck?.value != null ? (
          t('portalOps.recheckOut', { value: temp.recheck.value })
        ) : (
          t('portalOps.notRechecked')
        )}
      </span>
    </span>
  );
}

function FoodSafety({ data }: { data: StoreOpsDay }) {
  const { t } = useI18n();
  // This day's log: a carried overnight's readings are on its own day (its run dialog shows them).
  const rows = useMemo(
    () =>
      data.temps
        .filter((temp) => !temp.carried)
        .sort((a, b) => (a.at ?? a.dueAt ?? '').localeCompare(b.at ?? b.dueAt ?? '')),
    [data.temps],
  );
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Thermometer className="h-4 w-4 text-teal" aria-hidden="true" />
          {t('portalOps.foodSafety')}
        </CardTitle>
        <Button
          size="sm"
          variant="outline"
          className="print:hidden"
          disabled={rows.length === 0}
          onClick={() =>
            downloadCsv(`temperature-log-${data.date}.csv`, [
              [
                t('portalOps.csvDate'),
                t('portalOps.csvTime'),
                t('portalOps.csvDept'),
                t('portalOps.csvShift'),
                t('portalOps.csvCheck'),
                t('portalOps.csvReading'),
                t('portalOps.csvMin'),
                t('portalOps.csvMax'),
                t('portalOps.csvInRange'),
                t('portalOps.csvRecheck'),
              ],
              ...rows.map((temp) => [
                data.date,
                temp.at ? fmtTimeTz(temp.at, data.tz) : '',
                temp.department,
                periodLabel(t, temp.period),
                temp.title,
                temp.value ?? '',
                temp.min ?? '',
                temp.max ?? '',
                temp.value === null ? '' : temp.outOfRange ? t('portalOps.no') : t('portalOps.yes'),
                temp.recheck?.value ?? '',
              ]),
            ])
          }
        >
          <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          {t('portalOps.tempLog')}
        </Button>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="py-4 text-sm text-silver">{t('portalOps.noTempChecks')}</p>
        ) : (
          <ul className="divide-y divide-navy-secondary/60">
            {rows.map((temp) => (
              <li key={temp.taskId} className="flex items-center justify-between gap-3 py-2">
                <span className="min-w-0">
                  <span className="block truncate text-sm text-white">{temp.title}</span>
                  <span className="block text-xs text-silver">
                    {temp.department} · {periodLabel(t, temp.period)}
                    {temp.at ? ` · ${fmtTimeTz(temp.at, data.tz)}` : ''}
                  </span>
                </span>
                <TempReading t={temp} tz={data.tz} />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/* ----- production --------------------------------------------------------- */

function Production({ data }: { data: StoreOpsDay }) {
  const { t } = useI18n();
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{t('portalOps.production')}</CardTitle>
      </CardHeader>
      <CardContent>
        {data.metrics.length === 0 ? (
          <p className="py-4 text-sm text-silver">{t('portalOps.productionEmpty')}</p>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {data.metrics.map((m) => {
              const depts = Object.entries(m.byDepartment).sort((a, b) => b[1] - a[1]);
              return (
                <div key={m.key} className="rounded-md border border-navy-secondary/70 px-3 py-2">
                  <div className="truncate text-2xs uppercase tracking-wider text-silver/70">{m.label || metricLabel(m.key)}</div>
                  <div className="mt-0.5 text-xl font-semibold tabular-nums text-white">
                    {m.total.toLocaleString()}
                    {m.unit && <span className="ml-1 text-xs font-normal text-silver">{m.unit}</span>}
                  </div>
                  {depts.length > 1 && (
                    <div className="mt-0.5 space-y-0.5">
                      {depts.map(([d, n]) => (
                        <div key={d} className="flex justify-between gap-2 text-2xs text-silver tabular-nums">
                          <span className="truncate">{d}</span>
                          <span>{n.toLocaleString()}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {depts.length === 1 && <div className="truncate text-2xs text-silver">{depts[0]![0]}</div>}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ----- handoffs ----------------------------------------------------------- */

function Handoffs({ data }: { data: StoreOpsDay }) {
  const { t } = useI18n();
  const handoffs = data.handoffs.filter((h) => !h.carried);
  if (handoffs.length === 0) return null;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{t('portalOps.handoffs')}</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-navy-secondary/60">
          {handoffs.map((h) => {
            const Icon = HANDOVER_KIND_ICON[h.kind];
            const variant = HANDOFF_VARIANT[h.status] ?? 'default';
            return (
              <li key={h.id} className="flex items-start gap-3 py-2.5">
                <Icon
                  className={cn('mt-0.5 h-4 w-4 shrink-0', h.priority === 'HIGH' ? 'text-alert' : 'text-silver')}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-white">{h.body}</span>
                  <span className="block text-xs text-silver">
                    {handoverKindLabel(t, h.kind)} · {h.department} · {periodLabel(t, h.period)} · {fmtTimeTz(h.createdAt, data.tz)}
                    {h.decidedBy ? ` · ${h.decidedBy}` : ''}
                  </span>
                </span>
                <Badge variant={variant} size="sm" className="shrink-0">
                  {handoffLabel(t, h.status)}
                </Badge>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
