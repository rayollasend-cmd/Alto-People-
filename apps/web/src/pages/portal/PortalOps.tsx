import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  AlarmClock,
  AlertTriangle,
  ArrowLeft,
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
  Moon,
  Printer,
  ShieldCheck,
  Thermometer,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
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
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { PageHeader } from '@/components/ui/PageHeader';
import { AsOf } from '@/components/ui/AsOf';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { DEPT_FALLBACK_ICON, DEPT_ICON, DEPT_TONE, HANDOVER_KIND_ICON, HANDOVER_KIND_LABEL, PERIOD_LABEL } from '../ops/opsVisuals';
import { scopeParams, shiftDays } from './scope';

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

const KIND: Record<AttentionKind, { icon: LucideIcon; label: string }> = {
  TEMP: { icon: Thermometer, label: 'Food safety' },
  EQUIPMENT: { icon: Wrench, label: 'Equipment' },
  NOT_STARTED: { icon: CircleSlash, label: 'Not started' },
  NOT_SUBMITTED: { icon: ClipboardX, label: 'Not submitted' },
  OVERDUE: { icon: AlarmClock, label: 'Overdue' },
  BLOCKED: { icon: Ban, label: 'Blocked' },
  COMPLIANCE: { icon: AlertTriangle, label: 'Standard missed' },
  INCOMPLETE: { icon: FileWarning, label: 'Submitted incomplete' },
};

const BLOCK_LABEL: Record<BlockState, string> = {
  done: 'Done',
  late: 'Done late',
  overdue: 'Overdue',
  open: 'In progress',
  upcoming: 'Up next',
};

const HANDOFF_STATUS: Record<string, { label: string; variant: 'pending' | 'success' | 'default' }> = {
  PENDING: { label: 'Waiting for next shift', variant: 'pending' },
  CARRIED: { label: 'Taken on', variant: 'success' },
  REVIEWED: { label: 'Read', variant: 'success' },
  DISMISSED: { label: 'Dismissed', variant: 'default' },
};

/** /portal/ops — the store manager's page (and an admin's preview). */
export function PortalOps() {
  const { user, can } = useAuth();
  const [searchParams] = useSearchParams();
  const isPortal = user?.role === 'CLIENT_PORTAL';
  const canPreview = can('view:executive') || can('manage:org');
  const previewId = searchParams.get('clientId');
  const scope = scopeParams(searchParams, isPortal);
  const scopeQs = scope.toString() ? `?${scope.toString()}` : '';

  if (!isPortal && !canPreview) {
    return <EmptyState icon={ClipboardCheck} title="Store operations are for your store's managers" description="" />;
  }
  if (!isPortal && !previewId) {
    return <EmptyState icon={ClipboardCheck} title="Store operations" description="Pick a client to preview." />;
  }
  return (
    <div className="mx-auto max-w-6xl print-area">
      <PageHeader
        title="Store operations"
        subtitle="Every department's SOP, shift by shift — what's late, what's unsafe, what got done."
        breadcrumbs={[{ label: 'My store', to: `/portal${scopeQs}` }]}
        secondaryActions={
          <Button size="sm" variant="ghost" asChild>
            <Link to={`/portal${scopeQs}`}>
              <ArrowLeft className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              My store
            </Link>
          </Button>
        }
      />
      <StoreOps />
    </div>
  );
}

/**
 * The page body — also the team leads' "Store today" tab in Store Ops. The
 * date lives in ?date= so a link to last Tuesday opens on last Tuesday.
 */
