import { useCallback, useEffect, useMemo, useState, useContext } from 'react';
import { AuthContext } from '@/lib/auth';
import type {
  CalendarFeedUrlResponse,
  OpenShiftsResponse,
  Shift,
} from '@alto-people/shared';
import {
  acknowledgeMyShift,
  claimOpenShift,
  getMyCalendarUrl,
  listMyAvailabilityExceptions,
  listMyOpenShifts,
  listMyShiftHistory,
  listMyShifts,
  rotateMyCalendarUrl,
  withdrawOpenShiftClaim,
} from '@/lib/schedulingApi';
import { ApiError, apiFetch } from '@/lib/api';
import { PageHeader } from '@/components/ui/PageHeader';
import { Skeleton, SkeletonRows } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { toast } from '@/components/ui/Toaster';
import { fmtDateTime, fmtHours, fmtMoneyEst, fmtRelativeDayTz, fmtShiftRangeTz, mapsUrl, zonedDayKey } from '@/lib/format';
import { cn } from '@/lib/cn';
import { enterStagger } from '@/lib/motion';
import {
  CalendarDays,
  Check,
  Copy,
  ExternalLink,
  HandHelping,
  RefreshCw,
  RotateCcw,
  WifiOff,
} from 'lucide-react';
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

type ScheduleViewMode = 'list' | 'week' | 'month';
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


