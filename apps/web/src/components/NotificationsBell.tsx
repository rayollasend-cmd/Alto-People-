import { useCallback, useEffect, useState } from 'react';
import { Bell, BellRing, CheckCheck, Inbox } from 'lucide-react';
import type { Notification } from '@alto-people/shared';
import { listMyInbox, markRead } from '@/lib/communicationsApi';
import { ApiError } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import { Skeleton } from '@/components/ui/Skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/Tooltip';
import { cn } from '@/lib/cn';

const POLL_MS = 60_000;

/**
 * Topbar notifications bell. Polls /communications/me/inbox once a minute,
 * shows an unread count badge, and reveals a panel listing the most recent
 * 50 in-app notifications. Clicking an unread item marks it read.
 *
 * Polling is dumb-on-purpose; web sockets / SSE land in a later phase if
 * the cadence proves too slow.
 */
export function NotificationsBell() {
  const [items, setItems] = useState<Notification[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await listMyInbox();
      setItems(res.notifications);
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
    const t = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(t);
  }, [refresh]);

  const unread = (items ?? []).filter((n) => !n.readAt);
  const unreadCount = unread.length;

  const onItemClick = async (n: Notification) => {
    if (n.readAt) return;
    try {
      await markRead(n.id);
      // Optimistic update so the badge drops immediately.
      setItems((prev) =>
        prev?.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)) ?? null
      );
    } catch {
      // Soft fail — refresh on next poll.
    }
  };

  const onMarkAllRead = async () => {
    if (!items) return;
    const toMark = items.filter((n) => !n.readAt);
    // Optimistic.
    setItems((prev) =>
      prev?.map((x) => (x.readAt ? x : { ...x, readAt: new Date().toISOString() })) ?? null
    );
    await Promise.allSettled(toMark.map((n) => markRead(n.id)));
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="relative"
              aria-label={
                unreadCount > 0
                  ? `Notifications (${unreadCount} unread)`
                  : 'Notifications'
              }
            >
              {unreadCount > 0 ? (
                <BellRing className="h-4 w-4" />
              ) : (
                <Bell className="h-4 w-4" />
              )}
              {unreadCount > 0 && (
                <span
                  className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-gold text-navy text-[10px] font-semibold flex items-center justify-center tabular-nums"
                  aria-hidden="true"
                >
                  {unreadCount > 9 ? '9+' : unreadCount}
                </span>
              )}
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {unreadCount > 0
            ? `${unreadCount} unread notification${unreadCount === 1 ? '' : 's'}`
            : 'Notifications'}
        </TooltipContent>
      </Tooltip>

      <DropdownMenuContent align="end" className="w-[22rem] p-0">
        <DropdownMenuLabel className="flex items-center justify-between gap-2 px-3 py-2.5">
          <span className="text-xs uppercase tracking-widest text-silver">
            Inbox
          </span>
          {unreadCount > 0 && (
            <button
              type="button"
              onClick={onMarkAllRead}
              className="inline-flex items-center gap-1 text-[10px] text-gold hover:text-gold-bright"
            >
              <CheckCheck className="h-3 w-3" />
              Mark all read
            </button>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator className="m-0" />

        <div className="max-h-[28rem] overflow-y-auto">
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
            <ul className="divide-y divide-navy-secondary/60">
              {items.slice(0, 50).map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => onItemClick(n)}
                    className={cn(
                      'w-full text-left px-3 py-2.5 hover:bg-navy-secondary/40 transition-colors',
                      'focus:outline-none focus-visible:bg-navy-secondary',
                      !n.readAt && 'bg-gold/5'
                    )}
                  >
                    <div className="flex items-start gap-2">
                      <span
                        className={cn(
                          'mt-1.5 h-2 w-2 rounded-full shrink-0',
                          n.readAt ? 'bg-transparent' : 'bg-gold'
                        )}
                        aria-hidden="true"
                      />
                      <div className="min-w-0 flex-1">
                        {n.subject && (
                          <div className="text-sm text-white font-medium truncate">
                            {n.subject}
                          </div>
                        )}
                        <div
                          className={cn(
                            'text-xs leading-snug',
                            n.readAt ? 'text-silver/70' : 'text-silver'
                          )}
                        >
                          {n.body}
                        </div>
                        <div className="text-[10px] text-silver/50 mt-0.5 tabular-nums">
                          {fmt(n.createdAt)}
                          {n.category && (
                            <span className="ml-2 uppercase tracking-widest">
                              · {n.category}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
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
  return d.toLocaleDateString();
}