export function StoreOps() {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const isPortal = user?.role === 'CLIENT_PORTAL';
  const scope = scopeParams(searchParams, isPortal);
  const scopeQs = scope.toString() ? `?${scope.toString()}` : '';
  const date = searchParams.get('date') ?? ymdLocal();
  // The two narrowings a store manager actually asks for. "What happened
  // overnight" is a filter on this page, not a different page.
  const period = searchParams.get('period') ?? '';
  const department = searchParams.get('department') ?? '';
  const qs = `?${new URLSearchParams([
    ...scope.entries(),
    ['date', date],
    ...(period ? ([['period', period]] as [string, string][]) : []),
    ...(department ? ([['department', department]] as [string, string][]) : []),
  ]).toString()}`;
  const isToday = date === ymdLocal();
  const query = useQuery({
    queryKey: ['clientPortal', 'ops', qs],
    queryFn: () => getStoreOps(qs),
    refetchInterval: isToday ? 60_000 : false,
    refetchOnWindowFocus: isToday,
    placeholderData: (prev) => prev,
  });
  const data = query.data;
  const switching = !!data && data.date !== date;
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
    p.set('date', shiftDays(ymdLocal(), -1));
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
  const lastNightOn = date === shiftDays(ymdLocal(), -1) && period === 'OVERNIGHT';

  const run = data?.runs.find((r) => r.id === openRun) ?? null;
  return (
    <div className={cn('space-y-4', switching && 'opacity-70 transition-opacity')}>
      <DateBar
        date={date}
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
        <ErrorBanner>{query.error instanceof Error ? query.error.message : 'Could not load store operations.'}</ErrorBanner>
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
          <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
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
  const live = data.live ?? [];
  if (live.length === 0) return null;
  return (
    <Card>
      <CardContent className="p-4">
        <h2 className="flex items-center gap-2 text-sm font-medium text-white">
          <span className="relative flex h-2 w-2" aria-hidden="true">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-70" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
          </span>
          On the floor now
          <span className="text-xs font-normal text-silver/60">
            {live.length} shift{live.length === 1 ? '' : 's'} running
          </span>
        </h2>
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
                      <span className="ml-1.5 text-xs text-gold">{l.period.toLowerCase()}</span>
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-silver/70">
                      {l.runBy} · started {fmtTimeTz(l.openedAt, data.tz)}
                      {l.dueAt && ` · due ${fmtTimeTz(l.dueAt, data.tz)}`}
                    </span>
                    {l.current?.section && (
                      <span className="mt-0.5 block truncate text-xs text-silver/60">
                        on {l.current.section} · {l.current.open} left
                      </span>
                    )}
                    {l.overdueItems > 0 && (
                      <span className="mt-0.5 block text-xs text-warning">
                        {l.overdueItems} item{l.overdueItems === 1 ? '' : 's'} past due
                      </span>
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
  const photos = data.photos ?? [];
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="flex items-center gap-1.5 text-sm font-medium text-white">
            <Camera className="h-4 w-4 text-gold" aria-hidden="true" />
            From the floor
          </h2>
          <span className="text-xs text-silver/60 tabular-nums">
            {photos.length === 0
              ? 'no photos yet'
              : `${photos.length} photo${photos.length === 1 ? '' : 's'}`}
          </span>
        </div>
        {photos.length === 0 ? (
          // It stays on the page when empty: a card that disappears is a
          // card nobody learns exists, and "no photos" is itself a finding.
          <p className="mt-3 text-sm text-silver/70">
            Supervisors photograph the floor as they work the checklist. Anything taken
            {data.date === data.storeToday ? ' today' : ' that day'} appears here.
          </p>
        ) : (
          <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {photos.map((ph) => (
              <li key={ph.id} className="group">
                <a
                  href={storeOpsPhotoUrl(ph.id, scopeQs)}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`Open the full photo: ${ph.title}${
                    ph.department ? `, ${ph.department}` : ''
                  }${ph.period ? `, ${ph.period.toLowerCase()}` : ''}, ${fmtTimeTz(
                    ph.at,
                    data.tz,
                  )} (opens in a new tab)`}
                  className="block overflow-hidden rounded-lg border border-navy-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
                >
                  <img
                    src={storeOpsPhotoUrl(ph.id, scopeQs)}
                    alt={ph.title}
                    loading="lazy"
                    className="aspect-[4/3] w-full object-cover transition-transform group-hover:scale-[1.03]"
                  />
                </a>
                <div className="mt-1.5 min-w-0">
                  <button
                    type="button"
                    onClick={() => onOpen(ph.shiftId)}
                    className="block max-w-full truncate text-left text-xs font-medium text-white hover:text-gold hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
                    aria-label={`Open the shift this photo came from: ${
                      ph.department ?? 'this shift'
                    }`}
                  >
                    {ph.title}
                  </button>
                  <div className="truncate text-2xs text-silver/60">
                    {[ph.department, ph.period?.toLowerCase()].filter(Boolean).join(' · ')}
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

/* ----- date bar ---------------------------------------------------------- */

function DateBar({
  date,
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
  const today = ymdLocal();
  const yesterday = shiftDays(today, -1);
  const narrowed = period !== '' || department !== '' || date !== today;
  return (
    <div className="sticky top-0 z-10 -mx-4 flex flex-wrap items-center gap-2 bg-navy/95 px-4 py-2 backdrop-blur md:mx-0 md:px-0 print:static">
      <Button size="sm" variant="ghost" onClick={() => onDate(shiftDays(date, -1))} aria-label="Previous day" className="print:hidden">
        <ChevronLeft className="h-4 w-4" aria-hidden="true" />
      </Button>
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <Button size="sm" variant={date === today ? 'secondary' : 'ghost'} onClick={() => onDate(null)} className="print:hidden">
          Today
        </Button>
        <Button
          size="sm"
          variant={date === yesterday && !lastNightOn ? 'secondary' : 'ghost'}
          onClick={() => onDate(yesterday)}
          className="hidden sm:inline-flex print:hidden"
        >
          Yesterday
        </Button>
        {/* The question this page is asked most: what happened overnight.
            One button, rather than a date and a filter and a guess. */}
        <Button
          size="sm"
          variant={lastNightOn ? 'secondary' : 'ghost'}
          onClick={onLastNight}
          className="print:hidden"
        >
          <Moon className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
          Last night
        </Button>
        <input
          type="date"
          value={date}
          max={today}
          onChange={(e) => e.target.value && onDate(e.target.value)}
          className="ml-1 h-8 rounded-md border border-navy-secondary bg-navy px-2 text-xs text-white print:hidden coarse:h-11 coarse:text-base"
          aria-label="Pick a date"
        />
        <Select
          size="sm"
          value={period}
          onChange={(e) => onFilter('period', e.target.value)}
          aria-label="Filter by shift"
          className="ml-1 w-auto print:hidden"
        >
          <option value="">All shifts</option>
          <option value="MORNING">Morning</option>
          <option value="EVENING">Evening</option>
          <option value="CLOSING">Closing</option>
          <option value="OVERNIGHT">Overnight</option>
        </Select>
        {(data?.departments?.length ?? 0) > 1 && (
          <Select
            size="sm"
            value={department}
            onChange={(e) => onFilter('department', e.target.value)}
            aria-label="Filter by department"
            className="w-auto max-w-[10rem] print:hidden"
          >
            <option value="">All departments</option>
            {data!.departments.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </Select>
        )}
        {narrowed && (
          <Button size="sm" variant="ghost" onClick={onClear} className="print:hidden">
            Clear
          </Button>
        )}
        <span className="ml-2 hidden text-xs text-silver sm:inline">
          {data?.scope.location?.name ?? data?.scope.client.name}
          {' · '}
          {fmtDate(parseYmd(date))}
        </span>
        {/* A page that polls every minute owes its reader the minute. */}
        {date === today && (
          <AsOf at={updatedAt} refreshing={refreshing} onRefresh={onRefresh} className="print:hidden" />
        )}
      </div>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => onDate(shiftDays(date, 1))}
        aria-label="Next day"
        disabled={date >= today}
        className="print:hidden"
      >
        <ChevronRight className="h-4 w-4" aria-hidden="true" />
      </Button>
      <Button size="sm" variant="outline" className="hidden print:hidden sm:inline-flex" onClick={() => window.print()}>
        <Printer className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
        Print
      </Button>
    </div>
  );
}

/* ----- the verdict + what needs you now --------------------------------- */

function Verdict({ data, isToday, onOpen }: { data: StoreOpsDay; isToday: boolean; onOpen: (id: string) => void }) {
  const s = data.summary;
  const urgent = data.attention.filter((a) => a.severity === 'high');
  const noRuns = s.sops === 0 && s.notStarted === 0;
  const tone = urgent.length > 0 ? 'alert' : data.attention.length > 0 ? 'warning' : noRuns ? 'quiet' : 'success';
  const headline =
    urgent.length > 0
      ? `${urgent.length} ${urgent.length === 1 ? 'thing needs' : 'things need'} you now`
      : data.attention.length > 0
        ? `On track — ${data.attention.length} to review`
        : noRuns
          ? isToday
            ? 'No SOPs have started yet today'
            : 'No SOPs were run this day'
          : isToday
            ? 'Every department is on track'
            : 'Every SOP was done';
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
          label="SOPs submitted"
          value={s.sops + s.notStarted > 0 ? `${s.submitted}/${s.sops + s.notStarted}` : '—'}
          sub={[s.running ? `${s.running} running` : null, s.notStarted ? `${s.notStarted} not started` : null].filter(Boolean).join(' · ') || 'nothing open'}
          subTone={s.notStarted > 0 ? 'alert' : undefined}
        />
        <Kpi
          label="On time"
          value={s.onTimePct !== null ? `${s.onTimePct}%` : '—'}
          sub={s.overdueBlocks ? `${s.overdueBlocks} block${s.overdueBlocks === 1 ? '' : 's'} overdue now` : 'done by their due time'}
          tone={s.onTimePct === null ? undefined : s.onTimePct >= 90 ? 'success' : s.onTimePct < 75 ? 'alert' : undefined}
          subTone={s.overdueBlocks > 0 ? 'alert' : undefined}
        />
        <Kpi
          label="Temperatures"
          value={String(s.tempChecks)}
          sub={
            s.tempOpen
              ? `${s.tempOpen} out of range`
              : s.tempsDue
                ? `${s.tempsDue} missed`
                : s.tempAlerts
                  ? `${s.tempAlerts} corrected · rest in range`
                  : 'all in range'
          }
          subTone={s.tempOpen || s.tempsDue ? 'alert' : s.tempChecks ? 'success' : undefined}
        />
        <Kpi
          label="Checklist done"
          value={s.completionPct !== null ? `${s.completionPct}%` : '—'}
          sub={`${s.photos} photo${s.photos === 1 ? '' : 's'} on record`}
        />
      </div>
      {data.attention.length > 0 && (
        <ul className="divide-y divide-navy-secondary/60 border-t border-navy-secondary/60" aria-label="Needs attention">
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
  const meta = KIND[item.kind];
  const Icon = meta.icon;
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
          <span className={item.severity === 'high' ? 'text-alert' : 'text-warning'}>{meta.label}</span>
          {' · '}
          {item.department} · {PERIOD_LABEL[item.period] ?? item.period}
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
  const runs = useMemo(() => new Map(data.runs.map((r) => [r.id, r])), [data.runs]);
  if (data.grid.length === 0) {
    return (
      <Card>
        <CardContent className="py-8">
          <EmptyState
            icon={ClipboardCheck}
            title="No department SOPs this day"
            description="A team lead's SOP opens when they clock in for their shift — it shows here as they work it."
          />
        </CardContent>
      </Card>
    );
  }
  const cols = data.periods.length;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Departments by shift</CardTitle>
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
                          {PERIOD_LABEL[cell.period]}
                          {e.missed && <Badge variant="destructive" size="sm">Not started</Badge>}
                        </div>
                        <div className={cn('mt-1 text-sm', e.missed ? 'text-alert' : 'text-silver')}>
                          {e.missed ? `Started ${fmtTimeTz(e.startsAt, data.tz)} — no SOP open` : `Starts ${fmtTimeTz(e.startsAt, data.tz)}`}
                        </div>
                      </div>
                    ))}
                    {cell.runIds.length === 0 && cell.expected.length === 0 && (
                      <div className="rounded-md border border-dashed border-navy-secondary/60 px-3 py-2.5 text-2xs uppercase tracking-wider text-silver/40">
                        {PERIOD_LABEL[cell.period]} · —
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

function runState(run: StoreOpsRun): { label: string; variant: 'success' | 'pending' | 'destructive' | 'accent' } {
  if (run.status === 'CLOSED') {
    return run.closedIncomplete ? { label: 'Incomplete', variant: 'pending' } : { label: 'Submitted', variant: 'success' };
  }
  if (run.dueAt && Date.parse(run.dueAt) < Date.now()) return { label: 'Not submitted', variant: 'destructive' };
  if (run.overdueItems > 0) return { label: `${run.overdueItems} overdue`, variant: 'destructive' };
  return { label: 'Running', variant: 'accent' };
}

function RunCell({ run, tz, onOpen }: { run: StoreOpsRun; tz: string; onOpen: (id: string) => void }) {
  const pct = run.total > 0 ? Math.round((run.done / run.total) * 100) : 0;
  const st = runState(run);
  const bad = st.variant === 'destructive';
  return (
    <button
      type="button"
      onClick={() => onOpen(run.id)}
      className={cn(
        'block w-full rounded-md border px-3 py-2.5 text-left transition-colors hover:border-gold/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
        bad ? 'border-alert/40 bg-alert/[0.05]' : st.variant === 'success' ? 'border-success/30 bg-success/[0.04]' : 'border-navy-secondary',
      )}
      aria-label={`${run.department} ${PERIOD_LABEL[run.period]}: ${st.label}, ${run.done} of ${run.total} done`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-2xs uppercase tracking-wider text-silver/70">
          {PERIOD_LABEL[run.period]}
          {run.storeName && run.windowLabel ? ` · ${run.windowLabel}` : ''}
        </span>
        <Badge variant={st.variant} size="sm">
          {st.label}
        </Badge>
      </div>
      <div className="mt-1.5 flex items-baseline justify-between gap-2">
        <span className="text-lg font-semibold tabular-nums text-white">{pct}%</span>
        <span className="text-xs tabular-nums text-silver">
          {run.done}/{run.total}
          {run.onTimePct !== null ? ` · ${run.onTimePct}% on time` : ''}
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
          ? `${run.runBy} · submitted ${fmtTimeTz(run.closedAt, tz)}`
          : run.current
            ? `Now: ${run.current.section} · due ${fmtTimeTz(run.current.dueAt, tz)}`
            : run.runBy}
      </div>
    </button>
  );
}

/* ----- one run, block by block ------------------------------------------ */

function RunDialog({ run, data, scopeQs, onClose }: { run: StoreOpsRun; data: StoreOpsDay; scopeQs: string; onClose: () => void }) {
  const Icon = DEPT_ICON[run.department] ?? DEPT_FALLBACK_ICON;
  const st = runState(run);
  const temps = data.temps.filter((t) => t.shiftId === run.id);
  const handoffs = data.handoffs.filter((h) => h.shiftId === run.id);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon className={cn('h-5 w-5', DEPT_TONE[run.department] ?? 'text-gold')} aria-hidden="true" />
            {run.department} · {PERIOD_LABEL[run.period]}
            <Badge variant={st.variant} className="ml-1">
              {st.label}
            </Badge>
          </DialogTitle>
          <DialogDescription>
            {run.templateName ?? 'SOP'} · run by {run.runBy} · opened {fmtTimeTz(run.openedAt, data.tz)}
            {run.closedAt ? ` · submitted ${fmtTimeTz(run.closedAt, data.tz)}` : ''}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm tabular-nums">
            <span className="text-white">
              {run.done}/{run.total} <span className="text-silver">done</span>
            </span>
            {run.onTimePct !== null && (
              <span className={run.onTimePct >= 90 ? 'text-success' : 'text-warning'}>{run.onTimePct}% on time</span>
            )}
            {run.overdueItems > 0 && <span className="text-alert">{run.overdueItems} overdue</span>}
          </div>
          {run.closedIncomplete && run.incompleteReason && (
            <div className="rounded-md border border-warning/40 bg-warning/[0.06] p-3 text-sm text-white">
              <div className="text-2xs uppercase tracking-wider text-warning">Why it's incomplete</div>
              {run.incompleteReason}
            </div>
          )}
          {run.blocks.length > 0 ? (
            <ol className="relative ml-2 space-y-0.5 border-l border-navy-secondary pl-4" aria-label="Blocks">
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
                      {BLOCK_LABEL[b.state]}
                      {b.finishedAt ? ` ${fmtTimeTz(b.finishedAt, data.tz)}` : ''} · due {fmtTimeTz(b.dueAt, data.tz)} · {b.done}/{b.total}
                    </span>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-silver">This SOP has no timed blocks.</p>
          )}
          {temps.length > 0 && (
            <div>
              <div className="mb-1 text-2xs uppercase tracking-wider text-silver/70">Temperatures</div>
              <ul className="space-y-1">
                {temps.map((t) => (
                  <li key={t.taskId} className="flex items-center justify-between gap-3 text-sm">
                    <span className="truncate text-white">{t.title}</span>
                    <TempReading t={t} tz={data.tz} />
                  </li>
                ))}
              </ul>
            </div>
          )}
          {handoffs.length > 0 && (
            <div>
              <div className="mb-1 text-2xs uppercase tracking-wider text-silver/70">Handed to the next shift</div>
              <ul className="space-y-1.5">
                {handoffs.map((h) => (
                  <li key={h.id} className="text-sm text-white">
                    {h.body}{' '}
                    <Badge variant={HANDOFF_STATUS[h.status]!.variant} size="sm">
                      {HANDOFF_STATUS[h.status]!.label}
                    </Badge>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {run.summary && (
            <div>
              <div className="mb-1 text-2xs uppercase tracking-wider text-silver/70">Team lead's summary</div>
              <p className="text-sm text-white">{run.summary}</p>
            </div>
          )}
          {run.finalPhotoId && (
            <figure>
              <figcaption className="mb-1 flex items-center gap-1.5 text-2xs uppercase tracking-wider text-silver/70">
                <Camera className="h-3.5 w-3.5" aria-hidden="true" />
                Final zone
              </figcaption>
              <img
                src={storeOpsPhotoUrl(run.finalPhotoId, scopeQs)}
                alt={`${run.department} after the final zone`}
                className="max-h-80 w-full rounded-md border border-navy-secondary object-cover"
                loading="lazy"
              />
            </figure>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ----- food safety -------------------------------------------------------- */

function TempReading({ t, tz }: { t: StoreOpsTemp; tz: string }) {
  const range = t.min !== null && t.max !== null ? `${t.min}–${t.max}°F` : '';
  if (t.value === null) {
    const missed = t.dueAt !== null && Date.parse(t.dueAt) < Date.now();
    return (
      <span className={cn('shrink-0 text-xs tabular-nums', missed ? 'text-alert' : 'text-silver')}>
        {missed ? `Missed · due ${fmtTimeTz(t.dueAt, tz)}` : t.dueAt ? `Due ${fmtTimeTz(t.dueAt, tz)}` : 'Not taken'}
      </span>
    );
  }
  if (!t.outOfRange) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-xs tabular-nums text-success" title={`Range ${range}`}>
        <Check className="h-3 w-3" strokeWidth={3} aria-hidden="true" />
        {t.value}°F
      </span>
    );
  }
  const fixed = t.recheck && t.recheck.value !== null && !t.recheck.outOfRange;
  return (
    <span className="shrink-0 text-right text-xs tabular-nums">
      <span className="font-semibold text-alert">{t.value}°F</span>
      <span className="text-silver"> (range {range})</span>
      <span className={cn('block', fixed ? 'text-success' : 'text-alert')}>
        {fixed ? `Re-checked ${t.recheck!.value}°F ✓` : t.recheck?.value != null ? `Re-check ${t.recheck.value}°F — still out` : 'Not re-checked'}
      </span>
    </span>
  );
}

function FoodSafety({ data }: { data: StoreOpsDay }) {
  const rows = useMemo(
    () =>
      [...data.temps].sort((a, b) => (a.at ?? a.dueAt ?? '').localeCompare(b.at ?? b.dueAt ?? '')),
    [data.temps],
  );
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Thermometer className="h-4 w-4 text-teal" aria-hidden="true" />
          Food safety
        </CardTitle>
        <Button
          size="sm"
          variant="outline"
          className="print:hidden"
          disabled={rows.length === 0}
          onClick={() =>
            downloadCsv(`temperature-log-${data.date}.csv`, [
              ['Date', 'Time', 'Department', 'Shift', 'Check', 'Reading °F', 'Min °F', 'Max °F', 'In range', 'Re-check °F'],
              ...rows.map((t) => [
                data.date,
                t.at ? fmtTimeTz(t.at, data.tz) : '',
                t.department,
                PERIOD_LABEL[t.period] ?? t.period,
                t.title,
                t.value ?? '',
                t.min ?? '',
                t.max ?? '',
                t.value === null ? '' : t.outOfRange ? 'no' : 'yes',
                t.recheck?.value ?? '',
              ]),
            ])
          }
        >
          <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          Temperature log
        </Button>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="py-4 text-sm text-silver">No temperature checks on this day's SOPs.</p>
        ) : (
          <ul className="divide-y divide-navy-secondary/60">
            {rows.map((t) => (
              <li key={t.taskId} className="flex items-center justify-between gap-3 py-2">
                <span className="min-w-0">
                  <span className="block truncate text-sm text-white">{t.title}</span>
                  <span className="block text-xs text-silver">
                    {t.department} · {PERIOD_LABEL[t.period]}
                    {t.at ? ` · ${fmtTimeTz(t.at, data.tz)}` : ''}
                  </span>
                </span>
                <TempReading t={t} tz={data.tz} />
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
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Freight &amp; production</CardTitle>
      </CardHeader>
      <CardContent>
        {data.metrics.length === 0 ? (
          <p className="py-4 text-sm text-silver">Counts show here as the team leads record them — pallets, cases, picks, claims.</p>
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
  if (data.handoffs.length === 0) return null;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Shift handoffs</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-navy-secondary/60">
          {data.handoffs.map((h) => {
            const Icon = HANDOVER_KIND_ICON[h.kind];
            const st = HANDOFF_STATUS[h.status]!;
            return (
              <li key={h.id} className="flex items-start gap-3 py-2.5">
                <Icon
                  className={cn('mt-0.5 h-4 w-4 shrink-0', h.priority === 'HIGH' ? 'text-alert' : 'text-silver')}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-white">{h.body}</span>
                  <span className="block text-xs text-silver">
                    {HANDOVER_KIND_LABEL[h.kind]} · {h.department} · {PERIOD_LABEL[h.period]} · {fmtTimeTz(h.createdAt, data.tz)}
                    {h.decidedBy ? ` · ${h.decidedBy}` : ''}
                  </span>
                </span>
                <Badge variant={st.variant} size="sm" className="shrink-0">
                  {st.label}
                </Badge>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
