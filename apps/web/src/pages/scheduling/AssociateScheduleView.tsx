import { useEffect, useMemo, useState } from 'react';
import type { CalendarFeedUrlResponse, Shift } from '@alto-people/shared';
import { getMyCalendarUrl, listMyShifts } from '@/lib/schedulingApi';
import { ApiError } from '@/lib/api';
import { PageHeader } from '@/components/ui/PageHeader';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { toast } from '@/components/ui/Toaster';
import {
  browserTimeZone,
  fmtDateTz,
  fmtTimeTz,
  fmtWeekdayTz,
  tzAbbrev,
  zonedDayKey,
} from '@/lib/format';
import { CalendarDays, Check, Copy, ExternalLink, RefreshCw } from 'lucide-react';
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

/** "7:00 AM – 3:00 PM" — or "11:00 PM – 7:00 AM (Jun 17)" when it crosses
 *  midnight — rendered in the SHIFT'S work-site timezone, not the browser's.
 *  Appends the zone abbreviation when the viewer isn't in the store's zone. */
function timeRange(s: Shift): string {
  const tz = s.timezone;
  const start = fmtTimeTz(s.startsAt, tz);
  const end = fmtTimeTz(s.endsAt, tz);
  const crossesMidnight = zonedDayKey(s.startsAt, tz) !== zonedDayKey(s.endsAt, tz);
  const base = crossesMidnight
    ? `${start} – ${end} (${fmtDateTz(s.endsAt, tz)})`
    : `${start} – ${end}`;
  const showZone = tz && tz !== browserTimeZone();
  return showZone ? `${base} ${tzAbbrev(tz, s.startsAt)}` : base;
}

/** "Today", "Tomorrow", or "Mon, Jun 16" — in the store's timezone. */
function dayHeading(s: Shift, now: number): string {
  const tz = s.timezone;
  const key = zonedDayKey(s.startsAt, tz);
  const todayKey = zonedDayKey(new Date(now), tz);
  const tomorrowKey = zonedDayKey(new Date(now + 86_400_000), tz);
  if (key === todayKey) return 'Today';
  if (key === tomorrowKey) return 'Tomorrow';
  return `${fmtWeekdayTz(s.startsAt, tz)}, ${fmtDateTz(s.startsAt, tz)}`;
}

export function AssociateScheduleView() {
  const [shifts, setShifts] = useState<Shift[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [showPast, setShowPast] = useState(false);

  const load = async () => {
    try {
      setError(null);
      const res = await listMyShifts();
      setShifts(res.shifts);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load.');
    }
  };

  useEffect(() => {
    load();
  }, []);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  // Split at "now" (stable per data load) into upcoming (ascending) and past
  // (descending), then group the upcoming list by store-local day.
  const { upcomingDays, past, nextId, upcomingCount, upcomingHours } = useMemo(() => {
    const now = Date.now();
    const all = shifts ?? [];
    const up = all
      .filter((s) => new Date(s.endsAt).getTime() >= now)
      .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
    const old = all
      .filter((s) => new Date(s.endsAt).getTime() < now)
      .sort((a, b) => new Date(b.startsAt).getTime() - new Date(a.startsAt).getTime());

    const groups: Array<{ key: string; heading: string; items: Shift[] }> = [];
    for (const s of up) {
      const key = zonedDayKey(s.startsAt, s.timezone);
      const last = groups[groups.length - 1];
      if (last && last.key === key) last.items.push(s);
      else groups.push({ key, heading: dayHeading(s, now), items: [s] });
    }
    const minutes = up.reduce((sum, s) => sum + shiftMinutes(s), 0);
    return {
      upcomingDays: groups,
      past: old,
      nextId: up[0]?.id ?? null,
      upcomingCount: up.length,
      upcomingHours: minutes / 60,
    };
  }, [shifts]);

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
        <p role="alert" className="text-sm text-alert mb-4">
          {error}
        </p>
      )}
      {!shifts && <SkeletonRows count={4} rowHeight="h-20" />}

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
            <section key={group.key}>
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
        <div className="text-sm text-silver tabular-nums">{timeRange(shift)}</div>
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
          </div>
        </div>
      </div>
    </div>
  );
}
