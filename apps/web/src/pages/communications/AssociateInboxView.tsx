import { useCallback, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { listMyInbox, markAllRead as markAllInboxRead, markKindRead, markRead } from '@/lib/communicationsApi';
import { markBroadcastRead, myBroadcasts } from '@/lib/dirCommsApi';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { dayHeading, fmtTimeOnly, groupByDay } from '@/lib/dayGroup';
import { fmtDateTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { useMediaQuery } from '@/lib/useViewport';
import { usePullToRefresh, PullToRefreshIndicator } from '@/lib/usePullToRefresh';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { SearchInput } from '@/components/ui/FilterBar';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { ListTemplate } from '@/components/templates';
import { ArrowUpRight, CheckCheck, Inbox, Megaphone } from 'lucide-react';
import { toast } from 'sonner';

/**
 * One row in the merged inbox: either a direct IN_APP notification or a
 * company broadcast the user is a receipt-holder of. Normalized so the
 * day-grouping, unread logic, and search treat both uniformly.
 */
export interface InboxEntry {
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
  /** The notification's category (notifications only) — what "clear all of this kind" clears. */
  category: string | null;
}

/** The kind a reminder belongs to: its category's first two parts ("compliance.attestation"). */
const kindOf = (category: string | null) => (category ? category.split('.').slice(0, 2).join('.') : null);

/** "Hi Maria," / "Dear Ana," — a salutation, not what the message is about. */
const GREETING = /^(hi|hello|hey|dear|hola|good (morning|afternoon|evening))\b[^.!?]{0,40},?$/i;

/** The one-line preview: the body's first line that says something (past the bullet and the "Hi Maria,"). */
export function previewOf(body: string): string {
  const lines = body.split('\n').map((l) => l.replace(/^[\s•\-*]+/, '').trim()).filter(Boolean);
  return lines.find((l) => !GREETING.test(l)) ?? lines[0] ?? '';
}

/** Rows shown before "Show more": 87 unread used to render as a 9,000px page of open cards. */
export const INBOX_PAGE = 50;

const INBOX_KEY = ['AssociateInboxView', 'inbox'] as const;

/** The merged inbox (notifications + broadcasts), newest first. Shared with the page's tab label. */
export function useInboxEntries() {
  return useQuery({
    queryKey: INBOX_KEY,
    queryFn: async () => {
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
            category: n.category,
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
            category: null,
          }),
        ),
      ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      return merged;
    },
  });
}

export interface AssociateInboxViewProps {
  /** Inside the Notifications page's own header (the comms manager's tabs): no second title. */
  embedded?: boolean;
}

/**
 * Everyone's notifications. A list of one-line rows — unread dot, subject,
 * a preview, the time — not a stack of open cards: the full message opens
 * in a reading pane beside the list on a wide screen, under its row on a
 * phone. Several can be picked and marked read at once; the list shows 50
 * at a time.
 */
