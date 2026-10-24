import { Fragment, useCallback, useEffect, useMemo, useState, useContext } from 'react';
import { AuthContext } from '@/lib/auth';
import type {
  CalendarFeedUrlResponse,
  OpenShiftsResponse,
  Shift,
} from '@alto-people/shared';
import {
  claimOpenShift,
  declineMyShift,
  getMyAvailability,
  getMyCalendarUrl,
  listMyAvailabilityExceptions,
  listMyOpenShifts,
  listMyShiftHistory,
  listMyShifts,
  rotateMyCalendarUrl,
  withdrawOpenShiftClaim,
} from '@/lib/schedulingApi';
import { patchNotificationPreference } from '@/lib/settingsApi';
import { ApiError, apiFetch } from '@/lib/api';
import { Skeleton, SkeletonRows } from '@/components/ui/Skeleton';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Drawer, DrawerBody, DrawerHeader, DrawerTitle } from '@/components/ui/Drawer';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { toast } from '@/components/ui/Toaster';
import { fmtDateTime, fmtHours, fmtMoneyEst, fmtRelativeDayTz, fmtShiftRangeTz, mapsUrl, zonedDayKey } from '@/lib/format';
import { cn } from '@/lib/cn';
import { enterStagger } from '@/lib/motion';
import {
  BellRing,
  CalendarDays,
  CalendarPlus,
  Check,
  Clock,
  Copy,
  ExternalLink,
  HandHelping,
  RefreshCw,
  RotateCcw,
  UserX,
  WifiOff,
} from '@/components/ui/icons';
import { useUrlParam } from '@/lib/useUrlState';
import { listMyRequests } from '@/lib/timeOffApi';
import {
  PullToRefreshIndicator,
  usePullToRefresh,
} from '@/lib/usePullToRefresh';
import { hapticConfirm } from '@/lib/haptics';
import { useI18n } from '@/lib/i18n';
import { AvailabilityEditor } from './AvailabilityEditor';
import { SwapMarketplace } from './SwapMarketplace';
import { ShiftCard, paidShiftMinutes } from './ShiftCard';
import {
  ScheduleMonthView,
  ScheduleWeekView,
} from './AssociateScheduleCalendar';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getActiveTimeEntry } from '@/lib/timeApi';
import { MyShiftHero } from '@/pages/associate/MyShiftHero';
import { ListTemplate } from '@/components/templates';
import { workweekStart } from '@/lib/workweek';
import '@/lib/i18n/en/avail';
import '@/lib/i18n/en/sched';
import '@/lib/i18n/en/shift';

type ScheduleViewMode = 'list' | 'week' | 'month';
const SHEETS = ['', 'availability', 'calendar'] as const;
const VIEW_STORAGE_KEY = 'alto:mySchedule.view.v1';
// Last successfully-loaded schedule, for offline fallback. An associate
// opening the app in a dead-signal stockroom should still see their week.
// Namespaced per user: an unscoped key meant the next associate to sign
// in on a shared store tablet read the PREVIOUS one's roster out of the
// offline cache. Sign-out also sweeps this (see auth.tsx), so the
// namespace is belt-and-braces for the mid-session switch.
const cacheKeyFor = (userId: string | undefined) =>
  `alto:mySchedule.cache.v2:${userId ?? 'anon'}`;

function initialViewMode(): ScheduleViewMode {
  try {
    const raw = localStorage.getItem(VIEW_STORAGE_KEY);
    if (raw === 'list' || raw === 'week' || raw === 'month') return raw;
  } catch {
    // Private-mode/quota errors → just default.
  }
  return 'list';
}


/** What the schedule read yields — the rows, the server's flags, and the
 *  timestamp of the saved copy when that is what is being shown. */
interface ScheduleRead {
  shifts: Shift[];
  truncated: boolean;
  unlinked: boolean;
  offlineAt: number | null;
}

