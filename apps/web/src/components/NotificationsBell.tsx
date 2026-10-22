import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeftRight,
  Bell,
  BellRing,
  Building2,
  CalendarDays,
  CheckCheck,
  ChevronRight,
  ClipboardCheck,
  FileText,
  Inbox,
  Lock,
  Megaphone,
  MessageSquare,
  Plane,
  ShieldAlert,
  Sunrise,
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
import { EmptyState } from '@/components/ui/EmptyState';
import { FilterChip } from '@/components/ui/FilterBar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/Tooltip';
import { cn } from '@/lib/cn';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { useMediaQuery } from '@/lib/useViewport';

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
  messages: MessageSquare,
  store_daily: Sunrise,
  store_alerts: AlertTriangle,
  store_requests: Inbox,
  store_reports: FileText,
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

/* ---- "Only what needs me", and grouping ------------------------------- */

/** Told, not asked: digests, announcements, earnings, paystubs and other
 *  "it's done" notices, the store's daily reads. */
const FYI_CATEGORY = /digest|earnings|broadcast|announce|celebrat|kudos|week_ahead|whats_new|newsletter|recap|paystub|payslip|emailed|receipt|confirmed|_sent$/;
const FYI_BUCKETS: ReadonlySet<NotificationCategory> = new Set(['broadcast', 'growth', 'store_daily', 'store_reports']);

/**
 * Does this one ask something of the person? An unread item does when it is
 * urgent, or has somewhere to go and isn't the kind that only informs. Read
 * items have been dealt with — urgent ones too, so the count agrees with
 * the badge after "Mark all read".
 */
export function needsMe(n: Notification): boolean {
  if (n.readAt) return false;
  if (isUrgentCategory(n.category)) return true;
  if (!n.linkUrl) return false;
  const bucket = bucketForCategory(n.category);
  if (bucket && FYI_BUCKETS.has(bucket)) return false;
  return !FYI_CATEGORY.test(n.category ?? '');
}

export type BellRow = { kind: 'one'; n: Notification } | { kind: 'group'; key: string; items: Notification[] };

/**
 * Three or more of the same kind fold into one row ("12 schedule changes"),
 * placed where the newest of them falls; fewer stay as they are.
 */
export function groupNotifications(list: readonly Notification[], min = 3): BellRow[] {
  const keyOf = (n: Notification) => n.category ?? 'other';
  const counts = new Map<string, number>();
  for (const n of list) counts.set(keyOf(n), (counts.get(keyOf(n)) ?? 0) + 1);
  const groups = new Map<string, Notification[]>();
  const out: BellRow[] = [];
  for (const n of list) {
    const k = keyOf(n);
    if ((counts.get(k) ?? 0) < min) {
      out.push({ kind: 'one', n });
      continue;
    }
    const g = groups.get(k);
    if (g) g.push(n);
    else {
      const items = [n];
      groups.set(k, items);
      out.push({ kind: 'group', key: k, items });
    }
  }
  return out;
}

/**
 * What a folded group is called: its bucket's name ("12 schedule changes"),
 * else its kind in words ("10 overdue timesheet reminders" for
 * `overdue_timesheet_reminder`) — never `10 like "Overdue at Coastal…"`,
 * which read as a fragment of one of them (role walk floor 23).
 */
export function groupTitle(n: number, category: string | null, bucketLabel: string | null): string {
  if (bucketLabel) return `${n} ${bucketLabel.toLowerCase()}`;
  const words = (category ?? '').replace(/[._-]+/g, ' ').trim().toLowerCase();
  if (!words) return `${n} notifications`;
  if (/(reminder|alert|notice|request|update|change|message)$/.test(words)) return `${n} ${words}s`;
  return `${n} ${words} notifications`;
}

type BellFilter = 'all' | 'mine';
const FILTER_KEY = 'alto.bell.filter.v1';
function readFilter(key: string): BellFilter {
  try {
    return window.localStorage.getItem(key) === 'mine' ? 'mine' : 'all';
  } catch {
    return 'all';
  }
}