export function AssociateScheduleView() {
  // Read the context directly rather than useAuth(): this view is also
  // rendered in isolation (tests, storybook-style harnesses) where no
  // provider is mounted, and the namespace is defense-in-depth on top of
  // the sign-out sweep — not worth throwing over.
  const cacheKey = cacheKeyFor(useContext(AuthContext)?.user?.id);
  const { t } = useI18n();
  const [shifts, setShifts] = useState<Shift[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  // The login has no linked employee record — a provisioning fault, not an
  // empty schedule. Rendered as a warning instead of the normal empty state.
  const [unlinked, setUnlinked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Set when rendering the cached copy because the network is down —
   *  the timestamp of that copy, shown in the offline banner. */
  const [offlineAt, setOfflineAt] = useState<number | null>(null);
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

  const load = async () => {
    try {
      setError(null);
      const res = await listMyShifts();
      setShifts(res.shifts);
      setTruncated(res.truncated === true);
      setUnlinked(res.unlinked === true);
      setOfflineAt(null);
      try {
        localStorage.setItem(
          cacheKey,
          JSON.stringify({ shifts: res.shifts, at: Date.now() }),
        );
      } catch {
        // Quota/private mode — offline fallback just won't be available.
      }
    } catch (err) {
      // An ApiError means the server ANSWERED (auth expired, 500…) — show
      // it. Anything else is the network being down: serve the cached copy
      // read-only with an offline banner instead of an error screen.
      if (!(err instanceof ApiError)) {
        try {
          const raw = localStorage.getItem(cacheKey);
          if (raw) {
            const cached = JSON.parse(raw) as { shifts: Shift[]; at: number };
            if (Array.isArray(cached.shifts) && typeof cached.at === 'number') {
              setShifts(cached.shifts);
              setOfflineAt(cached.at);
              return;
            }
          }
        } catch {
          // Corrupt cache — fall through to the plain error state.
        }
      }
      setError(err instanceof ApiError ? err.message : t('sched.loadFailed'));
    }
  };

  useEffect(() => {
    load();
  }, []);

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
  const [blockedDays, setBlockedDays] = useState<Set<string>>(new Set());
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [ex, pto] = await Promise.all([
          listMyAvailabilityExceptions(),
          listMyRequests(),
        ]);
        if (cancelled) return;
        const keys = new Set<string>();
        for (const x of ex.exceptions) keys.add(x.date);
        for (const r of pto.requests) {
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
        setBlockedDays(keys);
      } catch {
        // Non-essential decoration.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshNonce]);

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
  const [estRate, setEstRate] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    apiFetch<{ hourlyRate: number }>('/time/me/earnings')
      .then((d) => {
        if (!cancelled && Number.isFinite(d.hourlyRate) && d.hourlyRate > 0) {
          setEstRate(d.hourlyRate);
        }
      })
      .catch(() => {
        // No rate → no estimates; the schedule still works.
      });
    return () => {
      cancelled = true;
    };
  }, [refreshNonce]);

  // Confirming attendance — from the hero OR a list card — lands in the
  // page's copy of the shift, so the two surfaces can never disagree.
  const markAcknowledged = useCallback(
    (shiftId: string, acknowledgedAt: string) => {
      setShifts((prev) =>
        prev
          ? prev.map((s) => (s.id === shiftId ? { ...s, acknowledgedAt } : s))
          : prev,
      );
    },
    [],
  );

  // Split at "now" (ticks once a minute) into upcoming (ascending) and past
  // (descending), then group the upcoming list by store-local day. Week
  // totals use the viewer's local Sunday-start week — close enough for a
  // personal "am I heading into overtime" glance; payroll does its own math.
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
    const weekStart = new Date(now);
    weekStart.setHours(0, 0, 0, 0);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
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

  // Everything loaded so far (main window + paged history) for the
  // calendar views, deduped by id in case the windows ever overlap.
  const allShifts = useMemo(() => {
    const byId = new Map<string, Shift>();
    for (const s of [...(shifts ?? []), ...(history ?? [])]) byId.set(s.id, s);
    return Array.from(byId.values());
  }, [shifts, history]);
  const hasOlder = history === null || historyNextBefore !== null;

  return (
    <div className="mx-auto">
      <PullToRefreshIndicator state={pullState} />
      <PageHeader title={t('sched.title')} subtitle={t('sched.subtitle')} />

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
        <NextShiftHero
          shift={next}
          estRate={estRate}
          now={now}
          onAcknowledged={markAcknowledged}
        />
      )}

      {loaded && !isEmpty && (
        <div className="mb-4 flex items-center justify-between gap-3 flex-wrap">
          {/* One human sentence where the three-cell stat console stood —
              what's ahead, this week's hours, and the 40h flag folded in. */}
          {upcomingCount === 0 ? (
            <p className="text-sm text-silver">{t('sched.noUpcoming')}</p>
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

      {isEmpty &&
        (unlinked ? (
          <div
            role="alert"
            className="mb-4 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning"
          >
            {t('sched.unlinked')}
          </div>
        ) : (
          <EmptyState
            icon={CalendarDays}
            title={t('sched.noShifts')}
            description={t('sched.emptyDesc')}
          />
        ))}

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
                  <ShiftCard
                    key={s.id}
                    shift={s}
                    // The hero above owns "next" — no second gold ring here.
                    isNext={false}
                    appearIndex={i}
                    estRate={estRate}
                    onAcknowledged={markAcknowledged}
                    onSwapCreated={() => setSwapVersion((v) => v + 1)}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {loaded && <OpenShiftsSection key={refreshNonce} estRate={estRate} />}

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
        <CalendarSubscribeCard />
        <SwapMarketplace refreshToken={swapVersion} />
        <AvailabilityEditor />
      </div>
    </div>
  );
}

/**
 * The page's answer, as a hero: WHEN do I work next, and what's it worth.
 * Day + time in heavy sans, the shift's ~$ value, and the two actions that
 * matter (confirm, directions) zero taps deep. The list below stays the
 * full ledger — this is the scoreboard. Same card family as the earnings
 * hero: gradient face, one inset radial glow (success-green once the shift
 * is actually happening), never a negative-offset blur (e2e rect guard).
 */
function NextShiftHero({
  shift,
  estRate,
  now,
  onAcknowledged,
}: {
  shift: Shift;
  estRate: number | null;
  now: number;
  onAcknowledged: (shiftId: string, acknowledgedAt: string) => void;
}) {
  const { t } = useI18n();
  const [acking, setAcking] = useState(false);
  const started = new Date(shift.startsAt).getTime() <= now;
  const needsConfirm =
    shift.status === 'ASSIGNED' && !shift.acknowledgedAt && !started;
  const confirmed =
    shift.status === 'ASSIGNED' && Boolean(shift.acknowledgedAt) && !started;
  const est = estRate != null ? (paidShiftMinutes(shift) / 60) * estRate : null;
  const minsToStart = Math.max(
    0,
    Math.round((new Date(shift.startsAt).getTime() - now) / 60_000),
  );
  const countdown =
    minsToStart >= 60
      ? `${Math.floor(minsToStart / 60)}h${minsToStart % 60 ? ` ${minsToStart % 60}m` : ''}`
      : `${minsToStart}m`;
  const site = [shift.locationName, shift.location].filter(Boolean).join(' · ');

  const acknowledge = async () => {
    setAcking(true);
    try {
      const updated = await acknowledgeMyShift(shift.id);
      onAcknowledged(
        shift.id,
        updated.acknowledgedAt ?? new Date().toISOString(),
      );
      hapticConfirm();
      toast.success(t('shift.confirmedToast'));
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : t('shift.confirmFailed'),
      );
    } finally {
      setAcking(false);
    }
  };

  return (
    <section
      aria-label={t('sched.nextShift')}
      className={cn(
        'relative overflow-hidden rounded-lg border mb-4 animate-enter',
        started
          ? 'border-success/40 bg-navy bg-gradient-to-br from-success/[0.12] via-transparent to-transparent'
          : 'border-gold/30 bg-navy bg-gradient-to-br from-gold/[0.14] via-transparent to-transparent',
      )}
    >
      <div
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute inset-0',
          started
            ? 'bg-[radial-gradient(circle_at_15%_0%,rgb(var(--color-success)/0.14),transparent_55%)]'
            : 'bg-[radial-gradient(circle_at_15%_0%,rgb(var(--color-gold)/0.14),transparent_55%)]',
        )}
      />
      <div className="relative p-5">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-gold">
            <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
            {t('sched.nextShift')}
          </span>
          {started ? (
            <span className="flex items-center gap-1.5 text-xs text-success">
              <span className="relative flex h-2 w-2" aria-hidden="true">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60 motion-reduce:hidden" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
              </span>
              {t('sched.heroNow')}
            </span>
          ) : (
            minsToStart < 24 * 60 && (
              <span className="text-xs text-silver/80 tabular-nums">
                {t('sched.startsIn', { time: countdown })}
              </span>
            )
          )}
        </div>
        <div className="mt-2 text-3xl sm:text-4xl font-bold tracking-tight leading-tight text-white">
          {fmtRelativeDayTz(shift.startsAt, shift.timezone, now)}
          <span className="text-silver/50"> · </span>
          <span className="tabular-nums">
            {fmtShiftRangeTz(shift.startsAt, shift.endsAt, shift.timezone)}
          </span>
        </div>
        <p className="mt-1.5 text-sm text-silver">
          {shift.position}
          {shift.clientName ? ` · ${shift.clientName}` : ''}
          {est != null && est > 0 && (
            <span className="font-semibold text-gold">
              {' '}· {t('sched.heroWorth', { amount: fmtMoneyEst(est) })}
            </span>
          )}
        </p>
        {(needsConfirm || confirmed || site) && (
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
            {needsConfirm && (
              <Button
                size="sm"
                onClick={acknowledge}
                loading={acking}
                disabled={acking}
              >
                <Check className="h-3.5 w-3.5" />
                {t('shift.illBeThere')}
              </Button>
            )}
            {confirmed && (
              <span className="inline-flex items-center gap-1 text-xs text-success">
                <Check
                  className="h-3.5 w-3.5 animate-check-pop"
                  aria-hidden="true"
                />
                {t('shift.youConfirmed')}
              </span>
            )}
            {site && (
              <a
                href={mapsUrl(
                  [shift.clientName, shift.locationName, shift.location]
                    .filter(Boolean)
                    .join(' '),
                )}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center coarse:min-h-11 text-sm text-gold hover:text-gold-bright underline underline-offset-2"
              >
                {t('shift.directions')}
              </a>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * Published OPEN shifts at clients where this associate is placed, already
 * conflict/PTO-filtered by the server. Requesting one creates a PENDING
 * pickup claim for the manager to approve — hidden entirely when there's
 * nothing to offer, so the page stays quiet most days.
 */
function OpenShiftsSection({ estRate }: { estRate: number | null }) {
  const { t } = useI18n();
  const [items, setItems] = useState<OpenShiftsResponse['shifts'] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  // The row that just got claimed — plays the success flash once.
  const [flashId, setFlashId] = useState<string | null>(null);
  const [confirmShift, setConfirmShift] = useState<OpenShiftsResponse['shifts'][number] | null>(
    null,
  );

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const res = await listMyOpenShifts();
      setItems(res.shifts);
    } catch {
      // These rows are pickup MONEY — a failed fetch must say so quietly
      // and offer a retry, never silently pretend nothing is available.
      setFailed(true);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

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
  if (!items || items.length === 0) return null;

  const request = async (shift: OpenShiftsResponse['shifts'][number]) => {
    setBusyId(shift.id);
    try {
      const claim = await claimOpenShift(shift.id);
      setItems(
        (prev) =>
          prev?.map((s) =>
            s.id === shift.id
              ? { ...s, myClaimStatus: claim.status, myClaimId: claim.id }
              : s,
          ) ?? null,
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
      setItems(
        (prev) =>
          prev?.map((s) =>
            s.id === shift.id ? { ...s, myClaimStatus: null, myClaimId: null } : s,
          ) ?? null,
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
    <section className="mt-6">
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
  const [feed, setFeed] = useState<CalendarFeedUrlResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await getMyCalendarUrl();
        if (!cancelled) setFeed(res);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : t('sched.calLoadFailed'));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
      setFeed(res);
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

  return (
    <div className="mb-6 p-4 bg-navy border border-navy-secondary rounded-lg">
      <div className="flex items-start gap-3">
        <CalendarDays className="h-5 w-5 text-gold mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-white font-medium">{t('sched.calTitle')}</div>
          <div className="text-xs text-silver/70 mt-0.5">{t('sched.calBody')}</div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <code className="flex-1 min-w-0 truncate text-xs2 text-silver bg-navy-secondary/40 border border-navy-secondary rounded px-2 py-1.5 tabular-nums">
              {feed.url}
            </code>
            <Button onClick={onCopy} variant="secondary" className="shrink-0">
              {copied ? (
                <>
                  <Check className="h-3.5 w-3.5" />
                  {t('sched.calCopied')}
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" />
                  {t('sched.calCopyUrl')}
                </>
              )}
            </Button>
            <a
              href={feed.webcalUrl}
              className="inline-flex items-center gap-1 coarse:min-h-11 text-xs text-gold hover:text-gold-bright active:text-gold-bright underline underline-offset-2"
            >
              <ExternalLink className="h-3 w-3" />
              {t('sched.calOpenApple')}
            </a>
            <button
              type="button"
              onClick={() => setConfirmReset(true)}
              className="inline-flex items-center gap-1 coarse:min-h-11 text-xs text-silver/70 hover:text-white active:text-white underline underline-offset-2 transition-colors"
            >
              <RotateCcw className="h-3 w-3" />
              {t('sched.calResetLink')}
            </button>
          </div>
        </div>
      </div>
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
