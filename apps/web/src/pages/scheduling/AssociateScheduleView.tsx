import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type {
  CalendarFeedUrlResponse,
  OpenShiftsResponse,
  Shift,
  ShiftTeammate,
  SwapCandidate,
  TradeOption,
} from '@alto-people/shared';
import {
  acknowledgeMyShift,
  claimOpenShift,
  createSwap,
  getMyCalendarUrl,
  getMyShiftDetail,
  listMyOpenShifts,
  listMyShiftHistory,
  listMyShifts,
  listSwapCandidates,
  listTradeOptions,
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
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Input';
import { toast } from '@/components/ui/Toaster';
import {
  fmtDateTz,
  fmtRelativeDayTz,
  fmtShiftRangeTz,
  fmtWeekdayTz,
  zonedDayKey,
} from '@/lib/format';
import {
  ArrowLeftRight,
  CalendarDays,
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  HandHelping,
  MapPin,
  RefreshCw,
  RotateCcw,
  Users,
} from 'lucide-react';
import { AvailabilityEditor } from './AvailabilityEditor';
import { SwapMarketplace } from './SwapMarketplace';

function statusBadge(
  status: Shift['status'],
): { label: string; variant: 'accent' | 'default' | 'success' | 'destructive' } {
  switch (status) {
    case 'ASSIGNED':
      return { label: 'Confirmed', variant: 'accent' };
    case 'OPEN':
      return { label: 'Open', variant: 'default' };
    case 'COMPLETED':
      return { label: 'Worked', variant: 'success' };
    case 'DRAFT':
      return { label: 'Draft', variant: 'default' };
    case 'CANCELLED':
      return { label: 'Cancelled', variant: 'destructive' };
  }
}

function shiftMinutes(s: Shift): number {
  const ms = new Date(s.endsAt).getTime() - new Date(s.startsAt).getTime();
  return ms > 0 ? Math.round(ms / 60000) : 0;
}

/** "8h", "7h 30m" — shift length for the detail panel. */
function fmtDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}


