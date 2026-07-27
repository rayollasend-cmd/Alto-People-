import { useCallback, useEffect, useMemo, useState } from 'react';
import { listMyInbox, markRead } from '@/lib/communicationsApi';
import { markBroadcastRead, myBroadcasts } from '@/lib/dirCommsApi';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { dayHeading, fmtTimeOnly, groupByDay } from '@/lib/dayGroup';
import { fmtDateTime } from '@/lib/format';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { CheckCheck, ChevronRight, Inbox, Megaphone, Search } from 'lucide-react';

/**
 * One row in the merged inbox: either a direct IN_APP notification or a
 * company broadcast the user is a receipt-holder of. Normalized so the
 * day-grouping, unread logic, and search treat both uniformly.
 */
interface InboxEntry {
  /** Unique list key — source ids can collide across the two tables. */
  key: string;
  kind: 'message' | 'broadcast';
  /** Source row id (notification id or broadcast id) for mark-read calls. */
  sourceId: string;
  subject: string | null;
  body: string;
  createdAt: string;
  readAt: string | null;
  senderEmail: string | null;
}

export function AssociateInboxView() {
  const [items, setItems] = useState<InboxEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [q, setQ] = useState('');
  const [markingAll, setMarkingAll] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const [inbox, bcasts] = await Promise.all([listMyInbox(), myBroadcasts()]);
      const merged: InboxEntry[] = [
        ...inbox.notifications.map(
          (n): InboxEntry => ({
            key: `n-${n.id}`,
            kind: 'message',
            sourceId: n.id,
            subject: n.subject,
            body: n.body,
            createdAt: n.createdAt,
            readAt: n.readAt,
            senderEmail: n.senderEmail,
          }),
        ),
        ...bcasts.broadcasts.map(
          (b): InboxEntry => ({
            key: `b-${b.id}`,
            kind: 'broadcast',
            sourceId: b.id,
            subject: b.title,
            body: b.body,
            // Receipts only exist once a broadcast was sent, so sentAt is
            // effectively always set; fall back to "now" defensively.
            createdAt: b.sentAt ?? new Date().toISOString(),
            readAt: b.readAt,
            senderEmail: null,
          }),
        ),
      ].sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
      setItems(merged);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load inbox.');
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const onClick = async (entry: InboxEntry) => {
    if (entry.readAt) return;
    try {
      if (entry.kind === 'broadcast') {
        await markBroadcastRead(entry.sourceId);
      } else {
        await markRead(entry.sourceId);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Mark-read failed.');
    }
  };

  const markAllRead = async () => {
    if (!items) return;
    const unread = items.filter((i) => !i.readAt);
    if (unread.length === 0) return;
    setMarkingAll(true);
    try {
      await Promise.allSettled(
        unread.map((i) =>
          i.kind === 'broadcast'
            ? markBroadcastRead(i.sourceId)
            : markRead(i.sourceId),
        ),
      );
      await refresh();
    } finally {
      setMarkingAll(false);
    }
  };

  const unreadCount = items?.filter((n) => !n.readAt).length ?? 0;

  const visible = useMemo(() => {
    if (!items) return null;
    const term = q.trim().toLowerCase();
    return items.filter((i) => {
      if (unreadOnly && i.readAt) return false;
      if (!term) return true;
      return (
        (i.subject ?? '').toLowerCase().includes(term) ||
        i.body.toLowerCase().includes(term) ||
        (i.senderEmail ?? '').toLowerCase().includes(term)
      );
    });
  }, [items, unreadOnly, q]);

  return (
    <div className="mx-auto">
      <PageHeader
        title={
          <>
            Inbox{' '}
            {unreadCount > 0 && (
              <span className="text-base text-gold align-middle ml-2">
                ({unreadCount} unread)
              </span>
            )}
          </>
        }
        subtitle="Messages from HR, system notifications, and company broadcasts."
      />

      {error && (
        <p role="alert" className="text-sm text-alert mb-3">
          {error}{' '}
          <button
            type="button"
            className="underline hover:text-white"
            onClick={() => refresh()}
          >
            Retry
          </button>
        </p>
      )}

      {items && items.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <div className="relative flex-1 min-w-48">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-silver" />
            <Input
              className="pl-9"
              aria-label="Search messages"
              placeholder="Search subject, body, or sender…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <Button
            size="sm"
            variant={unreadOnly ? 'secondary' : 'outline'}
            aria-pressed={unreadOnly}
            onClick={() => setUnreadOnly((v) => !v)}
          >
            Unread only
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={markingAll || unreadCount === 0}
            onClick={() => void markAllRead()}
          >
            <CheckCheck className="mr-1.5 h-3.5 w-3.5" />
            {markingAll ? 'Marking…' : 'Mark all read'}
          </Button>
        </div>
      )}

      {!items && !error && <SkeletonRows count={5} rowHeight="h-24" />}
      {items && items.length === 0 && (
        <EmptyState
          icon={Inbox}
          title="Inbox zero"
          description="Messages from HR, system notifications, and broadcasts will land here."
        />
      )}
      {visible && items && items.length > 0 && visible.length === 0 && (
        <EmptyState
          icon={Inbox}
          title="No matches"
          description={
            unreadOnly
              ? 'Nothing unread matches. Clear the filters to see everything.'
              : 'Nothing matches your search.'
          }
        />
      )}
      {visible && visible.length > 0 && (
        <div className="space-y-3">
          {groupByDay(visible).map((group, idx) => {
            const unreadInGroup = group.entries.filter((n) => !n.readAt).length;
            return (
              <details
                key={group.key}
                open={idx === 0 || unreadInGroup > 0}
                className="rounded-lg border border-navy-secondary bg-navy/40 [&[open]>summary>svg.chev]:rotate-90"
              >
                <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs hover:bg-navy-secondary/40">
                  <ChevronRight className="chev h-4 w-4 text-silver/70 transition-transform" />
                  <span className="font-medium text-white">{dayHeading(group.key)}</span>
                  <span className="text-silver/70">· {group.key}</span>
                  <span className="ml-auto text-silver/70">
                    {group.entries.length} message
                    {group.entries.length === 1 ? '' : 's'}
                    {unreadInGroup > 0 && (
                      <span className="ml-1 text-gold">· {unreadInGroup} unread</span>
                    )}
                  </span>
                </summary>
                <ul className="space-y-2 p-3 pt-0">
                  {group.entries.map((n) => (
                    <li key={n.key}>
                      <button
                        type="button"
                        onClick={() => onClick(n)}
                        className={cn(
                          'block w-full text-left p-4 rounded border transition-colors',
                          n.readAt
                            ? 'border-navy-secondary bg-navy/60'
                            : 'border-gold/40 bg-gold/5 hover:bg-gold/10',
                        )}
                      >
                        <div className="flex items-start justify-between gap-3 mb-1">
                          <div className="text-white flex items-center gap-2 min-w-0">
                            {n.kind === 'broadcast' && (
                              <Badge variant="accent" className="shrink-0 gap-1">
                                <Megaphone className="h-3 w-3" /> Broadcast
                              </Badge>
                            )}
                            <span className="truncate">
                              {n.subject ?? (
                                <span className="text-silver italic">(no subject)</span>
                              )}
                            </span>
                          </div>
                          <span
                            className="text-xs text-silver/70 tabular-nums shrink-0"
                            title={fmtDateTime(n.createdAt)}
                          >
                            {fmtTimeOnly(n.createdAt)}
                          </span>
                        </div>
                        <div className="text-sm text-silver whitespace-pre-line">
                          {n.body}
                        </div>
                        {n.senderEmail && (
                          <div className="text-[10px] uppercase tracking-widest text-silver/70 mt-2">
                            From {n.senderEmail}
                          </div>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            );
          })}
        </div>
      )}
    </div>
  );
}
