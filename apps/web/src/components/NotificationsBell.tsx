import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeftRight,
  Bell,
  BellRing,
  Building2,
  CalendarDays,
  CheckCheck,
  ClipboardCheck,
  FileText,
  Inbox,
  Lock,
  Megaphone,
  Plane,
  ShieldAlert,
  TrendingUp,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  NOTIFICATION_CATEGORIES,
  bucketForCategory,
  isUrgentCategory,
  type Notification,
  type NotificationCategory,
} from '@alto-people/shared';
import {
  listMyInbox,
  markAllRead,
  markAllSeen,
  markRead,
} from '@/lib/communicationsApi';
import { onLiveEvent } from '@/lib/liveEvents';
import { ApiError } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import { Skeleton } from '@/components/ui/Skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/Tooltip';
import { cn } from '@/lib/cn';
import { fmtDate, fmtDateTime } from '@/lib/format';

const POLL_MS = 30_000;

/**
 * Topbar notifications bell.
 *
 * Seen vs read (the Slack/GitHub model): OPENING the panel stamps seenAt
 * on everything — the badge counts unseen, so it clears the moment you
 * look. CLICKING a row stamps readAt — the gold highlight survives until
 * you act on the item. Refresh: 30s poll (paused while the tab is
 * hidden), refocus refetch, and instant SSE nudges.
 */

// Bucket → icon. Labels come from NOTIFICATION_CATEGORIES so the bell,
// the Settings mute list, and the email pipeline all speak one language.
const BUCKET_ICON: Record<NotificationCategory, LucideIcon> = {
  onboarding: ClipboardCheck,
  documents: FileText,
  time_off: Plane,
  scheduling: CalendarDays,
  shift_swaps: ArrowLeftRight,
  broadcast: Megaphone,
  time_pay: Wallet,
  growth: TrendingUp,
  workplace: Building2,
  discipline: ShieldAlert,
  probation: ShieldAlert,
  security: Lock,
};

const BUCKET_LABEL: Record<string, string> = Object.fromEntries(
  NOTIFICATION_CATEGORIES.map((c) => [c.key, c.label]),
);

function categoryMeta(raw: string | null): {
  Icon: LucideIcon;
  label: string | null;
  urgent: boolean;
} {
  const bucket = bucketForCategory(raw);
  return {
    Icon: bucket ? BUCKET_ICON[bucket] : Bell,
    label: bucket ? (BUCKET_LABEL[bucket] ?? null) : null,
    urgent: isUrgentCategory(raw),
  };
}

const SHOW_LIMIT = 50;