export function AssociateScheduleView() {
  const [shifts, setShifts] = useState<Shift[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [showPast, setShowPast] = useState(false);
  const [now, setNow] = useState(() => Date.now());
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

      {loaded && upcomingCount > 0 && (
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

      {loaded && (past.length > 0 || (history?.length ?? 0) > 0) && (
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

function ShiftCard({
  shift,
  isNext,
  muted = false,
  onSwapCreated,
}: {
  shift: Shift;
  isNext: boolean;
  muted?: boolean;
  onSwapCreated?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [teammates, setTeammates] = useState<ShiftTeammate[] | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const loadDetail = async () => {
    try {
      setDetailError(null);
      const res = await getMyShiftDetail(shift.id);
      setTeammates(res.teammates);
    } catch (err) {
      setDetailError(
        err instanceof ApiError ? err.message : 'Could not load shift details.',
      );
    }
  };

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && teammates === null) loadDetail();
  };

  const badge = statusBadge(shift.status);
  const detailId = `shift-detail-${shift.id}`;
  return (
    <li
      className={[
        'rounded-lg border',
        isNext
          ? 'bg-navy border-gold/50 ring-1 ring-gold/30'
          : 'bg-navy border-navy-secondary',
        muted ? 'opacity-80' : '',
      ].join(' ')}
    >
      <button
        type="button"
        onClick={toggle}
        aria-expanded={expanded}
        aria-controls={detailId}
        className="w-full flex items-center justify-between gap-4 p-4 text-left rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
      >
        <div className="min-w-0">
          <div className="text-white font-medium">
            {shift.position}{' '}
            <span className="text-silver text-sm font-normal">
              · {shift.clientName ?? '—'}
            </span>
          </div>
          <div className="text-sm text-silver tabular-nums">
            {/* Past shifts live in a flat "Recent" list with no day headers,
                so the collapsed card carries its own date. */}
            {muted && (
              <>
                {fmtWeekdayTz(shift.startsAt, shift.timezone)},{' '}
                {fmtDateTz(shift.startsAt, shift.timezone)} ·{' '}
              </>
            )}
            {fmtShiftRangeTz(shift.startsAt, shift.endsAt, shift.timezone)}
          </div>
          {shift.location && (
            <div className="text-xs text-silver/70">{shift.location}</div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="flex flex-col items-end gap-1">
            {isNext && (
              <Badge variant="accent" className="bg-gold/15 text-gold border-gold/40">
                Next
              </Badge>
            )}
            <Badge variant={badge.variant}>{badge.label}</Badge>
          </div>
          <ChevronDown
            aria-hidden="true"
            className={[
              'h-4 w-4 text-silver/70 transition-transform',
              expanded ? 'rotate-180' : '',
            ].join(' ')}
          />
        </div>
      </button>

      {expanded && (
        <div id={detailId} className="border-t border-navy-secondary px-4 py-3">
          <ShiftDetail shift={shift} muted={muted} onSwapCreated={onSwapCreated} />
          <div className="mt-3">
            <div className="text-[11px] uppercase tracking-wider text-silver/80 mb-1.5 flex items-center gap-1.5">
              <Users className="h-3.5 w-3.5" aria-hidden="true" />
              Working with you
              {teammates && teammates.length > 0 && ` (${teammates.length})`}
            </div>
            {teammates === null && !detailError && (
              <SkeletonRows count={2} rowHeight="h-5" />
            )}
            {detailError && (
              <p role="alert" className="text-xs text-alert">
                {detailError}{' '}
                <button
                  type="button"
                  onClick={loadDetail}
                  className="underline underline-offset-2 hover:text-white"
                >
                  Retry
                </button>
              </p>
            )}
            {teammates && teammates.length === 0 && (
              <p className="text-xs text-silver/70">
                No one else is scheduled alongside this shift yet.
              </p>
            )}
            {teammates && teammates.length > 0 && (
              <ul className="space-y-1.5">
                {teammates.map((t) => (
                  <li
                    key={t.associateId}
                    className="flex items-baseline justify-between gap-3 text-sm"
                  >
                    <span className="text-white truncate">{t.name}</span>
                    <span className="text-xs text-silver tabular-nums text-right shrink-0">
                      {t.position} ·{' '}
                      {fmtShiftRangeTz(t.startsAt, t.endsAt, shift.timezone)}
                      {t.location ? ` · ${t.location}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

/** The facts row of the expanded card: date, hours, site, manager note. */
function ShiftDetail({
  shift,
  muted,
  onSwapCreated,
}: {
  shift: Shift;
  muted: boolean;
  onSwapCreated?: () => void;
}) {
  const [ackAt, setAckAt] = useState(shift.acknowledgedAt);
  const [acking, setAcking] = useState(false);
  const site = [shift.locationName, shift.location].filter(Boolean).join(' · ');
  const upcoming =
    !muted &&
    shift.status === 'ASSIGNED' &&
    new Date(shift.startsAt).getTime() > Date.now();

  const acknowledge = async () => {
    setAcking(true);
    try {
      const updated = await acknowledgeMyShift(shift.id);
      setAckAt(updated.acknowledgedAt ?? new Date().toISOString());
      toast.success('Confirmed — your manager can see you acknowledged it.');
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : 'Could not confirm the shift.',
      );
    } finally {
      setAcking(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="text-sm text-silver">
        <span className="text-white">
          {fmtWeekdayTz(shift.startsAt, shift.timezone)},{' '}
          {fmtDateTz(shift.startsAt, shift.timezone)}
        </span>{' '}
        · {fmtShiftRangeTz(shift.startsAt, shift.endsAt, shift.timezone)} ·{' '}
        <span className="tabular-nums">{fmtDuration(shift.scheduledMinutes)}</span>
      </div>
      {site && (
        <div className="text-xs text-silver/70 inline-flex items-center gap-1">
          <MapPin className="h-3 w-3" aria-hidden="true" />
          {site}
        </div>
      )}
      {shift.notes && (
        <p className="text-xs text-silver bg-navy-secondary/30 border border-navy-secondary rounded px-2.5 py-1.5">
          <span className="text-silver/70">Note from your manager: </span>
          {shift.notes}
        </p>
      )}
      {upcoming && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {ackAt ? (
            <span className="inline-flex items-center gap-1 text-xs text-success">
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
              You confirmed this shift
            </span>
          ) : (
            <Button size="sm" onClick={acknowledge} loading={acking} disabled={acking}>
              <Check className="h-3.5 w-3.5" />
              I'll be there
            </Button>
          )}
          <SwapOfferForm shiftId={shift.id} onCreated={onSwapCreated} />
        </div>
      )}
    </div>
  );
}

/**
 * "Offer this shift to a teammate" — the associate side of the swap flow.
 * Candidates are the schedulable pool; people already booked over this
 * window show as "busy" and can't be picked (the manager still approves
 * every swap, this just avoids dead-on-arrival requests).
 */
function SwapOfferForm({
  shiftId,
  onCreated,
}: {
  shiftId: string;
  onCreated?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [candidates, setCandidates] = useState<SwapCandidate[] | null>(null);
  const [candError, setCandError] = useState<string | null>(null);
  const [counterpartyId, setCounterpartyId] = useState('');
  const [tradeOptions, setTradeOptions] = useState<TradeOption[] | null>(null);
  const [counterpartShiftId, setCounterpartShiftId] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Trade half: once a counterparty is picked, offer their upcoming shifts
  // as an optional "take one in exchange" list.
  useEffect(() => {
    setCounterpartShiftId('');
    if (!counterpartyId) {
      setTradeOptions(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await listTradeOptions(counterpartyId);
        if (!cancelled) setTradeOptions(res.options);
      } catch {
        // Trade list failing shouldn't block a plain give-away.
        if (!cancelled) setTradeOptions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [counterpartyId]);

  const openForm = async () => {
    setOpen(true);
    if (candidates === null) {
      try {
        setCandError(null);
        const res = await listSwapCandidates(shiftId);
        setCandidates(res.candidates);
      } catch (err) {
        setCandError(
          err instanceof ApiError ? err.message : 'Could not load teammates.',
        );
      }
    }
  };

  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={openForm}>
        <ArrowLeftRight className="h-3.5 w-3.5" />
        Offer this shift to a teammate
      </Button>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!counterpartyId || submitting) return;
    setSubmitting(true);
    try {
      await createSwap({
        shiftId,
        counterpartyAssociateId: counterpartyId,
        note: note.trim() || undefined,
        counterpartShiftId: counterpartShiftId || undefined,
      });
      toast.success(
        counterpartShiftId
          ? 'Trade proposed. They accept first, then your manager approves both halves.'
          : 'Swap request sent. Track it under Shift swaps below — your manager has the final say.',
      );
      setOpen(false);
      setCounterpartyId('');
      setCounterpartShiftId('');
      setNote('');
      onCreated?.();
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : 'Could not send the swap request.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-2 max-w-md">
      {candError && (
        <p role="alert" className="text-xs text-alert">
          {candError}
        </p>
      )}
      <label className="block">
        <span className="text-[11px] uppercase tracking-wider text-silver">
          Offer to
        </span>
        <Select
          size="sm"
          required
          value={counterpartyId}
          onChange={(e) => setCounterpartyId(e.target.value)}
          disabled={candidates === null}
          className="mt-1"
        >
          <option value="" disabled>
            {candidates === null ? 'Loading teammates…' : 'Pick a teammate'}
          </option>
          {(candidates ?? []).map((c) => (
            <option key={c.associateId} value={c.associateId} disabled={c.busy}>
              {c.name}
              {c.busy ? ' — busy during this shift' : ''}
            </option>
          ))}
        </Select>
      </label>
      {counterpartyId && (tradeOptions?.length ?? 0) > 0 && (
        <label className="block">
          <span className="text-[11px] uppercase tracking-wider text-silver">
            Take one of their shifts in exchange (optional)
          </span>
          <Select
            size="sm"
            value={counterpartShiftId}
            onChange={(e) => setCounterpartShiftId(e.target.value)}
            className="mt-1"
          >
            <option value="">Nothing — just hand mine off</option>
            {(tradeOptions ?? []).map((o) => (
              <option key={o.shiftId} value={o.shiftId}>
                {o.position} · {fmtDateTz(o.startsAt, o.timezone)} ·{' '}
                {fmtShiftRangeTz(o.startsAt, o.endsAt, o.timezone)}
              </option>
            ))}
          </Select>
        </label>
      )}
      <label className="block">
        <span className="text-[11px] uppercase tracking-wider text-silver">
          Note (optional)
        </span>
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          maxLength={500}
          placeholder="e.g. Doctor's appointment that morning"
          className="mt-1"
        />
      </label>
      <div className="flex gap-2">
        <Button type="submit" size="sm" loading={submitting} disabled={!counterpartyId}>
          Send request
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setOpen(false)}
          disabled={submitting}
        >
          Cancel
        </Button>
      </div>
    </form>
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
