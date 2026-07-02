import { useEffect, useMemo, useState } from 'react';
import type {
  CalendarFeedUrlResponse,
  OpenShiftsResponse,
  Shift,
} from '@alto-people/shared';
import {
  claimOpenShift,
  getMyCalendarUrl,
  listMyOpenShifts,
  listMyShiftHistory,
  listMyShifts,
  rotateMyCalendarUrl,
  withdrawOpenShiftClaim,
} from '@/lib/schedulingApi';
import { ApiError } from '@/lib/api';
import { PageHeader } from '@/components/ui/PageHeader';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { toast } from '@/components/ui/Toaster';
import { fmtRelativeDayTz, fmtShiftRangeTz, zonedDayKey } from '@/lib/format';
import {
  CalendarDays,
  Check,
  Copy,
  ExternalLink,
  HandHelping,
  RefreshCw,
  RotateCcw,
} from 'lucide-react';
import { AvailabilityEditor } from './AvailabilityEditor';
import { SwapMarketplace } from './SwapMarketplace';
import { ShiftCard, shiftMinutes } from './ShiftCard';
import {
  ScheduleMonthView,
  ScheduleWeekView,
} from './AssociateScheduleCalendar';

type ScheduleViewMode = 'list' | 'week' | 'month';
const VIEW_STORAGE_KEY = 'alto:mySchedule.view.v1';

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
  const [shifts, setShifts] = useState<Shift[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
        err instanceof ApiError ? err.message : 'Could not load older shifts.',
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
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load.');
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

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshNonce((v) => v + 1);
    setRefreshing(false);
  };

  // Split at "now" (ticks once a minute) into upcoming (ascending) and past
  // (descending), then group the upcoming list by store-local day. Week
  // totals use the viewer's local Sunday-start week — close enough for a
  // personal "am I heading into overtime" glance; payroll does its own math.
  const {
    upcomingDays,
    past,
    nextId,
    upcomingCount,
    upcomingHours,
    thisWeekMinutes,
    nextWeekMinutes,
  } = useMemo(() => {
    const all = shifts ?? [];
    const weekStart = new Date(now);
    weekStart.setHours(0, 0, 0, 0);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    const w0 = weekStart.getTime();
    const w1 = w0 + 7 * 86_400_000;
    const w2 = w1 + 7 * 86_400_000;
    let thisWeekMin = 0;
    let nextWeekMin = 0;
    for (const s of all) {
      const t = new Date(s.startsAt).getTime();
      if (t >= w0 && t < w1) thisWeekMin += shiftMinutes(s);
      else if (t >= w1 && t < w2) nextWeekMin += shiftMinutes(s);
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
      items: Shift[];
    }> = [];
    for (const s of up) {
      const key = zonedDayKey(s.startsAt, s.timezone);
      const last = groups[groups.length - 1];
      if (last && last.dayKey === key) last.items.push(s);
      else {
        groups.push({
          dayKey: key,
          // Shifts at sites in different timezones can interleave local-day
          // keys in this UTC-sorted list, yielding two runs with the same
          // day — suffix with the run index so sibling keys stay unique.
          reactKey: `${key}#${groups.length}`,
          heading: fmtRelativeDayTz(s.startsAt, s.timezone, now),
          items: [s],
        });
      }
    }
    const minutes = up.reduce((sum, s) => sum + shiftMinutes(s), 0);
    return {
      upcomingDays: groups,
      past: old,
      nextId: up[0]?.id ?? null,
      upcomingCount: up.length,
      upcomingHours: minutes / 60,
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
      <PageHeader title="My schedule" subtitle="Your published shifts." />

      {loaded && !isEmpty && (
        <div className="mb-4 flex items-center justify-between gap-3">
          <p className="text-sm text-silver">
            {upcomingCount === 0 ? (
              'No upcoming shifts.'
            ) : (
              <>
                <span className="text-white font-medium">{upcomingCount}</span>{' '}
                upcoming {upcomingCount === 1 ? 'shift' : 'shifts'} ·{' '}
                <span className="text-white font-medium tabular-nums">
                  {upcomingHours.toFixed(1)}
                </span>{' '}
                hrs scheduled
              </>
            )}
          </p>
          <div className="flex items-center gap-2 flex-wrap justify-end">
            <SegmentedControl<ScheduleViewMode>
              ariaLabel="Schedule view"
              options={[
                { value: 'list', label: 'List' },
                { value: 'week', label: 'Week' },
                { value: 'month', label: 'Month' },
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
            >
              <RefreshCw className="h-4 w-4" />
              Refresh
            </Button>
          </div>
        </div>
      )}

      {error && (
        <div role="alert" className="mb-4 flex items-center gap-3">
          <p className="text-sm text-alert">{error}</p>
          {!loaded && (
            <Button variant="secondary" size="sm" onClick={load}>
              <RefreshCw className="h-4 w-4" />
              Retry
            </Button>
          )}
        </div>
      )}
      {!shifts && !error && <SkeletonRows count={4} rowHeight="h-20" />}

      {loaded && truncated && (
        <p className="mb-4 text-xs text-silver/70">
          Showing your next 100 shifts — anything scheduled beyond them will
          appear here as earlier shifts pass.
        </p>
      )}

      {loaded && (thisWeekMinutes > 0 || nextWeekMinutes > 0) && (
        <p className="mb-4 text-xs text-silver tabular-nums">
          This week{' '}
          <span className={thisWeekMinutes > 40 * 60 ? 'text-alert font-medium' : 'text-white'}>
            {(thisWeekMinutes / 60).toFixed(1)}h
          </span>
          {' · '}Next week{' '}
          <span className={nextWeekMinutes > 40 * 60 ? 'text-alert font-medium' : 'text-white'}>
            {(nextWeekMinutes / 60).toFixed(1)}h
          </span>
          {(thisWeekMinutes > 40 * 60 || nextWeekMinutes > 40 * 60) && (
            <span className="text-alert"> · over 40h — check with your manager</span>
          )}
        </p>
      )}

      {isEmpty && (
        <EmptyState
          icon={CalendarDays}
          title="No shifts yet"
          description="When a manager publishes a shift for you, it'll show up here. Post your availability below to make scheduling easier."
        />
      )}

      {loaded && !isEmpty && view === 'week' && (
        <ScheduleWeekView
          shifts={allShifts}
          now={now}
          onSwapCreated={() => setSwapVersion((v) => v + 1)}
          hasOlder={hasOlder}
          loadingOlder={historyLoading}
          onLoadOlder={loadOlder}
        />
      )}
      {loaded && !isEmpty && view === 'month' && (
        <ScheduleMonthView
          shifts={allShifts}
          now={now}
          onSwapCreated={() => setSwapVersion((v) => v + 1)}
          hasOlder={hasOlder}
          loadingOlder={historyLoading}
          onLoadOlder={loadOlder}
        />
      )}

      {loaded && view === 'list' && upcomingCount > 0 && (
        <div className="space-y-5">
          {upcomingDays.map((group) => (
            <section key={group.reactKey}>
              <h2 className="text-[11px] uppercase tracking-wider text-silver/80 mb-2">
                {group.heading}
              </h2>
              <ul className="space-y-2">
                {group.items.map((s) => (
                  <ShiftCard
                    key={s.id}
                    shift={s}
                    isNext={s.id === nextId}
                    onSwapCreated={() => setSwapVersion((v) => v + 1)}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {loaded && <OpenShiftsSection key={refreshNonce} />}

      {loaded && view === 'list' && (past.length > 0 || (history?.length ?? 0) > 0) && (
        <div className="mt-6">
          <button
            type="button"
            onClick={() => setShowPast((v) => !v)}
            className="text-xs uppercase tracking-wider text-silver/80 hover:text-white transition-colors"
          >
            {showPast ? 'Hide' : 'Show'} recent shifts ({past.length + (history?.length ?? 0)})
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
              {(history === null || historyNextBefore !== null) && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-3"
                  onClick={loadOlder}
                  loading={historyLoading}
                  disabled={historyLoading}
                >
                  Load older shifts
                </Button>
              )}
              {history !== null && historyNextBefore === null && (
                <p className="mt-3 text-xs text-silver/60">
                  That's your full shift history.
                </p>
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
 * Published OPEN shifts at clients where this associate is placed, already
 * conflict/PTO-filtered by the server. Requesting one creates a PENDING
 * pickup claim for the manager to approve — hidden entirely when there's
 * nothing to offer, so the page stays quiet most days.
 */
function OpenShiftsSection() {
  const [items, setItems] = useState<OpenShiftsResponse['shifts'] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmShift, setConfirmShift] = useState<OpenShiftsResponse['shifts'][number] | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await listMyOpenShifts();
        if (!cancelled) setItems(res.shifts);
      } catch {
        // Non-essential section: fail closed to hidden rather than noisy.
        if (!cancelled) setItems([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
      toast.success('Pickup requested — your manager will confirm it.');
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : 'Could not request this shift.',
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
        err instanceof ApiError ? err.message : 'Could not withdraw the request.',
      );
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="mt-6">
      <h2 className="text-[11px] uppercase tracking-wider text-silver/80 mb-2 flex items-center gap-1.5">
        <HandHelping className="h-3.5 w-3.5" aria-hidden="true" />
        Open shifts you can pick up ({items.length})
      </h2>
      <ul className="space-y-2">
        {items.map((s) => (
          <li
            key={s.id}
            className="flex items-center justify-between gap-4 p-4 rounded-lg border border-dashed border-navy-secondary bg-navy/60"
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
              </div>
              {(s.locationName || s.location) && (
                <div className="text-xs text-silver/70">
                  {[s.locationName, s.location].filter(Boolean).join(' · ')}
                </div>
              )}
            </div>
            <div className="shrink-0">
              {s.myClaimStatus === 'PENDING' ? (
                <div className="flex flex-col items-end gap-1">
                  <Badge variant="accent">Requested</Badge>
                  <button
                    type="button"
                    onClick={() => withdraw(s)}
                    disabled={busyId === s.id}
                    className="text-xs text-silver/70 hover:text-white underline underline-offset-2"
                  >
                    Withdraw
                  </button>
                </div>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setConfirmShift(s)}
                  disabled={busyId === s.id}
                >
                  Pick up
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
        title="Request this shift?"
        description={
          confirmShift
            ? `${confirmShift.position} · ${
                confirmShift.clientName ?? '—'
              } · ${fmtRelativeDayTz(confirmShift.startsAt, confirmShift.timezone)}, ${fmtShiftRangeTz(
                confirmShift.startsAt,
                confirmShift.endsAt,
                confirmShift.timezone,
              )}. Your manager confirms pickups before they're final.`
            : undefined
        }
        confirmLabel="Request pickup"
        busy={confirmShift !== null && busyId === confirmShift.id}
        onConfirm={() => {
          if (confirmShift) return request(confirmShift);
        }}
      />
    </section>
  );
}

function CalendarSubscribeCard() {
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
          setError(err instanceof ApiError ? err.message : 'Could not load calendar URL.');
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
            Calendar subscription is unavailable right now. {error}
          </div>
        </div>
      </div>
    );
  }
  if (!feed) {
    return (
      <div className="mb-6 p-4 bg-navy border border-navy-secondary rounded-lg animate-pulse h-24" />
    );
  }

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(feed.url);
      setCopied(true);
      toast.success('Calendar URL copied. Paste it into Google or Outlook.');
      setTimeout(() => setCopied(false), 2500);
    } catch {
      toast.error('Could not copy — long-press the URL to copy manually.');
    }
  };

  const onReset = async () => {
    setResetting(true);
    try {
      const res = await rotateMyCalendarUrl();
      setFeed(res);
      setConfirmReset(false);
      toast.success(
        'New link created. Re-subscribe in your calendar app — the old link no longer works.',
      );
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : 'Could not reset the link.',
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
          <div className="text-white font-medium">Subscribe in your calendar</div>
          <div className="text-xs text-silver/70 mt-0.5">
            Add this URL once and your published shifts show up in Google,
            Apple, or Outlook calendars — refreshed hourly. Don't share it;
            anyone with the link can see your schedule.
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <code className="flex-1 min-w-0 truncate text-[11px] text-silver bg-navy-secondary/40 border border-navy-secondary rounded px-2 py-1.5 tabular-nums">
              {feed.url}
            </code>
            <Button onClick={onCopy} variant="secondary" className="shrink-0">
              {copied ? (
                <>
                  <Check className="h-3.5 w-3.5" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" />
                  Copy URL
                </>
              )}
            </Button>
            <a
              href={feed.webcalUrl}
              className="inline-flex items-center gap-1 text-xs text-gold hover:text-gold-bright underline underline-offset-2"
            >
              <ExternalLink className="h-3 w-3" />
              Open in Apple Calendar
            </a>
            <button
              type="button"
              onClick={() => setConfirmReset(true)}
              className="inline-flex items-center gap-1 text-xs text-silver/70 hover:text-white underline underline-offset-2 transition-colors"
            >
              <RotateCcw className="h-3 w-3" />
              Reset link
            </button>
          </div>
        </div>
      </div>
      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title="Reset your calendar link?"
        description="If this link got shared, resetting it locks the old one out immediately. Any calendar subscribed with the current link stops updating — you'll need to re-subscribe with the new one."
        confirmLabel="Reset link"
        destructive
        busy={resetting}
        onConfirm={onReset}
      />
    </div>
  );
}
