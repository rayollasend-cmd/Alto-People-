import { useEffect, useState } from 'react';
import type { CalendarFeedUrlResponse, Shift } from '@alto-people/shared';
import { getMyCalendarUrl, listMyShifts } from '@/lib/schedulingApi';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { PageHeader } from '@/components/ui/PageHeader';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { Button } from '@/components/ui/Button';
import { toast } from '@/components/ui/Toaster';
import { CalendarDays, Check, Copy, ExternalLink } from 'lucide-react';
import { AvailabilityEditor } from './AvailabilityEditor';
import { SwapMarketplace } from './SwapMarketplace';

function formatRange(s: Shift): string {
  const a = new Date(s.startsAt);
  const b = new Date(s.endsAt);
  return `${a.toLocaleString()} – ${b.toLocaleTimeString()}`;
}

function statusBadge(status: Shift['status']): { label: string; cls: string } {
  switch (status) {
    case 'ASSIGNED':
      return { label: 'Confirmed', cls: 'bg-gold/20 text-gold border-gold/40' };
    case 'OPEN':
      return { label: 'Open', cls: 'bg-silver/10 text-silver border-silver/30' };
    case 'COMPLETED':
      return { label: 'Worked', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' };
    case 'DRAFT':
      return { label: 'Draft', cls: 'bg-silver/10 text-silver border-silver/30' };
    case 'CANCELLED':
      return { label: 'Cancelled', cls: 'bg-alert/15 text-alert border-alert/30' };
  }
}

export function AssociateScheduleView() {
  const [shifts, setShifts] = useState<Shift[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await listMyShifts();
        setShifts(res.shifts);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Failed to load.');
      }
    })();
  }, []);

  return (
    <div className="max-w-3xl mx-auto">
      <PageHeader
        title="My schedule"
        subtitle="Upcoming shifts assigned to you."
      />

      {error && (
        <p role="alert" className="text-sm text-alert mb-4">
          {error}
        </p>
      )}
      {!shifts && <SkeletonRows count={4} rowHeight="h-20" />}
      {shifts && shifts.length === 0 && (
        <EmptyState
          icon={CalendarDays}
          title="No upcoming shifts"
          description="When a manager assigns you to a shift, it'll show up here. You can post your availability below to make scheduling easier."
        />
      )}

      {shifts && shifts.length > 0 && (
        <ul className="space-y-3">
          {shifts.map((s) => {
            const badge = statusBadge(s.status);
            return (
              <li
                key={s.id}
                className="flex items-center justify-between gap-4 p-4 bg-navy border border-navy-secondary rounded-lg"
              >
                <div className="min-w-0">
                  <div className="text-white font-medium">
                    {s.position}{' '}
                    <span className="text-silver text-sm font-normal">
                      · {s.clientName ?? '—'}
                    </span>
                  </div>
                  <div className="text-sm text-silver tabular-nums">
                    {formatRange(s)}
                  </div>
                  {s.location && (
                    <div className="text-xs text-silver/70">{s.location}</div>
                  )}
                </div>
                <span
                  className={cn(
                    'shrink-0 text-xs uppercase tracking-widest px-2 py-1 rounded border',
                    badge.cls
                  )}
                >
                  {badge.label}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-8">
        <CalendarSubscribeCard />
        <SwapMarketplace />
        <AvailabilityEditor />
      </div>
    </div>
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

  if (error) return null;
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