export function NotificationsBell() {
  const [items, setItems] = useState<Notification[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loadError, setLoadError] = useState(false);
  const [open, setOpen] = useState(false);
  // aria-live announcement text — screen readers hear arrivals without
  // the panel being open.
  const [announcement, setAnnouncement] = useState('');
  const prevUnseenRef = useRef(0);
  // One-shot swing on arrival; cleared by onAnimationEnd so a later
  // arrival can replay it.
  const [swing, setSwing] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await listMyInbox();
      setItems(res.notifications);
      setTotal(res.total ?? res.notifications.length);
      setLoadError(false);
    } catch (err) {
      // 403 just means this user can't view the inbox (CLIENT_PORTAL etc.)
      // — render the bell as empty rather than spamming an error.
      if (err instanceof ApiError && err.status === 403) {
        setItems([]);
        return;
      }
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    refresh();
    let t = window.setInterval(refresh, POLL_MS);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        // Tab came back into focus — refetch immediately and reset the
        // polling interval so we don't fire two close requests.
        window.clearInterval(t);
        refresh();
        t = window.setInterval(refresh, POLL_MS);
      } else {
        // Hidden tabs throttle setInterval anyway; explicitly pause so
        // we don't accumulate a backlog of fires that all dump at once
        // when the user returns.
        window.clearInterval(t);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', refresh);
    // Live SSE nudge — a notification just landed for this user; refetch
    // immediately instead of waiting out the poll interval.
    const offLive = onLiveEvent('notification', refresh);
    return () => {
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', refresh);
      offLive();
    };
  }, [refresh]);

  // Badge = UNSEEN (not unread): it clears when the panel opens, while
  // the per-row unread highlight persists until each item is clicked.
  const unseenCount = (items ?? []).filter((n) => !n.seenAt).length;
  const unreadCount = (items ?? []).filter((n) => !n.readAt).length;

  // Screen-reader announcement when new items arrive in the background.
  useEffect(() => {
    if (unseenCount > prevUnseenRef.current) {
      const delta = unseenCount - prevUnseenRef.current;
      setAnnouncement(
        `${delta} new notification${delta === 1 ? '' : 's'} — ${unseenCount} unseen`,
      );
      // Visual twin of the SR announcement: one bell swing per arrival.
      // Never loops; flattened by the global reduced-motion block.
      setSwing(true);
    }
    prevUnseenRef.current = unseenCount;
  }, [unseenCount]);

  // Installed-app icon badge (Badging API — Android/desktop PWA; iOS 16.4+
  // installed). Mirrors the bell count; silent no-op where unsupported.
  useEffect(() => {
    try {
      if (unseenCount > 0) {
        navigator.setAppBadge?.(unseenCount);
      } else {
        navigator.clearAppBadge?.();
      }
    } catch {
      // Badging unavailable — irrelevant.
    }
  }, [unseenCount]);

  const navigate = useNavigate();

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next && unseenCount > 0) {
      // Optimistically clear the badge the instant the panel opens; the
      // server stamp is fire-and-forget (a failure self-heals on the next
      // poll, which re-reports the true unseen set).
      const now = new Date().toISOString();
      setItems((prev) => prev?.map((x) => (x.seenAt ? x : { ...x, seenAt: now })) ?? null);
      markAllSeen().catch(() => void refresh());
    }
  };

  const onItemClick = (n: Notification) => {
    // Mark read first (optimistic) so the highlight drops even if
    // navigation tears down this component before the network call lands.
    if (!n.readAt) {
      const now = new Date().toISOString();
      setItems((prev) =>
        prev?.map((x) => (x.id === n.id ? { ...x, readAt: now, seenAt: x.seenAt ?? now } : x)) ?? null
      );
      markRead(n.id).catch(() => {
        // Roll the optimistic read-state back so the highlight stays honest.
        setItems((prev) =>
          prev?.map((x) => (x.id === n.id ? { ...x, readAt: null } : x)) ?? null
        );
        toast.error('Could not mark as read');
      });
    }
    // Deeplink if the notification has one (e.g., payroll failure → run drawer).
    if (n.linkUrl) {
      setOpen(false);
      navigate(n.linkUrl);
    }
  };

  const onMarkAllRead = async () => {
    if (!items) return;
    const before = items;
    const now = new Date().toISOString();
    // Optimistic; one bulk request instead of the old per-row storm.
    setItems((prev) =>
      prev?.map((x) => (x.readAt ? x : { ...x, readAt: now, seenAt: x.seenAt ?? now })) ?? null
    );
    try {
      await markAllRead();
    } catch {
      setItems(before);
      toast.error('Could not mark as read');
    }
  };

  const shown = (items ?? []).slice(0, SHOW_LIMIT);

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      {/* Polite announcement channel for background arrivals. */}
      <span aria-live="polite" role="status" className="sr-only">
        {announcement}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="relative"
              aria-label={
                unseenCount > 0
                  ? `Notifications (${unseenCount} new)`
                  : 'Notifications'
              }
            >
              <span
                className={cn('inline-flex origin-top', swing && 'animate-bell-swing')}
                onAnimationEnd={() => setSwing(false)}
              >
                {unseenCount > 0 ? (
                  <BellRing className="h-4 w-4" />
                ) : (
                  <Bell className="h-4 w-4" />
                )}
              </span>
              {unseenCount > 0 && (
                // Keyed by count: a change remounts the span and replays
                // the pop — the visual cue that the number moved.
                <span
                  key={unseenCount}
                  className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-gold text-navy text-2xs font-semibold flex items-center justify-center tabular-nums animate-badge-pop"
                  aria-hidden="true"
                >
                  {unseenCount > 99 ? '99+' : unseenCount}
                </span>
              )}
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {unseenCount > 0
            ? `${unseenCount} new notification${unseenCount === 1 ? '' : 's'}`
            : 'Notifications'}
        </TooltipContent>
      </Tooltip>

      <DropdownMenuContent
        align="end"
        // w-[22rem] (352px) clips on small phones (iPhone SE = 375px minus
        // gutter/safe-area). Cap to viewport minus 1rem of breathing room
        // on phones, then resume 22rem at sm+.
        className="w-[calc(100vw-1rem)] sm:w-[22rem] p-0"
      >
        <DropdownMenuLabel className="flex items-center justify-between gap-2 px-3 py-2.5">
          <span className="text-xs uppercase tracking-widest text-silver">
            Inbox
          </span>
          {unreadCount > 0 && (
            <button
              type="button"
              onClick={() => void onMarkAllRead()}
              className="inline-flex items-center gap-1 rounded text-2xs text-gold hover:text-gold-bright focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
            >
              <CheckCheck className="h-3 w-3" />
              Mark all read
            </button>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator className="m-0" />

        {/* 28rem (448px) on tall screens, but clamp to the dynamic
            viewport on short phones — without this the dropdown can
            run off the bottom of the screen below the Topbar +
            DropdownMenuLabel + safe-area inset, leaving items
            inaccessible. 100dvh, not 100vh, so the iOS address-bar
            collapse doesn't briefly let the list grow off-screen. */}
        <div className="overflow-y-auto" style={{ maxHeight: 'min(28rem, calc(100dvh - 9rem))' }}>
          {!items && !loadError && (
            <div className="p-2 space-y-2">
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
            </div>
          )}
          {loadError && (
            <div className="p-6 text-center text-sm text-alert">
              Failed to load. Retrying…
            </div>
          )}
          {items && items.length === 0 && (
            <div className="p-8 text-center">
              <div className="mx-auto h-10 w-10 rounded-full bg-navy-secondary/60 grid place-items-center mb-3">
                <Inbox className="h-5 w-5 text-silver" aria-hidden="true" />
              </div>
              <p className="text-sm text-white">All caught up</p>
              <p className="text-xs text-silver mt-1">
                You'll see new in-app messages here.
              </p>
            </div>
          )}
          {items && items.length > 0 && (
            <div className="divide-y divide-navy-secondary">
              {/* DropdownMenuItem (not bare <button>) so Radix's roving
                  focus gives arrow-key traversal + typeahead for free. */}
              {shown.map((n) => {
                const meta = categoryMeta(n.category);
                return (
                  <DropdownMenuItem
                    key={n.id}
                    onSelect={(e) => {
                      // No deeplink → keep the panel open; the click only
                      // marks the row read.
                      if (!n.linkUrl) e.preventDefault();
                      onItemClick(n);
                    }}
                    className={cn(
                      'w-full items-start rounded-none px-3 py-2.5 cursor-pointer',
                      'focus:bg-navy-secondary data-[highlighted]:bg-navy-secondary/60',
                      !n.readAt && 'bg-gold/5'
                    )}
                  >
                    <div className="flex items-start gap-2.5 w-full min-w-0">
                      <span
                        className={cn(
                          'mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full',
                          meta.urgent
                            ? 'bg-alert/15 text-alert'
                            : 'bg-navy-secondary/70 text-silver'
                        )}
                        aria-hidden="true"
                      >
                        <meta.Icon className="h-3.5 w-3.5" />
                      </span>
                      <div className="min-w-0 flex-1">
                        {n.subject && (
                          <div
                            className={cn(
                              'text-sm truncate',
                              meta.urgent ? 'text-alert font-medium' : 'text-white',
                              !n.readAt && !meta.urgent && 'font-medium'
                            )}
                          >
                            {n.subject}
                          </div>
                        )}
                        <div
                          className={cn(
                            'text-xs leading-snug line-clamp-2',
                            n.readAt ? 'text-silver/70' : 'text-silver'
                          )}
                        >
                          {n.body}
                        </div>
                        <div className="text-2xs text-silver/80 mt-0.5 tabular-nums flex items-center gap-1.5">
                          <span title={fmtDateTime(n.createdAt)}>{fmt(n.createdAt)}</span>
                          {meta.label && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span>{meta.label}</span>
                            </>
                          )}
                        </div>
                      </div>
                      {!n.readAt && (
                        <span
                          className="mt-1.5 h-2 w-2 rounded-full shrink-0 bg-gold"
                          aria-hidden="true"
                        />
                      )}
                    </div>
                  </DropdownMenuItem>
                );
              })}
            </div>
          )}
        </div>
        {items && total > shown.length && (
          <>
            <DropdownMenuSeparator className="m-0" />
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                navigate('/communications');
              }}
              className="w-full px-3 py-2 coarse:min-h-11 text-2xs text-center text-silver/80 hover:text-gold-bright hover:bg-navy-secondary/40 transition-colors focus:outline-none focus-visible:bg-navy-secondary"
            >
              Showing {shown.length} of {total} —{' '}
              <span className="text-gold">View all in Inbox</span>
            </button>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function fmt(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const diff = now - d.getTime();
  const min = 60 * 1000;
  const hr = 60 * min;
  const day = 24 * hr;
  if (diff < min) return 'just now';
  if (diff < hr) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hr)}h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return fmtDate(d);
}