export function AssociateInboxView({ embedded = false }: AssociateInboxViewProps) {
  const navigate = useNavigate();
  const { t } = useI18n();
  const wide = useMediaQuery('(min-width: 1024px)');
  const [errorLocal, setError] = useState<string | null>(null);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [q, setQ] = useState('');
  const [markingAll, setMarkingAll] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const [markingPicked, setMarkingPicked] = useState(false);
  const [limit, setLimit] = useState(INBOX_PAGE);

  const inboxQuery = useInboxEntries();
  const items = inboxQuery.data ?? null;
  const error =
    errorLocal ??
    (inboxQuery.error ? (inboxQuery.error instanceof ApiError ? inboxQuery.error.message : t('inbox.loadFailed')) : null);
  const { refetch } = inboxQuery;
  const refresh = useCallback(async () => {
    setError(null);
    await refetch();
  }, [refetch]);

  const markOne = async (entry: InboxEntry) => {
    if (entry.readAt) return;
    try {
      if (entry.kind === 'broadcast') await markBroadcastRead(entry.sourceId);
      else await markRead(entry.sourceId);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('inbox.markFailed'));
    }
  };

  /** Opening a row reads it; on a phone a second tap folds it away again. */
  const openEntry = (entry: InboxEntry) => {
    setOpenKey((cur) => (cur === entry.key && !wide ? null : entry.key));
    void markOne(entry);
  };

  // "Open" for notifications carrying a deeplink — mark read best-effort,
  // then go. Same behaviour as the topbar bell's row click.
  const openLink = (entry: InboxEntry) => {
    if (!entry.linkUrl) return;
    void markOne(entry);
    navigate(entry.linkUrl);
  };

  const markAllRead = async () => {
    if (!items) return;
    const unread = items.filter((i) => !i.readAt);
    if (unread.length === 0) return;
    setMarkingAll(true);
    try {
      // Notifications go through the one bulk endpoint; broadcasts keep
      // their per-row reads — they live in another table with no bulk route.
      const broadcasts = unread.filter((i) => i.kind === 'broadcast');
      await Promise.allSettled([markAllInboxRead(), ...broadcasts.map((i) => markBroadcastRead(i.sourceId))]);
      await refresh();
    } finally {
      setMarkingAll(false);
    }
  };

  const togglePick = (key: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const markPickedRead = async () => {
    if (!items) return;
    const chosen = items.filter((i) => picked.has(i.key) && !i.readAt);
    setMarkingPicked(true);
    try {
      const ids = chosen.filter((i) => i.kind === 'message').map((i) => i.sourceId);
      await Promise.allSettled([
        ...(ids.length > 0 ? [markAllInboxRead(ids)] : []),
        ...chosen.filter((i) => i.kind === 'broadcast').map((i) => markBroadcastRead(i.sourceId)),
      ]);
      setPicked(new Set());
      await refresh();
    } finally {
      setMarkingPicked(false);
    }
  };

  const unreadCount = items?.filter((n) => !n.readAt).length ?? 0;

  // Piles of one kind of reminder (a daily compliance nag, a weekly digest):
  // three or more unread of the same kind get one "clear all of this kind".
  const piles = useMemo(() => {
    const by = new Map<string, { kind: string; count: number; subject: string }>();
    for (const i of items ?? []) {
      const kind = i.kind === 'message' && !i.readAt ? kindOf(i.category) : null;
      if (!kind) continue;
      const cur = by.get(kind);
      if (cur) cur.count++;
      else by.set(kind, { kind, count: 1, subject: i.subject ?? kind });
    }
    return [...by.values()].filter((p) => p.count >= 3).sort((a, b) => b.count - a.count);
  }, [items]);
  const [clearingKind, setClearingKind] = useState<string | null>(null);
  const clearKind = async (kind: string) => {
    setClearingKind(kind);
    try {
      const r = await markKindRead(kind);
      toast.success(t('inbox.clearedKind', { count: r.updated }));
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('inbox.markFailed'));
    } finally {
      setClearingKind(null);
    }
  };

  // Same phone gesture as Home/Schedule.
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
  const shown = visible?.slice(0, limit) ?? null;
  const more = visible ? visible.length - (shown?.length ?? 0) : 0;
  // On a wide screen the reading pane shows the row that was opened.
  const reading = wide ? (items?.find((i) => i.key === openKey) ?? null) : null;

  const pickedUnread = items?.filter((i) => picked.has(i.key) && !i.readAt).length ?? 0;

  const toolbar = items && items.length > 0 && (
    <div className="flex flex-wrap items-center gap-2">
      <div className="min-w-48 flex-1">
        <SearchInput
          aria-label={t('inbox.searchAria')}
          placeholder={t('inbox.searchPlaceholder')}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setLimit(INBOX_PAGE);
          }}
        />
      </div>
      <Button size="sm" variant={unreadOnly ? 'secondary' : 'outline'} aria-pressed={unreadOnly} onClick={() => setUnreadOnly((v) => !v)}>
        {t('inbox.unreadOnly')}
      </Button>
      <Button size="sm" variant="outline" disabled={markingAll || unreadCount === 0} onClick={() => void markAllRead()}>
        <CheckCheck className="mr-1.5 h-3.5 w-3.5" />
        {markingAll ? t('inbox.marking') : t('inbox.markAll')}
      </Button>
    </div>
  );

  const body = (
    <>
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

      {toolbar}

      {piles.length > 0 && (
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface-raised">
          {piles.map((p) => (
            <li key={p.kind} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-sm">
              {/* Wraps to two lines, and the button drops under it on a phone, rather than cutting the subject to "Overdu…". */}
              <span className="line-clamp-2 min-w-0 flex-1 basis-56 text-ink">{t('inbox.kindPile', { count: p.count, subject: p.subject })}</span>
              <Button size="sm" variant="ghost" aria-label={t('inbox.clearKind')} loading={clearingKind === p.kind} onClick={() => void clearKind(p.kind)}>
                <CheckCheck className="mr-1.5 h-3.5 w-3.5" />
                <span className="sm:hidden">{t('inbox.clearKindShort')}</span>
                <span className="hidden sm:inline">{t('inbox.clearKind')}</span>
              </Button>
            </li>
          ))}
        </ul>
      )}

      {picked.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-gold/40 bg-gold/5 px-3 py-2 text-sm" role="region" aria-label={t('inbox.selectedCount', { count: picked.size })}>
          <span className="flex-1 text-ink">{t('inbox.selectedCount', { count: picked.size })}</span>
          <Button size="sm" loading={markingPicked} disabled={pickedUnread === 0} onClick={() => void markPickedRead()}>
            <CheckCheck className="mr-1.5 h-3.5 w-3.5" />
            {t('inbox.markSelected')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())}>
            {t('inbox.clearSelection')}
          </Button>
        </div>
      )}

      {!items && !error && <SkeletonRows count={6} rowHeight="h-12" />}
      {items && items.length === 0 && <EmptyState icon={Inbox} title={t('inbox.zeroTitle')} description={t('inbox.zeroDesc')} />}
      {visible && items && items.length > 0 && visible.length === 0 && (
        <EmptyState icon={Inbox} title={t('inbox.noMatches')} description={unreadOnly ? t('inbox.noMatchesUnread') : t('inbox.noMatchesSearch')} />
      )}
      {shown && shown.length > 0 && (
        <div className={cn(wide && 'grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]')}>
          <div className="min-w-0 overflow-hidden rounded-lg border border-line bg-surface">
            {groupByDay(shown).map((group) => {
              const unreadInGroup = group.entries.filter((n) => !n.readAt).length;
              return (
                <section key={group.key} aria-label={dayHeading(group.key)}>
                  <div className="flex items-center gap-2 border-b border-line bg-surface-raised px-3 py-1.5 text-xs">
                    <span className="font-medium text-ink" title={group.key}>
                      {dayHeading(group.key)}
                    </span>
                    <span className="ml-auto text-ink-muted">
                      {t(group.entries.length === 1 ? 'inbox.message' : 'inbox.messages', { count: group.entries.length })}
                      {unreadInGroup > 0 && <span className="ml-1 text-gold">{t('inbox.unreadInGroup', { count: unreadInGroup })}</span>}
                    </span>
                  </div>
                  <ul className="divide-y divide-line">
                    {group.entries.map((n) => (
                      <InboxRow
                        key={n.key}
                        entry={n}
                        open={openKey === n.key}
                        inlineBody={!wide && openKey === n.key}
                        picked={picked.has(n.key)}
                        onPick={() => togglePick(n.key)}
                        onOpen={() => openEntry(n)}
                        onFollow={() => openLink(n)}
                      />
                    ))}
                  </ul>
                </section>
              );
            })}
            {more > 0 && (
              <div className="border-t border-line p-2 text-center">
                <Button size="sm" variant="ghost" onClick={() => setLimit((l) => l + INBOX_PAGE)}>
                  {t('inbox.showMore', { count: Math.min(more, INBOX_PAGE) })}
                </Button>
              </div>
            )}
          </div>
          {wide && (
            <aside className="min-w-0 rounded-lg border border-line bg-surface p-5 lg:sticky lg:top-20" aria-live="polite">
              {reading ? (
                <MessageView entry={reading} onFollow={() => openLink(reading)} />
              ) : (
                <p className="py-10 text-center text-sm text-ink-muted">{t('inbox.readerEmpty')}</p>
              )}
            </aside>
          )}
        </div>
      )}
    </>
  );

  if (embedded) {
    return (
      <>
        <PullToRefreshIndicator state={pullState} />
        <div className="space-y-3">{body}</div>
      </>
    );
  }

  return (
    <>
      <PullToRefreshIndicator state={pullState} />
      <ListTemplate
        title={t('inbox.title')}
        topbarTitle={t('inbox.title')}
        subtitle={t('inbox.subtitle')}
        status={unreadCount > 0 ? <Badge variant="accent">{t('inbox.unreadBadge', { count: unreadCount })}</Badge> : undefined}
      >
        <div className="space-y-3">{body}</div>
      </ListTemplate>
    </>
  );
}