export function AssociateScheduleView() {
  // Read the context directly rather than useAuth(): this view is also
  // rendered in isolation (tests, storybook-style harnesses) where no
  // provider is mounted, and the namespace is defense-in-depth on top of
  // the sign-out sweep — not worth throwing over.
  const cacheKey = cacheKeyFor(useContext(AuthContext)?.user?.id);
  const { t } = useI18n();
  const [refreshing, setRefreshing] = useState(false);
  const [showPast, setShowPast] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [view, setView] = useState<ScheduleViewMode>(initialViewMode);

  const changeView = (v: ScheduleViewMode) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, v);
    } catch {
      // Best-effort persistence only.
    }
  };
  // Bumped when a swap is created from a shift card so the SwapMarketplace
  // section below refetches and shows the new outgoing request immediately.
  const [swapVersion, setSwapVersion] = useState(0);
  // Remounts self-loading child sections (open shifts) on manual Refresh.
  const [refreshNonce, setRefreshNonce] = useState(0);
  // Paged history older than the main list's 30-day window.
  const [history, setHistory] = useState<Shift[] | null>(null);
  const [historyNextBefore, setHistoryNextBefore] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  const loadOlder = async () => {
    setHistoryLoading(true);
    try {
      const res = await listMyShiftHistory(
        history === null ? undefined : historyNextBefore ?? undefined,
      );
      setHistory([...(history ?? []), ...res.shifts]);
      setHistoryNextBefore(res.nextBefore);
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : t('sched.loadOlderFailed'),
      );
    } finally {
      setHistoryLoading(false);
    }
  };

  // The schedule, with the offline fallback inside the read. An ApiError
  // means the server ANSWERED (auth expired, 500…) and is shown; anything
  // else is the network being down, and the copy this device last saved is
  // served read-only with an offline banner instead of an error screen.
  // Not under ['me', 'shifts']: the hero invalidates that prefix after a
  // confirmation, and this page keeps its own copy patched in place.
  const scheduleKey = ['me', 'schedule', cacheKey] as const;
  const scheduleQuery = useQuery({
    queryKey: scheduleKey,
    queryFn: async (): Promise<ScheduleRead> => {
      try {
        const res = await listMyShifts();
        try {
          localStorage.setItem(cacheKey, JSON.stringify({ shifts: res.shifts, at: Date.now() }));
        } catch {
          // Quota/private mode — offline fallback just won't be available.
        }
        return {
          shifts: res.shifts,
          truncated: res.truncated === true,
          unlinked: res.unlinked === true,
          offlineAt: null,
        };
      } catch (err) {
        if (!(err instanceof ApiError)) {
          try {
            const raw = localStorage.getItem(cacheKey);
            if (raw) {
              const cached = JSON.parse(raw) as { shifts: Shift[]; at: number };
              if (Array.isArray(cached.shifts) && typeof cached.at === 'number') {
                return { shifts: cached.shifts, truncated: false, unlinked: false, offlineAt: cached.at };
              }
            }
          } catch {
            // Corrupt cache — fall through to the plain error state.
          }
        }
        throw err;
      }
    },
  });
  const shifts: Shift[] | null = scheduleQuery.data?.shifts ?? null;
  const truncated = scheduleQuery.data?.truncated ?? false;
  // The login has no linked employee record — a provisioning fault, not an
  // empty schedule. Rendered as a warning instead of the normal empty state.
  const unlinked = scheduleQuery.data?.unlinked ?? false;
  /** Set when rendering the cached copy because the network is down —
   *  the timestamp of that copy, shown in the offline banner. */
  const offlineAt = scheduleQuery.data?.offlineAt ?? null;
  const error = scheduleQuery.error
    ? scheduleQuery.error instanceof ApiError
      ? scheduleQuery.error.message
      : t('sched.loadFailed')
    : null;
  const { refetch: refetchSchedule } = scheduleQuery;
  const load = async () => {
    await refetchSchedule();
  };
  const queryCache = useQueryClient();

  // Tick "now" each minute so the upcoming/past divide and the
  // Today/Tomorrow headings don't go stale while the tab sits open —
  // without it, yesterday's shift still reads "Today" after midnight
  // until the user manually refreshes.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  // Days the associate can't work (one-off days off + approved time off) —
  // painted on the calendar views. Decorative: a failed fetch just leaves
  // the calendar unpainted.
  // Empty availability is the reason a new hire sees no open shifts — say
  // so on the schedule itself (role walk, floor 11). Same key as the editor
  // below, so one read serves both.
  const availabilityQuery = useQuery({
    queryKey: ['AvailabilityEditor', 'drafts'],
    queryFn: () => getMyAvailability(),
  });
  const availabilityEmpty = availabilityQuery.data !== undefined && availabilityQuery.data.windows.length === 0;

  const blockedQuery = useQuery({
    queryKey: ['me', 'blocked-days', refreshNonce],
    queryFn: async () => {
      const [ex, pto] = await Promise.all([listMyAvailabilityExceptions(), listMyRequests()]);
      return { exceptions: ex.exceptions, requests: pto.requests };
    },
  });
  const blockedDays = useMemo(() => {
    const keys = new Set<string>();
    // Non-essential decoration: a failed read leaves the calendar unpainted.
    if (!blockedQuery.data) return keys;
    for (const x of blockedQuery.data.exceptions) keys.add(x.date);
    for (const r of blockedQuery.data.requests) {
      if (r.status !== 'APPROVED') continue;
      // Expand the inclusive range via LOCAL-midnight dates so keys
      // match the calendar's browser-local grid; bounded so a typo'd
      // multi-year range can't spin.
      const end = new Date(`${r.endDate}T00:00:00`);
      const d = new Date(`${r.startDate}T00:00:00`);
      for (let i = 0; d <= end && i < 180; i++, d.setDate(d.getDate() + 1)) {
        keys.add(zonedDayKey(d));
      }
    }
    return keys;
  }, [blockedQuery.data]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshNonce((v) => v + 1);
    setRefreshing(false);
  };
  const pullState = usePullToRefresh(onRefresh);

  // The associate's hourly rate (comp record or org default, from the same
  // endpoint that powers the earnings card) — prices every "~$" on this
  // page. Decorative: a failed fetch just leaves the money off.
  const rateQuery = useQuery({
    queryKey: ['me', 'earnings-rate', refreshNonce],
    queryFn: () => apiFetch<{ hourlyRate: number }>('/time/me/earnings'),
  });
  // No rate → no estimates; the schedule still works.
  const estRate =
    rateQuery.data && Number.isFinite(rateQuery.data.hourlyRate) && rateQuery.data.hourlyRate > 0
      ? rateQuery.data.hourlyRate
      : null;
  // Their punch, from the kiosk — the shift card reads on / late / coming up
  // off it (same cache as the home's).
  const activeQuery = useQuery({
    queryKey: ['me', 'activeEntry'],
    queryFn: () => getActiveTimeEntry().catch(() => null),
  });

  // Confirming attendance — from the hero OR a list card — lands in the
  // page's copy of the shift, so the two surfaces can never disagree.
  // A shift the server answered for (declined, re-confirmed): swap the row
  // in place, no refetch, no scroll loss.
  const patchShift = useCallback(
    (updated: Shift) => {
      queryCache.setQueryData<ScheduleRead>(scheduleKey, (prev) =>
        prev ? { ...prev, shifts: prev.shifts.map((s) => (s.id === updated.id ? updated : s)) } : prev,
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queryCache, cacheKey],
  );

  const markAcknowledged = useCallback(
    (shiftId: string, acknowledgedAt: string) => {
      queryCache.setQueryData<ScheduleRead>(scheduleKey, (prev) =>
        prev
          ? { ...prev, shifts: prev.shifts.map((s) => (s.id === shiftId ? { ...s, acknowledgedAt } : s)) }
          : prev,
      );
    },
    // scheduleKey is a fresh tuple each render; cacheKey is its moving part.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queryCache, cacheKey],
  );

  // Split at "now" (ticks once a minute) into upcoming (ascending) and past
  // (descending), then group the upcoming list by store-local day. Week
  // totals use the Sat→Fri workweek payroll counts overtime on.
  const {
    upcomingDays,
    past,
    next,
    upcomingCount,
    thisWeekMinutes,
    nextWeekMinutes,
  } = useMemo(() => {
    const all = shifts ?? [];
    // Week boundaries have to advance by CALENDAR days, not by a fixed
    // 7 × 86.4e6 ms — a week containing a DST change is 167 or 169 hours, so
    // millisecond arithmetic puts the boundary at 23:00 Saturday or 01:00
    // Sunday and shifts near midnight land in the wrong week's hour total.
    // The Sat→Fri workweek payroll and overtime count (lib/workweek).
    const weekStart = workweekStart(now);
    const addLocalDays = (from: Date, days: number) => {
      const d = new Date(from);
      d.setDate(d.getDate() + days);
      return d.getTime();
    };
    const w0 = weekStart.getTime();
    const w1 = addLocalDays(weekStart, 7);
    const w2 = addLocalDays(weekStart, 14);
    let thisWeekMin = 0;
    let nextWeekMin = 0;
    for (const s of all) {
      const t = new Date(s.startsAt).getTime();
      if (t >= w0 && t < w1) thisWeekMin += paidShiftMinutes(s);
      else if (t >= w1 && t < w2) nextWeekMin += paidShiftMinutes(s);
    }
    const up = all
      .filter((s) => new Date(s.endsAt).getTime() >= now)
      .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
    const old = all
      .filter((s) => new Date(s.endsAt).getTime() < now)
      .sort((a, b) => new Date(b.startsAt).getTime() - new Date(a.startsAt).getTime());

    const groups: Array<{
      dayKey: string;
      reactKey: string;
      heading: string;
      /** The group's day IS the viewer's today (store-local) — headed in gold. */
      isToday: boolean;
      /** Total scheduled minutes across the day's shifts — heading badge. */
      minutes: number;
      items: Shift[];
    }> = [];
    for (const s of up) {
      const key = zonedDayKey(s.startsAt, s.timezone);
      const last = groups[groups.length - 1];
      if (last && last.dayKey === key) {
        last.items.push(s);
        last.minutes += paidShiftMinutes(s);
      } else {
        groups.push({
          dayKey: key,
          // Shifts at sites in different timezones can interleave local-day
          // keys in this UTC-sorted list, yielding two runs with the same
          // day — suffix with the run index so sibling keys stay unique.
          reactKey: `${key}#${groups.length}`,
          heading: fmtRelativeDayTz(s.startsAt, s.timezone, now),
          isToday: key === zonedDayKey(new Date(now), s.timezone),
          minutes: paidShiftMinutes(s),
          items: [s],
        });
      }
    }
    return {
      upcomingDays: groups,
      past: old,
      // The hero: the first upcoming shift that's actually happening.
      next: up.find((s) => s.status !== 'CANCELLED') ?? null,
      upcomingCount: up.length,
      thisWeekMinutes: thisWeekMin,
      nextWeekMinutes: nextWeekMin,
    };
  }, [shifts, now]);

  const loaded = shifts !== null;
  const isEmpty = loaded && upcomingCount === 0 && past.length === 0;

  // The two set-up jobs open as sheets from the header (?sheet= so a link
  // — Open shifts' "Set my availability" — lands on one): availability
  // and its one-time days off, and adding the shifts to a calendar. They
  // sat inline under the schedule, a page of config after the shifts.
  const [sheet, setSheet] = useUrlParam<'' | 'availability' | 'calendar'>('sheet', '', SHEETS);
  // Same cache the open-shifts list below reads: the empty hero says how
  // many there are to pick up.
  const openShiftsQuery = useQuery({ queryKey: ['me', 'open-shifts'], queryFn: () => listMyOpenShifts() });
  const openShiftCount = openShiftsQuery.data?.shifts.length ?? null;

  // Everything loaded so far (main window + paged history) for the
  // calendar views, deduped by id in case the windows ever overlap.
  const allShifts = useMemo(() => {
    const byId = new Map<string, Shift>();
    for (const s of [...(shifts ?? []), ...(history ?? [])]) byId.set(s.id, s);
    return Array.from(byId.values());
  }, [shifts, history]);
  const hasOlder = history === null || historyNextBefore !== null;

  return (
    <>
      <PullToRefreshIndicator state={pullState} />
      {/* Design system §4.2 (UX upgrade step 6, the sweep): the List template. */}
      <ListTemplate
        title={t('sched.title')}
        subtitle={t('sched.subtitle')}
        actions={[
          { key: 'availability', label: t('sched.availAction'), icon: Clock, onSelect: () => setSheet('availability') },
          { key: 'calendar', label: t('sched.calAction'), icon: CalendarPlus, onSelect: () => setSheet('calendar') },
        ]}
      >

      {offlineAt !== null && (
        <div
          role="status"
          className="mb-4 flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning"
        >
          <WifiOff className="h-4 w-4 shrink-0" aria-hidden="true" />
          {t('sched.offline', { time: fmtDateTime(new Date(offlineAt)) })}
        </div>
      )}

      {/* The answer FIRST: the next shift as a hero, before any controls. */}
      {loaded && !isEmpty && next && (
        // The home's live shift card: late (amber) when the shift has
        // started and there's no punch — this said "Happening now" in green
        // to someone who hadn't clocked in.
        <MyShiftHero
          active={activeQuery.data}
          shifts={shifts ?? []}
          openShiftCount={null}
          estRate={estRate}
          onAcknowledged={markAcknowledged}
          showScheduleLink={false}
        />
      )}

      {/* No next shift: the hero's place says so, with the two ways to get
          one — pick up an open shift, or be told when one fits. */}
      {loaded && !unlinked && !error && upcomingCount === 0 && (
        <NoNextShift openCount={openShiftCount} />
      )}

      {loaded && !isEmpty && (
        <div className="mb-4 flex items-center justify-between gap-3 flex-wrap">
          {/* One human sentence where the three-cell stat console stood —
              what's ahead, this week's hours, and the 40h flag folded in. */}
          {upcomingCount === 0 ? (
            // The hero above already says it; the views still switch.
            <span />
          ) : (
            <p className="text-sm text-silver tabular-nums">
              {upcomingCount === 1
                ? t('sched.summaryAheadOne')
                : t('sched.summaryAhead', { count: upcomingCount })}
              {' · '}
              {t('sched.summaryThisWeek', {
                hours: fmtHours(thisWeekMinutes / 60),
              })}
              {nextWeekMinutes > 0 && (
                <>
                  {' · '}
                  {t('sched.summaryNextWeek', {
                    hours: fmtHours(nextWeekMinutes / 60),
                  })}
                </>
              )}
              {(thisWeekMinutes > 40 * 60 || nextWeekMinutes > 40 * 60) && (
                <span className="text-alert"> · {t('sched.over40')}</span>
              )}
            </p>
          )}
          <div className="flex items-center gap-2 flex-wrap justify-end">
            <SegmentedControl<ScheduleViewMode>
              ariaLabel={t('sched.viewAria')}
              options={[
                { value: 'list', label: t('sched.list') },
                { value: 'week', label: t('sched.week') },
                { value: 'month', label: t('sched.month') },
              ]}
              value={view}
              onChange={changeView}
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={onRefresh}
              loading={refreshing}
              disabled={refreshing}
              aria-label={t('sched.refresh')}
            >
              <RefreshCw className="h-4 w-4" />
              {/* Pull-to-refresh covers phones; the label only earns its
                  width where there's room. */}
              <span className="hidden sm:inline">{t('sched.refresh')}</span>
            </Button>
          </div>
        </div>
      )}

      {error && (
        <ErrorBanner
          className="mb-4"
          action={
            !loaded ? (
              <Button variant="secondary" size="sm" onClick={load}>
                <RefreshCw className="h-4 w-4" />
                {t('common.retry')}
              </Button>
            ) : undefined
          }
        >
          {error}
        </ErrorBanner>
      )}
      {!shifts && !error && <SkeletonRows count={4} rowHeight="h-20" />}

      {loaded && truncated && (
        <p className="mb-4 text-xs text-silver/70">{t('sched.truncated')}</p>
      )}

      {loaded && !unlinked && availabilityEmpty && (
        <div
          className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gold/40 bg-gold/10 px-4 py-3"
          data-testid="availability-prompt"
        >
          <div className="min-w-0">
            <div className="text-sm font-medium text-ink">{t('sched.setAvailTitle')}</div>
            <div className="text-xs text-silver">{t('sched.setAvailDesc')}</div>
          </div>
          <Button size="sm" onClick={() => setSheet('availability')}>
            {t('sched.setAvailCta')}
          </Button>
        </div>
      )}

      {isEmpty && unlinked && (
        <div
          role="alert"
          className="mb-4 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning"
        >
          {t('sched.unlinked')}
        </div>
      )}

      {loaded && !isEmpty && view === 'week' && (
        <ScheduleWeekView
          shifts={allShifts}
          now={now}
          blockedDays={blockedDays}
          onSwapCreated={() => setSwapVersion((v) => v + 1)}
          hasOlder={hasOlder}
          loadingOlder={historyLoading}
          onLoadOlder={loadOlder}
          estRate={estRate}
          onAcknowledged={markAcknowledged}
        />
      )}
      {loaded && !isEmpty && view === 'month' && (
        <ScheduleMonthView
          shifts={allShifts}
          now={now}
          blockedDays={blockedDays}
          onSwapCreated={() => setSwapVersion((v) => v + 1)}
          hasOlder={hasOlder}
          loadingOlder={historyLoading}
          onLoadOlder={loadOlder}
          estRate={estRate}
          onAcknowledged={markAcknowledged}
        />
      )}

      {loaded && view === 'list' && upcomingCount > 0 && (
        <div className="space-y-5">
          {upcomingDays.map((group) => (
            <section key={group.reactKey}>
              {/* Sentence-case day headers — a schedule, not a terminal. */}
              <h2 className="mb-2 flex items-baseline justify-between gap-3">
                <span
                  className={
                    group.isToday
                      ? 'text-sm font-semibold text-gold'
                      : 'text-sm font-medium text-silver'
                  }
                >
                  {group.heading}
                </span>
                <span className="text-xs text-silver/60 tabular-nums">
                  {t(group.items.length === 1 ? 'sched.shiftsWord' : 'sched.shiftsWordPlural', {
                    count: group.items.length,
                  })}
                  {' · '}
                  {fmtHours(group.minutes / 60)}
                </span>
              </h2>
              <ul className="space-y-2">
                {group.items.map((s, i) => (
                  <Fragment key={s.id}>
                    <ShiftCard
                      shift={s}
                      // The hero above owns "next" — no second gold ring here.
                      isNext={false}
                      appearIndex={i}
                      estRate={estRate}
                      onAcknowledged={markAcknowledged}
                      onSwapCreated={() => setSwapVersion((v) => v + 1)}
                    />
                    {canDeclineShift(s, now) && (
                      <DeclineMyShiftRow shift={s} onDeclined={(updated) => patchShift(updated)} />
                    )}
                  </Fragment>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {/* With no next shift the hero above offers "Notify me" — the empty
          open-shifts card would say it twice. */}
      {loaded && <OpenShiftsSection key={refreshNonce} estRate={estRate} quietWhenEmpty={upcomingCount === 0} />}

      {loaded && view === 'list' && (past.length > 0 || (history?.length ?? 0) > 0) && (
        <div className="mt-6">
          <button
            type="button"
            onClick={() => setShowPast((v) => !v)}
            className="inline-flex items-center coarse:min-h-11 text-sm text-silver/80 hover:text-white active:text-white transition-colors"
          >
            {t(showPast ? 'sched.hideRecent' : 'sched.showRecent', {
              count: past.length + (history?.length ?? 0),
            })}
          </button>
          {showPast && (
            <>
              <ul className="space-y-2 mt-3">
                {past.map((s) => (
                  <ShiftCard key={s.id} shift={s} isNext={false} muted />
                ))}
                {(history ?? []).map((s) => (
                  <ShiftCard key={s.id} shift={s} isNext={false} muted />
                ))}
              </ul>
              {hasOlder && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-3"
                  onClick={loadOlder}
                  loading={historyLoading}
                  disabled={historyLoading}
                >
                  {t('sched.loadOlder')}
                </Button>
              )}
              {!hasOlder && (
                <p className="mt-3 text-xs text-silver/60">{t('sched.fullHistory')}</p>
              )}
            </>
          )}
        </div>
      )}

      <div className="mt-8">
        <SwapMarketplace refreshToken={swapVersion} />
      </div>
      </ListTemplate>

      <Drawer open={sheet === 'availability'} onOpenChange={(o) => setSheet(o ? 'availability' : '')}>
        <DrawerHeader>
          <DrawerTitle>{t('avail.title')}</DrawerTitle>
        </DrawerHeader>
        <DrawerBody>
          <AvailabilityEditor embedded />
        </DrawerBody>
      </Drawer>
      <Drawer open={sheet === 'calendar'} onOpenChange={(o) => setSheet(o ? 'calendar' : '')}>
        <DrawerHeader>
          <DrawerTitle>{t('sched.calAction')}</DrawerTitle>
        </DrawerHeader>
        <DrawerBody>
          <CalendarSubscribeCard />
        </DrawerBody>
      </Drawer>
    </>
  );
}

/**
 * Published OPEN shifts at clients where this associate is placed, already
 * conflict/PTO-filtered by the server. Requesting one creates a PENDING
 * pickup claim for the manager to approve — hidden entirely when there's
 * nothing to offer, so the page stays quiet most days.
 */
function OpenShiftsSection({ estRate, quietWhenEmpty = false }: { estRate: number | null; quietWhenEmpty?: boolean }) {
  const { t } = useI18n();
  const [busyId, setBusyId] = useState<string | null>(null);
  // The row that just got claimed — plays the success flash once.
  const [flashId, setFlashId] = useState<string | null>(null);
  const [confirmShift, setConfirmShift] = useState<OpenShiftsResponse['shifts'][number] | null>(
    null,
  );

  // These rows are pickup MONEY — a failed read must say so quietly and
  // offer a retry, never silently pretend nothing is available.
  const openQuery = useQuery({ queryKey: ['me', 'open-shifts'], queryFn: () => listMyOpenShifts() });
  const items: OpenShiftsResponse['shifts'] | null = openQuery.data?.shifts ?? null;
  const failed = openQuery.isError;
  const { refetch: refetchOpen } = openQuery;
  const load = useCallback(async () => {
    await refetchOpen();
  }, [refetchOpen]);
  const queryCache = useQueryClient();
  const patchItems = (update: (prev: OpenShiftsResponse['shifts']) => OpenShiftsResponse['shifts']) =>
    queryCache.setQueryData<OpenShiftsResponse>(['me', 'open-shifts'], (prev) =>
      prev ? { ...prev, shifts: update(prev.shifts) } : prev,
    );

  if (failed) {
    return (
      <section className="mt-6">
        <p className="text-xs text-silver/70">
          {t('sched.openLoadFailed')}{' '}
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex items-center coarse:min-h-11 text-gold hover:text-gold-bright underline underline-offset-2"
          >
            {t('common.retry')}
          </button>
        </p>
      </section>
    );
  }
  if (!items) return null;
  if (items.length === 0) return quietWhenEmpty ? null : <NoOpenShifts />;

  const request = async (shift: OpenShiftsResponse['shifts'][number]) => {
    setBusyId(shift.id);
    try {
      const claim = await claimOpenShift(shift.id);
      patchItems((prev) =>
        prev.map((s) =>
          s.id === shift.id ? { ...s, myClaimStatus: claim.status, myClaimId: claim.id } : s,
        ),
      );
      setConfirmShift(null);
      hapticConfirm();
      // Haptic + row flash + toast land as one confirmation event.
      setFlashId(shift.id);
      toast.success(t('sched.pickupToast'));
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : t('sched.pickupFailed'),
      );
    } finally {
      setBusyId(null);
    }
  };

  const withdraw = async (shift: OpenShiftsResponse['shifts'][number]) => {
    if (!shift.myClaimId) return;
    setBusyId(shift.id);
    try {
      await withdrawOpenShiftClaim(shift.myClaimId);
      patchItems((prev) =>
        prev.map((s) => (s.id === shift.id ? { ...s, myClaimStatus: null, myClaimId: null } : s)),
      );
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : t('sched.withdrawFailed'),
      );
    } finally {
      setBusyId(null);
    }
  };

  // Lead with the prize: what the whole board is worth if they took it all.
  const totalEst =
    estRate != null
      ? items.reduce((sum, s) => sum + (paidShiftMinutes(s) / 60) * estRate, 0)
      : null;

  return (
    <section className="mt-6 scroll-mt-20" id="open-shifts">
      <h2 className="text-sm font-medium text-white mb-2 flex flex-wrap items-center gap-1.5">
        <HandHelping className="h-4 w-4 text-gold" aria-hidden="true" />
        {t('sched.openHeading', { count: items.length })}
        {totalEst != null && totalEst > 0 && (
          <span className="font-semibold text-gold">
            · {t('sched.openWorth', { amount: fmtMoneyEst(totalEst) })}
          </span>
        )}
      </h2>
      <ul className="space-y-2">
        {items.map((s, i) => (
          <li
            key={s.id}
            style={enterStagger(i)}
            className={cn(
              'flex items-center justify-between gap-4 p-4 rounded-lg border border-dashed border-navy-secondary bg-navy/60',
              flashId === s.id ? 'animate-flash-success' : 'animate-enter',
            )}
          >
            <div className="min-w-0">
              <div className="text-white font-medium">
                {s.position}{' '}
                <span className="text-silver text-sm font-normal">
                  · {s.clientName ?? '—'}
                </span>
              </div>
              <div className="text-sm text-silver tabular-nums">
                {fmtRelativeDayTz(s.startsAt, s.timezone)} ·{' '}
                {fmtShiftRangeTz(s.startsAt, s.endsAt, s.timezone)}
                {estRate != null && (
                  <span className="font-medium text-gold">
                    {' '}· {fmtMoneyEst((paidShiftMinutes(s) / 60) * estRate)}
                  </span>
                )}
              </div>
              {(s.locationName || s.location) && (
                <div className="flex flex-wrap items-center gap-x-2 text-xs text-silver/70">
                  <span>{[s.locationName, s.location].filter(Boolean).join(' · ')}</span>
                  <a
                    href={mapsUrl([s.clientName, s.locationName, s.location].filter(Boolean).join(' '))}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center coarse:min-h-11 text-gold hover:text-gold-bright underline underline-offset-2"
                  >
                    {t('shift.directions')}
                  </a>
                </div>
              )}
            </div>
            <div className="shrink-0">
              {s.myClaimStatus === 'PENDING' ? (
                <div className="flex flex-col items-end gap-1">
                  <Badge variant="accent">{t('sched.openRequested')}</Badge>
                  <button
                    type="button"
                    onClick={() => withdraw(s)}
                    disabled={busyId === s.id}
                    className="inline-flex items-center coarse:min-h-11 px-2 -mx-2 text-xs text-silver/70 hover:text-white active:text-white underline underline-offset-2"
                  >
                    {t('sched.openWithdraw')}
                  </button>
                </div>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setConfirmShift(s)}
                  disabled={busyId === s.id}
                >
                  {t('sched.openPickUp')}
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={confirmShift !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmShift(null);
        }}
        title={t('sched.pickupConfirmTitle')}
        description={
          confirmShift
            ? `${confirmShift.position} · ${
                confirmShift.clientName ?? '—'
              } · ${fmtRelativeDayTz(confirmShift.startsAt, confirmShift.timezone)}, ${fmtShiftRangeTz(
                confirmShift.startsAt,
                confirmShift.endsAt,
                confirmShift.timezone,
              )}. ${t('sched.pickupConfirmNote')}`
            : undefined
        }
        confirmLabel={t('sched.pickupConfirmLabel')}
        busy={confirmShift !== null && busyId === confirmShift.id}
        onConfirm={() => {
          if (confirmShift) return request(confirmShift);
        }}
      />
    </section>
  );
}

function CalendarSubscribeCard() {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const queryCache = useQueryClient();
  const feedQuery = useQuery({ queryKey: ['me', 'calendar-feed'], queryFn: () => getMyCalendarUrl() });
  const feed: CalendarFeedUrlResponse | null = feedQuery.data ?? null;
  const error = feedQuery.error
    ? feedQuery.error instanceof ApiError
      ? feedQuery.error.message
      : t('sched.calLoadFailed')
    : null;

  if (error) {
    return (
      <div className="mb-6 p-4 bg-navy border border-navy-secondary rounded-lg">
        <div className="flex items-start gap-3">
          <CalendarDays className="h-5 w-5 text-silver/60 mt-0.5 shrink-0" />
          <div className="text-xs text-silver/70">
            {t('sched.calUnavailable')} {error}
          </div>
        </div>
      </div>
    );
  }
  if (!feed) {
    return (
      <Skeleton className="mb-6 h-24" />
    );
  }

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(feed.url);
      setCopied(true);
      toast.success(t('sched.calCopiedToast'));
      setTimeout(() => setCopied(false), 2500);
    } catch {
      toast.error(t('sched.calCopyFailed'));
    }
  };

  const onReset = async () => {
    setResetting(true);
    try {
      const res = await rotateMyCalendarUrl();
      queryCache.setQueryData<CalendarFeedUrlResponse>(['me', 'calendar-feed'], res);
      setConfirmReset(false);
      toast.success(t('sched.calResetToast'));
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : t('sched.calResetFailed'),
      );
    } finally {
      setResetting(false);
    }
  };

  // Google subscribes to a feed by its webcal address.
  const googleUrl = `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(feed.webcalUrl)}`;
  return (
    <div data-testid="calendar-sheet">
      <p className="text-sm text-silver">{t('sched.calBody')}</p>
      {/* Three ways in, as buttons — the raw feed address isn't something
          to read, only to copy. */}
      <div className="mt-4 flex flex-col gap-2">
        <Button asChild variant="secondary" className="justify-start">
          <a href={feed.webcalUrl}>
            <ExternalLink className="h-4 w-4" aria-hidden="true" />
            {t('sched.calOpenApple')}
          </a>
        </Button>
        <Button asChild variant="secondary" className="justify-start">
          <a href={googleUrl} target="_blank" rel="noreferrer">
            <ExternalLink className="h-4 w-4" aria-hidden="true" />
            {t('sched.calGoogle')}
          </a>
        </Button>
        <Button onClick={onCopy} variant="secondary" className="justify-start">
          {copied ? (
            <>
              <Check className="h-4 w-4" aria-hidden="true" />
              {t('sched.calCopied')}
            </>
          ) : (
            <>
              <Copy className="h-4 w-4" aria-hidden="true" />
              {t('sched.calCopyUrl')}
            </>
          )}
        </Button>
      </div>
      <button
        type="button"
        onClick={() => setConfirmReset(true)}
        className="mt-4 inline-flex items-center gap-1 coarse:min-h-11 text-xs text-silver/70 hover:text-white active:text-white underline underline-offset-2 transition-colors"
      >
        <RotateCcw className="h-3 w-3" aria-hidden="true" />
        {t('sched.calResetLink')}
      </button>
      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title={t('sched.calResetConfirmTitle')}
        description={t('sched.calResetConfirmDesc')}
        confirmLabel={t('sched.calResetLink')}
        destructive
        busy={resetting}
        onConfirm={onReset}
      />
    </div>
  );
}

/**
 * "I can't make it" — offered only on an assigned, published, future shift
 * the Workforce agent asked about and the person has not answered. The API
 * answers 409 `not_asked` for any other shift; that message is shown plainly.
 */
export function canDeclineShift(s: Shift, now: number): boolean {
  return (
    s.status === 'ASSIGNED' &&
    !!s.publishedAt &&
    !!s.confirmationAsk &&
    s.confirmationAsk.answer === null &&
    new Date(s.startsAt).getTime() > now
  );
}

function DeclineMyShiftRow({ shift, onDeclined }: { shift: Shift; onDeclined: (s: Shift) => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const decline = async () => {
    setBusy(true);
    try {
      const updated = await declineMyShift(shift.id);
      onDeclined(updated);
      toast.success(t('sched.cantMakeDone'));
    } catch (err) {
      toast.error(
        err instanceof ApiError && err.code === 'not_asked'
          ? t('sched.cantMakeNotAsked')
          : err instanceof ApiError
            ? err.message
            : t('sched.cantMakeFailed'),
      );
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };
  return (
    <li className="-mt-1 flex justify-end" data-testid="decline-my-shift">
      <Button
        size="sm"
        variant="ghost"
        className="text-silver hover:text-alert"
        onClick={() => setConfirming(true)}
        disabled={busy}
      >
        <UserX className="h-3.5 w-3.5" aria-hidden="true" />
        {t('sched.cantMake')}
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => !busy && setConfirming(open)}
        title={t('sched.cantMake')}
        description={`${fmtRelativeDayTz(shift.startsAt, shift.timezone)} · ${fmtShiftRangeTz(shift.startsAt, shift.endsAt, shift.timezone)}`}
        confirmLabel={t('sched.cantMake')}
        destructive
        onConfirm={decline}
        busy={busy}
      />
    </li>
  );
}

/** "Notify me": schedule notifications on, so the next fit reaches them. */
function useNotifyMe() {
  const { t } = useI18n();
  const [state, setState] = useState<'idle' | 'busy' | 'on'>('idle');
  const notify = async () => {
    setState('busy');
    try {
      await patchNotificationPreference('scheduling', { inAppEnabled: true, emailEnabled: true, pushEnabled: true });
      setState('on');
      toast.success(t('sched.notifyOn'));
    } catch (err) {
      setState('idle');
      toast.error(err instanceof ApiError ? err.message : t('sched.notifyFailed'));
    }
  };
  return { state, notify };
}

function NotifyMeButton({ variant = 'outline' }: { variant?: 'outline' | 'secondary' }) {
  const { t } = useI18n();
  const { state, notify } = useNotifyMe();
  return state === 'on' ? (
    <span className="inline-flex items-center gap-1 text-xs text-success">
      <Check className="h-3.5 w-3.5" aria-hidden="true" />
      {t('sched.notifyOn')}
    </span>
  ) : (
    <Button size="sm" variant={variant} onClick={notify} loading={state === 'busy'} disabled={state === 'busy'}>
      <BellRing className="h-3.5 w-3.5" aria-hidden="true" />
      {t('sched.notifyMe')}
    </Button>
  );
}

/**
 * The hero's place when there is no next shift (F500 G2): what's true —
 * nothing is coming up — and the two ways to change it: pick up an open
 * shift (when there are some), or be told when one fits.
 */
function NoNextShift({ openCount }: { openCount: number | null }) {
  const { t } = useI18n();
  const hasOpen = (openCount ?? 0) > 0;
  return (
    <section
      className="mb-4 rounded-lg border border-navy-secondary bg-navy-secondary/30 p-4"
      data-testid="no-next-shift"
      aria-labelledby="no-next-shift-title"
    >
      <div className="flex items-start gap-3">
        <CalendarDays className="mt-0.5 h-5 w-5 shrink-0 text-gold" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h2 id="no-next-shift-title" className="text-base font-medium text-ink">
            {t('sched.noNextTitle')}
          </h2>
          <p className="mt-0.5 text-sm text-silver">
            {hasOpen ? t('sched.noNextOpen', { count: openCount ?? 0 }) : t('sched.noNextDesc')}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {hasOpen && (
              <Button
                size="sm"
                onClick={() => document.getElementById('open-shifts')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              >
                <HandHelping className="h-3.5 w-3.5" aria-hidden="true" />
                {t('sched.pickUpOpen')}
              </Button>
            )}
            <NotifyMeButton variant={hasOpen ? 'outline' : 'secondary'} />
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * The open-shifts section no longer disappears when it is empty: a new hire
 * never learned why nothing came their way. One tap turns schedule
 * notifications on so the next fit reaches them.
 */
function NoOpenShifts() {
  const { t } = useI18n();
  return (
    <section className="mt-6" data-testid="no-open-shifts">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed border-navy-secondary bg-navy/60 px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-sm font-medium text-ink">
            <HandHelping className="h-4 w-4 text-gold" aria-hidden="true" />
            {t('sched.noOpenTitle')}
          </div>
          <div className="text-xs text-silver">{t('sched.noOpenDesc')}</div>
        </div>
        <NotifyMeButton />
      </div>
    </section>
  );
}