export function NotificationsBell() {
  // The full inbox page is a communications screen; portal accounts read
  // their notifications here in the panel only.
  const { can, user } = useAuth();
  const { t } = useI18n();
  const hasInboxPage = can('view:communications');
  // A tooltip is a hover affordance. On touch the first tap both opened the
  // "Notifications" tooltip and the panel, and the tooltip sat on top of
  // "Mark all read" (role walk floor 23) — so touch gets no tooltip at all:
  // one tap opens the panel. The aria-label still names the button.
  const canHover = useMediaQuery('(hover: hover) and (pointer: fine)');
  const [items, setItems] = useState<Notification[] | null>(null);
  const [total, setTotal] = useState(0);
  const [open, setOpen] = useState(false);
  // aria-live announcement text — screen readers hear arrivals without
  // the panel being open.
  const [announcement, setAnnouncement] = useState('');
  const prevUnseenRef = useRef(0);
  // One-shot swing on arrival; cleared by onAnimationEnd so a later
  // arrival can replay it.
  const [swing, setSwing] = useState(false);
  // Everything, or only what asks something of you — remembered per person
  // on this browser (a shared desk keeps each person's choice).
  const filterKey = `${FILTER_KEY}:${user?.id ?? 'anon'}`;
  const [filter, setFilterState] = useState<BellFilter>(() => readFilter(filterKey));
  const setFilter = (f: BellFilter) => {
    setFilterState(f);
    try {
      window.localStorage.setItem(filterKey, f);
    } catch {
      /* a per-viewer convenience */
    }
  };
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(new Set());

  const inboxQuery = useQuery({
    queryKey: ['NotificationsBell', 'inbox'],
    queryFn: async () => {
      try {
        return await listMyInbox();
      } catch (err) {
        // 403 just means this user can't view the inbox (CLIENT_PORTAL etc.)
        // — render the bell as empty rather than spamming an error.
        if (err instanceof ApiError && err.status === 403) return null;
        throw err;
      }
    },
    // Poll while the tab is visible (the interval pauses in a hidden tab,
    // so no backlog of fires dumps at once when the user returns) and
    // re-read the moment the tab comes back into focus.
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
    staleTime: 0,
  });
  const loadError = inboxQuery.isError;
  useEffect(() => {
    const res = inboxQuery.data;
    if (res === undefined) return;
    if (res === null) {
      setItems([]);
      return;
    }
    setItems(res.notifications);
    setTotal(res.total ?? res.notifications.length);
  }, [inboxQuery.data]);
  const { refetch } = inboxQuery;
  const refresh = useCallback(() => void refetch(), [refetch]);

  // Live SSE nudge — a notification just landed for this user; refetch
  // immediately instead of waiting out the poll interval.
  useEffect(() => onLiveEvent('notification', refresh), [refresh]);

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

  const onMarkGroupRead = (group: Notification[]) => {
    const unread = group.filter((x) => !x.readAt);
    if (unread.length === 0) return;
    const ids = new Set(unread.map((x) => x.id));
    const now = new Date().toISOString();
    setItems((prev) => prev?.map((x) => (ids.has(x.id) ? { ...x, readAt: now, seenAt: x.seenAt ?? now } : x)) ?? null);
    markAllRead([...ids]).catch(() => {
      toast.error('Could not mark as read');
      refresh();
    });
  };

  const filtered = filter === 'mine' ? (items ?? []).filter(needsMe) : (items ?? []);
  const shown = filtered.slice(0, SHOW_LIMIT);
  const rows = groupNotifications(shown);
  const needsMeCount = (items ?? []).filter(needsMe).length;
  // The footer says how many more there are, in either view.
  const listTotal = filter === 'mine' ? needsMeCount : total;
  const moreHidden = listTotal > shown.length;

  const renderItem = (n: Notification, nested = false) => {
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
          nested && 'pl-8',
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
              {meta.label && !nested && (
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
  };

  const renderGroup = (key: string, group: Notification[]) => {
    const newest = group[0]!;
    const meta = categoryMeta(newest.category);
    const isOpen = openGroups.has(key);
    const unread = group.filter((x) => !x.readAt).length;
    const title = groupTitle(group.length, newest.category, meta.label);
    return (
      <div key={`group:${key}`}>
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault();
            setOpenGroups((prev) => {
              const next = new Set(prev);
              if (next.has(key)) next.delete(key);
              else next.add(key);
              return next;
            });
          }}
          aria-expanded={isOpen}
          className={cn(
            'w-full items-start rounded-none px-3 py-2.5 cursor-pointer',
            'focus:bg-navy-secondary data-[highlighted]:bg-navy-secondary/60',
            unread > 0 && 'bg-gold/5'
          )}
        >
          <div className="flex items-start gap-2.5 w-full min-w-0">
            <span
              className={cn(
                'mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full',
                meta.urgent ? 'bg-alert/15 text-alert' : 'bg-navy-secondary/70 text-silver'
              )}
              aria-hidden="true"
            >
              <meta.Icon className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className={cn('text-sm truncate', meta.urgent ? 'text-alert' : 'text-ink', unread > 0 && 'font-medium')}>{title}</div>
              <div className="text-xs leading-snug text-silver truncate">{t('bell.latest', { text: newest.subject ?? newest.body })}</div>
              <div className="text-2xs text-silver/80 mt-0.5 tabular-nums">
                {fmt(newest.createdAt)}
                {unread > 0 ? ` · ${t('bell.nUnread', { n: unread })}` : ''}
              </div>
            </div>
            <ChevronRight className={cn('mt-1 h-4 w-4 shrink-0 text-silver transition-transform', isOpen && 'rotate-90')} aria-hidden="true" />
          </div>
        </DropdownMenuItem>
        {isOpen && (
          <>
            {unread > 0 && (
              <DropdownMenuItem
                onSelect={(e) => {
                  e.preventDefault();
                  onMarkGroupRead(group);
                }}
                className="w-full rounded-none py-1.5 pl-8 pr-3 text-2xs text-gold cursor-pointer focus:bg-navy-secondary data-[highlighted]:bg-navy-secondary/60"
              >
                <CheckCheck className="mr-1 h-3 w-3" aria-hidden="true" />
                {t('bell.markTheseRead', { n: unread })}
              </DropdownMenuItem>
            )}
            {group.map((n) => renderItem(n, true))}
          </>
        )}
      </div>
    );
  };

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      {/* Polite announcement channel for background arrivals. */}
      <span aria-live="polite" role="status" className="sr-only">
        {announcement}
      </span>
      {(() => {
        const trigger = (
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="relative"
              aria-label={unseenCount > 0 ? t('bell.ariaNew', { n: unseenCount }) : t('bell.title')}
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
        );
        // Touch: no tooltip — the tap is for the panel (floor 23).
        if (!canHover) return trigger;
        return (
          <Tooltip>
            <TooltipTrigger asChild>{trigger}</TooltipTrigger>
            <TooltipContent side="bottom">
              {unseenCount > 0 ? t(unseenCount === 1 ? 'bell.oneNew' : 'bell.nNew', { n: unseenCount }) : t('bell.title')}
            </TooltipContent>
          </Tooltip>
        );
      })()}

      <DropdownMenuContent
        align="end"
        // w-[22rem] (352px) clips on small phones (iPhone SE = 375px minus
        // gutter/safe-area). Cap to viewport minus 1rem of breathing room
        // on phones, then resume 22rem at sm+.
        className="w-[calc(100vw-1rem)] sm:w-[22rem] p-0"
      >
        <DropdownMenuLabel className="flex items-center justify-between gap-2 px-3 py-2.5">
          <span className="text-xs uppercase tracking-widest text-silver">
            {t('bell.inbox')}
          </span>
          {unreadCount > 0 && (
            <button
              type="button"
              onClick={() => void onMarkAllRead()}
              className="inline-flex items-center gap-1 rounded text-2xs text-gold hover:text-gold-bright focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
            >
              <CheckCheck className="h-3 w-3" />
              {t('bell.markAllRead')}
            </button>
          )}
        </DropdownMenuLabel>
        {items && items.length > 0 && (
          <div className="flex gap-1 px-3 pb-2" role="group" aria-label={t('bell.whichAria')}>
            <FilterChip active={filter === 'mine'} onClick={() => setFilter('mine')}>
              {needsMeCount ? t('bell.needsMeN', { n: needsMeCount }) : t('bell.needsMe')}
            </FilterChip>
            <FilterChip active={filter === 'all'} onClick={() => setFilter('all')}>
              {t('bell.everything')}
            </FilterChip>
          </div>
        )}
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
              {t('bell.failed')}
            </div>
          )}
          {items && items.length === 0 && (
            <div className="p-8 text-center">
              <div className="mx-auto h-10 w-10 rounded-full bg-navy-secondary/60 grid place-items-center mb-3">
                <Inbox className="h-5 w-5 text-silver" aria-hidden="true" />
              </div>
              <p className="text-sm text-white">{t('bell.caughtUp')}</p>
              <p className="text-xs text-silver mt-1">{t('bell.caughtUpBody')}</p>
            </div>
          )}
          {items && items.length > 0 && filter === 'mine' && shown.length === 0 && (
            <EmptyState
              size="sm"
              className="p-6"
              title={t('bell.nothingMine')}
              description={
                <>
                  {t('bell.nothingMineBody')}{' '}
                  <button type="button" className="text-gold hover:underline" onClick={() => setFilter('all')}>
                    {t('bell.showEverything')}
                  </button>
                </>
              }
            />
          )}
          {items && shown.length > 0 && (
            <div className="divide-y divide-navy-secondary">
              {/* DropdownMenuItem (not bare <button>) so Radix's roving
                  focus gives arrow-key traversal + typeahead for free. */}
              {rows.map((r) => (r.kind === 'one' ? renderItem(r.n) : renderGroup(r.key, r.items)))}
            </div>
          )}
        </div>
        {items && moreHidden && !hasInboxPage && (
          <>
            <DropdownMenuSeparator className="m-0" />
            <p className="px-3 py-2 text-center text-2xs text-silver/60">
              {t('bell.showingLatest', { shown: shown.length, total: listTotal })}
            </p>
          </>
        )}
        {items && moreHidden && hasInboxPage && (
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
              {t('bell.showing', { shown: shown.length, total: listTotal })} —{' '}
              <span className="text-gold">{t('bell.viewAll')}</span>
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