function InboxRow({
  entry: n,
  open,
  inlineBody,
  picked,
  onPick,
  onOpen,
  onFollow,
}: {
  entry: InboxEntry;
  open: boolean;
  inlineBody: boolean;
  picked: boolean;
  onPick: () => void;
  onOpen: () => void;
  onFollow: () => void;
}) {
  const { t } = useI18n();
  const unread = !n.readAt;
  const subject = n.subject ?? t('inbox.noSubject');
  return (
    <li className={cn(open && 'bg-surface-raised')} data-inbox-row={n.key}>
      <div className={cn('flex items-start gap-2.5 px-3 py-2', unread && !open && 'bg-gold/[0.04]')}>
        <input
          type="checkbox"
          className="mt-1 h-5 w-5 shrink-0 accent-gold coarse:h-6 coarse:w-6"
          checked={picked}
          onChange={onPick}
          aria-label={t('inbox.selectAria', { subject })}
        />
        <button
          type="button"
          onClick={onOpen}
          aria-expanded={inlineBody ? true : undefined}
          aria-current={open && !inlineBody ? 'true' : undefined}
          className="min-w-0 flex-1 rounded text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright coarse:min-h-11"
        >
          <span className="flex items-center gap-2">
            <span className={cn('h-2 w-2 shrink-0 rounded-full', unread ? 'bg-gold' : 'bg-transparent')} aria-hidden="true" />
            {unread && <span className="sr-only">{t('inbox.unreadDot')}</span>}
            {n.kind === 'broadcast' && <Megaphone className="h-3.5 w-3.5 shrink-0 text-accent" aria-label={t('inbox.broadcast')} />}
            <span className={cn('min-w-0 flex-1 truncate text-sm text-ink', unread && 'font-semibold')} data-message-content>
              {subject}
            </span>
            <span className="shrink-0 text-xs tabular-nums text-ink-muted" title={fmtDateTime(n.createdAt)}>
              {fmtTimeOnly(n.createdAt)}
            </span>
          </span>
          <span className="mt-0.5 block truncate pl-4 text-xs text-ink-muted" data-message-content>
            {previewOf(n.body)}
          </span>
        </button>
      </div>
      {inlineBody && (
        <div className="px-3 pb-3 pl-11">
          <MessageView entry={n} onFollow={onFollow} compact />
        </div>
      )}
    </li>
  );
}

