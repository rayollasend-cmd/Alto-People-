import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { listMyInbox, markAllRead as markAllInboxRead, markRead } from '@/lib/communicationsApi';
import { markBroadcastRead, myBroadcasts } from '@/lib/dirCommsApi';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { dayHeading, fmtTimeOnly, groupByDay } from '@/lib/dayGroup';
import { fmtDateTime } from '@/lib/format';
import { enterStagger } from '@/lib/motion';
import { useI18n } from '@/lib/i18n';
import { usePullToRefresh, PullToRefreshIndicator } from '@/lib/usePullToRefresh';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { SearchInput } from '@/components/ui/FilterBar';
import { PageHeader } from '@/components/ui/PageHeader';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { ArrowUpRight, CheckCheck, ChevronRight, Inbox, Megaphone } from 'lucide-react';

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
  /** In-app deeplink (notifications only) — rendered as an "Open" action. */
  linkUrl: string | null;
}

export function AssociateInboxView() {
  const navigate = useNavigate();
  const [items, setItems] = useState<InboxEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [q, setQ] = useState('');
  const [markingAll, setMarkingAll] = useState(false);
  const { t } = useI18n();

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
            linkUrl: n.linkUrl,
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
            linkUrl: null,
          }),
        ),
      ].sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
      setItems(merged);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('inbox.loadFailed'));
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
      setError(err instanceof ApiError ? err.message : t('inbox.markFailed'));
    }
  };

  // "Open" action for notifications carrying a deeplink — mark read
  // best-effort (fire and forget), then navigate. Same behavior as the
  // topbar bell's row click.
  const openLink = (entry: InboxEntry) => {
    if (!entry.linkUrl) return;
    void onClick(entry);
    navigate(entry.linkUrl);
  };

  const markAllRead = async () => {
    if (!items) return;
    const unread = items.filter((i) => !i.readAt);
    if (unread.length === 0) return;
    setMarkingAll(true);
    try {
      // Notifications go through the one bulk endpoint (previously N
      // individual /read calls); broadcasts keep their per-row reads —
      // they live in a different table with no bulk route yet.
      const broadcasts = unread.filter((i) => i.kind === 'broadcast');
      await Promise.allSettled([
        markAllInboxRead(),
        ...broadcasts.map((i) => markBroadcastRead(i.sourceId)),
      ]);
      await refresh();
    } finally {
      setMarkingAll(false);
    }
  };

  const unreadCount = items?.filter((n) => !n.readAt).length ?? 0;

  // Same phone gesture as Home/Schedule — the inbox used to ignore it.
  const pullState = usePullToRefresh(refresh);

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
      <PullToRefreshIndicator state={pullState} />
      <PageHeader
        title={
          <>
            {t('inbox.title')}{' '}
            {unreadCount > 0 && (
              <span className="text-base text-gold align-middle ml-2">
                {t('inbox.unreadSuffix', { count: unreadCount })}
              </span>
            )}
          </>
        }
        subtitle={t('inbox.subtitle')}
      />

      {error && (
        <ErrorBanner
          className="mb-3"
          action={
            <Button size="sm" variant="secondary" onClick={() => void refresh()}>
              {t('common.retry')}
            </Button>
          }
        >
          {error}
        </ErrorBanner>
      )}

      {items && items.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <div className="flex-1 min-w-48">
            <SearchInput
              aria-label={t('inbox.searchAria')}
              placeholder={t('inbox.searchPlaceholder')}
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
            {t('inbox.unreadOnly')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={markingAll || unreadCount === 0}
            onClick={() => void markAllRead()}
          >
            <CheckCheck className="mr-1.5 h-3.5 w-3.5" />
            {markingAll ? t('inbox.marking') : t('inbox.markAll')}
          </Button>
        </div>
      )}

      {!items && !error && <SkeletonRows count={5} rowHeight="h-24" />}
      {items && items.length === 0 && (
        <EmptyState
          icon={Inbox}
          title={t('inbox.zeroTitle')}
          description={t('inbox.zeroDesc')}
        />
      )}
      {visible && items && items.length > 0 && visible.length === 0 && (
        <EmptyState
          icon={Inbox}
          title={t('inbox.noMatches')}
          description={
            unreadOnly
              ? t('inbox.noMatchesUnread')
              : t('inbox.noMatchesSearch')
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
                  {/* Friendly heading only — the raw ISO day key next to
                      "Today" read like debug output. Hover keeps the date. */}
                  <span className="font-medium text-white" title={group.key}>
                    {dayHeading(group.key)}
                  </span>
                  <span className="ml-auto text-silver/70">
                    {t(group.entries.length === 1 ? 'inbox.message' : 'inbox.messages', { count: group.entries.length })}
                    {unreadInGroup > 0 && (
                      <span className="ml-1 text-gold">{t('inbox.unreadInGroup', { count: unreadInGroup })}</span>
                    )}
                  </span>
                </summary>
                <ul className="space-y-2 p-3 pt-0">
                  {group.entries.map((n, i) => (
                    <li key={n.key} className="animate-enter" style={enterStagger(i)}>
                      {/* Wrapper div (not one big <button>) so the "Open"
                          deeplink action can be a real button without
                          invalid button-in-button nesting. */}
                      <div
                        className={cn(
                          'rounded border transition-colors',
                          n.readAt
                            ? 'border-navy-secondary bg-navy/60'
                            : 'border-gold/40 bg-gold/5 hover:bg-gold/10',
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => onClick(n)}
                          className="block w-full text-left p-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright rounded"
                        >
                          <div className="flex items-start justify-between gap-3 mb-1">
                            <div className="text-white flex items-center gap-2 min-w-0">
                              {n.kind === 'broadcast' && (
                                <Badge variant="accent" className="shrink-0 gap-1">
                                  <Megaphone className="h-3 w-3" /> {t('inbox.broadcast')}
                                </Badge>
                              )}
                              <span className="truncate">
                                {n.subject ?? (
                                  <span className="text-silver italic">{t('inbox.noSubject')}</span>
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
                            <div
                              className="text-2xs uppercase tracking-widest text-silver/70 mt-2"
                              title={n.senderEmail}
                            >
                              {/* A person's message, not a raw address —
                                  the email survives on hover. */}
                              {t('inbox.fromTeam')}
                            </div>
                          )}
                        </button>
                        {n.linkUrl && (
                          <div className="px-4 pb-3 flex justify-end">
                            <Button
                              size="sm"
                              variant="outline"
                              className="coarse:min-h-11"
                              onClick={() => openLink(n)}
                            >
                              {t('inbox.open')}
                              <ArrowUpRight className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        )}
                      </div>
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
