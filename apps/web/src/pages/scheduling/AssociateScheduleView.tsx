import { useEffect, useMemo, useState } from 'react';
import type { CalendarFeedUrlResponse, Shift } from '@alto-people/shared';
import { getMyCalendarUrl, listMyShifts, rotateMyCalendarUrl } from '@/lib/schedulingApi';
import { ApiError } from '@/lib/api';
import { PageHeader } from '@/components/ui/PageHeader';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { toast } from '@/components/ui/Toaster';
import { fmtRelativeDayTz, fmtShiftRangeTz, zonedDayKey } from '@/lib/format';
import {
  CalendarDays,
  Check,
  Copy,
  ExternalLink,
  RefreshCw,
  RotateCcw,
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


export function AssociateScheduleView() {
  const [shifts, setShifts] = useState<Shift[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [showPast, setShowPast] = useState(false);
  const [now, setNow] = useState(() => Date.now());

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
    setRefreshing(false);
  };

  // Split at "now" (ticks once a minute) into upcoming (ascending) and past
  // (descending), then group the upcoming list by store-local day.
  const { upcomingDays, past, nextId, upcomingCount, upcomingHours } = useMemo(() => {
    const all = shifts ?? [];
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
                  <ShiftCard key={s.id} shift={s} isNext={s.id === nextId} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {loaded && past.length > 0 && (
        <div className="mt-6">
          <button
            type="button"
            onClick={() => setShowPast((v) => !v)}
            className="text-xs uppercase tracking-wider text-silver/80 hover:text-white transition-colors"
          >
            {showPast ? 'Hide' : 'Show'} recent shifts ({past.length})
          </button>
          {showPast && (
            <ul className="space-y-2 mt-3">
              {past.map((s) => (
                <ShiftCard key={s.id} shift={s} isNext={false} muted />
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="mt-8">
        <CalendarSubscribeCard />
        <SwapMarketplace />
        <AvailabilityEditor />
      </div>
    </div>
  );
}

function ShiftCard({
  shift,
  isNext,
  muted = false,
}: {
  shift: Shift;
  isNext: boolean;
  muted?: boolean;
}) {
  const badge = statusBadge(shift.status);
  return (
    <li
      className={[
        'flex items-center justify-between gap-4 p-4 rounded-lg border',
        isNext
          ? 'bg-navy border-gold/50 ring-1 ring-gold/30'
          : 'bg-navy border-navy-secondary',
        muted ? 'opacity-80' : '',
      ].join(' ')}
    >
      <div className="min-w-0">
        <div className="text-white font-medium">
          {shift.position}{' '}
          <span className="text-silver text-sm font-normal">
            · {shift.clientName ?? '—'}
          </span>
        </div>
        <div className="text-sm text-silver tabular-nums">
          {fmtShiftRangeTz(shift.startsAt, shift.endsAt, shift.timezone)}
        </div>
        {shift.location && (
          <div className="text-xs text-silver/70">{shift.location}</div>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        {isNext && (
          <Badge variant="accent" className="bg-gold/15 text-gold border-gold/40">
            Next
          </Badge>
        )}
        <Badge variant={badge.variant}>{badge.label}</Badge>
      </div>
    </li>
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