function MessageView({ entry: n, onFollow, compact = false }: { entry: InboxEntry; onFollow: () => void; compact?: boolean }) {
  const { t } = useI18n();
  return (
    <article className="space-y-3">
      {!compact && (
        <SectionTitle
          as="h2"
          title={n.subject ?? t('inbox.noSubject')}
          description={
            <span className="flex flex-wrap items-center gap-2">
              <span>{fmtDateTime(n.createdAt)}</span>
              {n.kind === 'broadcast' && (
                <Badge variant="accent" className="gap-1">
                  <Megaphone className="h-3 w-3" aria-hidden="true" /> {t('inbox.broadcast')}
                </Badge>
              )}
            </span>
          }
          wrap
        />
      )}
      <div className="whitespace-pre-line text-sm leading-relaxed text-ink" data-message-content>
        {n.body}
      </div>
      {n.senderEmail && (
        <p className="text-xs text-ink-muted" title={n.senderEmail}>
          {t('inbox.fromTeam')}
        </p>
      )}
      {n.linkUrl && (
        <Button size="sm" variant="outline" className="coarse:min-h-11" onClick={onFollow}>
          {t('inbox.open')}
          <ArrowUpRight className="h-3.5 w-3.5" />
        </Button>
      )}
    </article>
  );
}
