import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Camera,
  Download,
  MessageSquare,
  MessageSquarePlus,
  Search,
  Send,
  Store,
  Users,
} from 'lucide-react';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { onLiveEvent } from '@/lib/liveEvents';
import { fmtDate, fmtDateTime, fmtRelativeDate, fmtTime } from '@/lib/format';
import { cn } from '@/lib/cn';
import { personPhotoUrl } from '@/lib/photoUrl';
import {
  getDirect,
  getThread,
  listConversations,
  markRead,
  messageDirectory,
  searchMessages,
  sendMessage,
  sendPhoto,
  startConversation,
  transcriptUrl,
  personLine,
  type ConversationRow,
  type MessagePerson,
  type MessageRow,
} from '@/lib/messagesApi';
import { PageHeader } from '@/components/ui/PageHeader';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Input, Textarea } from '@/components/ui/Input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { downloadStatementFile } from '@/pages/clients/statementsShared';
import { usePageHero } from '@/lib/pageTitle';
import type { MessageKey } from '@/lib/i18n';

/** Whose copy: the store's people, the driver, the associate, or the desks (F500 G5). */
type Voice = 'store' | 'driver' | 'associate' | 'staff';
function voiceOf(role: string | undefined): Voice {
  if (role === 'CLIENT_PORTAL' || role === 'SHIFT_SUPERVISOR' || role === 'FLOOR_SUPERVISOR') return 'store';
  if (role === 'DRIVER') return 'driver';
  if (role === 'ASSOCIATE') return 'associate';
  return 'staff';
}
const SUBTITLE: Record<Voice, MessageKey> = {
  store: 'msg.subtitle',
  driver: 'msg.subtitleDriver',
  associate: 'msg.subtitleAssociate',
  staff: 'msg.subtitleStaff',
};


/**
 * What a failed send says. A reason the server gave on purpose ("Write
 * something.") is shown as is; a crash or a lost connection isn't the
 * user's to read — they're told their message is still there to retry.
 */
/** The Message.body column, counted in characters as the server counts. */
const MESSAGE_MAX = 4000;
/** Show the counter from here on — before the limit bites, not after. */
const COUNTER_FROM = MESSAGE_MAX - 500;

function failureText(err: unknown, fallback: string): string {
  return err instanceof ApiError && err.status < 500 ? err.message : fallback;
}
/**
 * Messages — the store manager texts the supervisor on the floor and the
 * thread is the record. Two panes on iPad and web (inbox left, thread
 * right), one pane on a phone. Threads are append-only; the transcript
 * downloads as a dated CSV. Who may message whom is a server rule
 * (lib/messaging.ts) — the directory only offers people the caller may
 * reach. Live: a new message refreshes open tabs through the live
 * channel; the inbox also polls as a backstop.
 */

const photoUrl = (p: MessagePerson) => p.photoUrl;

/**
 * The messenger fills what's left of the shell's <main> exactly. Phone
 * chrome (topbar + notch, safe areas, the tab bar) varies by device, so
 * the height is measured off <main> instead of a magic calc — the
 * composer can never fall below the fold behind a nested scroller.
 *
 * "What's left": anything above the messenger in <main> — the "Install
 * Alto" banner, on a phone that hasn't installed the app — is taken off.
 * It used to fill <main>'s whole height from wherever it started, so the
 * banner pushed the composer down under the tab bar, reachable only by
 * scrolling the page — and a swipe in a chat scrolls the messages.
 */
function useFillMain() {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    const el = ref.current;
    const main = el?.closest('main');
    if (!el || !main) return;
    const apply = () => {
      const cs = getComputedStyle(main);
      // How far into <main>'s content the messenger starts: its top
      // padding plus whatever sits above it.
      const above = el.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop;
      const h = main.clientHeight - above - parseFloat(cs.paddingBottom || '0');
      if (Number.isFinite(h) && h > 0) setHeight(Math.max(320, Math.floor(h)));
    };
    apply();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(apply) : null;
    ro?.observe(main);
    // What sits above the messenger — the install banner's slot, beside
    // the page in <main> — grows when a banner shows and collapses when
    // it's dismissed; watch every sibling along the way up.
    for (let a: Element = el; a.parentElement && a !== main; a = a.parentElement) {
      for (const sib of Array.from(a.parentElement.children)) if (sib !== a) ro?.observe(sib);
    }
    window.addEventListener('resize', apply);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', apply);
    };
  }, []);
  return { ref, height };
}

export function MessagesHome() {
  const fill = useFillMain();
  const { t } = useI18n();
  const { user } = useAuth();
  const navigate = useNavigate();
  const { id } = useParams<{ id?: string }>();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const [composeOpen, setComposeOpen] = useState(false);
  const [q, setQ] = useState('');

  const inbox = useQuery({
    queryKey: ['messages', 'inbox'],
    queryFn: listConversations,
    refetchInterval: 60_000,
  });
  useEffect(
    () =>
      onLiveEvent('message', () => {
        void queryClient.invalidateQueries({ queryKey: ['messages'] });
      }),
    [queryClient],
  );

  // Deep link from anywhere: /messages?to=<userId> opens the direct thread
  // with that person, or a draft that becomes the thread with its first
  // message — never an empty thread (F500 G5: it fired twice and made two).
  const to = searchParams.get('to');
  // Looked up once per address (a query, so a re-render or a second effect
  // run can't start anything twice), never created here.
  const direct = useQuery({ queryKey: ['messages', 'direct', to], queryFn: () => getDirect(to!), enabled: !!to, retry: false, staleTime: 60_000 });
  const handledTo = useRef<string | null>(null);
  useEffect(() => {
    if (!to || handledTo.current === to) return;
    if (direct.data?.conversationId) {
      handledTo.current = to;
      navigate(`/messages/${direct.data.conversationId}`, { replace: true });
    } else if (direct.isError) {
      handledTo.current = to;
      toast.error(direct.error instanceof Error ? direct.error.message : t('msg.startFailed'));
    }
  }, [to, direct.data, direct.isError, direct.error, navigate, t]);
  const draftTo: MessagePerson | null = to && direct.data && !direct.data.conversationId ? direct.data.person : null;

  const search = useQuery({
    queryKey: ['messages', 'search', q],
    queryFn: () => searchMessages(q),
    enabled: q.trim().length >= 2,
  });

  if (!user) return null;
  const rows = inbox.data?.conversations ?? [];
  const totalUnread = rows.reduce((a, r) => a + r.unread, 0);
  const voice = voiceOf(user.role);
  // A draft (from ?to=) sits where a thread would.
  const draft = !id && draftTo ? draftTo : null;
  const threadOpen = !!id || !!draft;

  return (
    <div ref={fill.ref} className="mx-auto flex h-[calc(100dvh-8.5rem)] max-w-6xl flex-col md:h-[calc(100dvh-7rem)]" style={fill.height ? { height: fill.height } : undefined}>
      <PageHeader
        title={t('msg.title')}
        // One line on a phone: the list starts on the first screen.
        subtitle={<span className="line-clamp-1 sm:line-clamp-none">{totalUnread > 0 ? t('msg.unreadLine', { count: totalUnread }) : t(SUBTITLE[voice])}</span>}
        className={cn('mb-3', threadOpen && 'hidden md:block')}
        primaryAction={
          <>
            {/* Phone: an icon in the header row, not a full-width button. */}
            <Button size="icon-sm" className="sm:hidden" onClick={() => setComposeOpen(true)} aria-label={t('msg.new')} title={t('msg.new')}>
              <MessageSquarePlus className="h-4 w-4" aria-hidden="true" />
            </Button>
            <Button size="sm" className="hidden sm:inline-flex" onClick={() => setComposeOpen(true)}>
              <MessageSquarePlus className="mr-1.5 h-4 w-4" aria-hidden="true" />
              {t('msg.new')}
            </Button>
          </>
        }
      />
      <div className="flex min-h-0 flex-1 gap-4">
        {/* ---- Inbox ------------------------------------------------------ */}
        <aside
          className={cn(
            'flex w-full min-w-0 flex-col rounded-lg border border-navy-secondary bg-navy-secondary/10 md:w-80 md:shrink-0',
            threadOpen && 'hidden md:flex',
          )}
        >
          {/* No search box over an empty list. */}
          {(rows.length > 0 || q) && (
          <div className="p-2">
            <label className="relative block">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-silver/50" aria-hidden="true" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t('msg.search')}
                className="pl-8"
                aria-label={t('msg.search')}
              />
            </label>
          </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {q.trim().length >= 2 ? (
              <ul className="divide-y divide-navy-secondary/60">
                {(search.data?.results ?? []).length === 0 ? (
                  <li className="p-4 text-sm text-silver/60">{t('msg.searchNone')}</li>
                ) : (
                  search.data!.results.map((r) => (
                    <li key={r.messageId}>
                      <Link to={`/messages/${r.conversationId}`} className="block px-3 py-2.5 hover:bg-navy-secondary/30">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="truncate text-sm font-medium text-ink">{r.conversationTitle}</span>
                          <span className="shrink-0 text-2xs tabular-nums text-silver/50">{fmtDate(r.createdAt)}</span>
                        </div>
                        <p className="mt-0.5 line-clamp-2 text-xs text-silver/70">
                          {r.senderName && <span className="text-silver">{r.senderName}: </span>}
                          {r.body}
                        </p>
                      </Link>
                    </li>
                  ))
                )}
              </ul>
            ) : inbox.isError && !inbox.data ? (
              <div className="p-4">
                <ErrorBanner
                  action={
                    <Button size="sm" variant="secondary" onClick={() => void inbox.refetch()}>
                      {t('common.retry')}
                    </Button>
                  }
                >
                  {t('msg.loadFailed')}
                </ErrorBanner>
              </div>
            ) : inbox.isLoading ? (
              <div className="space-y-2 p-3">
                <Skeleton className="h-12" />
                <Skeleton className="h-12" />
                <Skeleton className="h-12" />
              </div>
            ) : rows.length === 0 ? (
              <div className="p-4">
                <EmptyState icon={MessageSquare} title={t('msg.none')} description={t(voice === 'store' ? 'msg.noneHint' : 'msg.noneHintOther')} />
              </div>
            ) : (
              <ul className="divide-y divide-navy-secondary/60">
                {rows.map((c) => (
                  <li key={c.id}>
                    <Link
                      to={`/messages/${c.id}`}
                      className={cn(
                        'flex items-center gap-3 px-3 py-2.5 hover:bg-navy-secondary/30',
                        id === c.id && 'bg-navy-secondary/40',
                      )}
                    >
                      <ConversationAvatar c={c} meId={user.id} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className={cn('min-w-0 truncate text-sm', c.unread > 0 ? 'font-semibold text-ink' : 'font-medium text-ink/90')}>
                            {c.title}
                          </span>
                          {c.lastMessageAt && (
                            <span className="shrink-0 text-2xs tabular-nums text-silver/50">{fmtRelativeDate(c.lastMessageAt)}</span>
                          )}
                        </div>
                        {/* Who they are: "Associate · Front Beach 218" (a direct thread). */}
                        {c.kind === 'DIRECT' && (() => {
                          const other = c.participants.find((p) => p.id !== user.id);
                          const line = other ? personLine(other) : '';
                          return line ? <div className="truncate text-2xs text-silver/60" data-testid="row-person-line">{line}</div> : null;
                        })()}
                        <div className="flex items-center gap-2">
                          <p className={cn('min-w-0 flex-1 truncate text-xs', c.unread > 0 ? 'text-silver' : 'text-silver/60')}>
                            {c.lastPreview ?? t('msg.noMessagesYet')}
                          </p>
                          {c.unread > 0 && (
                            <span className="shrink-0 rounded-full bg-gold px-1.5 text-2xs font-semibold tabular-nums text-on-accent">
                              {c.unread}
                            </span>
                          )}
                        </div>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>

        {/* ---- Thread ----------------------------------------------------- */}
        <section className={cn('min-w-0 flex-1', !threadOpen && 'hidden md:block')}>
          {id ? (
            <Thread key={id} id={id} meId={user.id} />
          ) : draft ? (
            <DraftThread
              person={draft}
              onStarted={(cid) => {
                void queryClient.invalidateQueries({ queryKey: ['messages'] });
                navigate(`/messages/${cid}`, { replace: true });
              }}
            />
          ) : (
            <div className="hidden h-full items-center justify-center rounded-lg border border-dashed border-navy-secondary md:flex">
              {rows.length === 0 && inbox.data ? (
                // Nothing to pick: the way to start one, not "pick on the left".
                <EmptyState
                  icon={MessageSquarePlus}
                  title={t('msg.new')}
                  description={t('msg.draftHint')}
                  action={
                    <Button size="sm" onClick={() => setComposeOpen(true)}>
                      {t('msg.new')}
                    </Button>
                  }
                />
              ) : (
                <EmptyState icon={MessageSquare} title={t('msg.pick')} description={t(voice === 'store' ? 'msg.pickHint' : 'msg.pickHintOther')} />
              )}
            </div>
          )}
        </section>
      </div>

      <ComposeDialog
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
        onStarted={(cid) => {
          setComposeOpen(false);
          void queryClient.invalidateQueries({ queryKey: ['messages'] });
          navigate(`/messages/${cid}`);
        }}
      />
    </div>
  );
}

function ConversationAvatar({ c, meId }: { c: ConversationRow; meId: string }) {
  if (c.kind === 'STORE_CHANNEL') {
    return (
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-gold/15 text-gold">
        <Store className="h-5 w-5" aria-hidden="true" />
      </span>
    );
  }
  const others = c.participants.filter((p) => p.id !== meId);
  if (c.kind === 'GROUP' || others.length !== 1) {
    return (
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-navy-secondary text-silver">
        <Users className="h-5 w-5" aria-hidden="true" />
      </span>
    );
  }
  const p = others[0]!;
  return <Avatar src={photoUrl(p)} name={p.name} email="" size="md" />;
}

/* ---- One thread ---------------------------------------------------------- */

function Thread({ id, meId }: { id: string; meId: string }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const thread = useQuery({
    queryKey: ['messages', 'thread', id],
    queryFn: () => getThread(id),
    refetchInterval: 30_000,
  });
  useEffect(
    () =>
      onLiveEvent('message', () => {
        void queryClient.invalidateQueries({ queryKey: ['messages', 'thread', id] });
      }),
    [queryClient, id],
  );
  const count = thread.data?.messages.length ?? 0;
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [count, id]);
  // Reading the thread clears its unread count on the inbox and the badge —
  // once per new message, not on every background refresh.
  const lastMessageId = thread.data?.messages[thread.data.messages.length - 1]?.id ?? null;
  useEffect(() => {
    if (!lastMessageId) return;
    void markRead(id).then(() => queryClient.invalidateQueries({ queryKey: ['messages', 'inbox'] }));
  }, [id, lastMessageId, queryClient]);

  const length = Array.from(draft).length;
  const tooLong = length > MESSAGE_MAX;
  const send = useCallback(async () => {
    const body = draft.trim();
    if (!body) return;
    if (Array.from(body).length > MESSAGE_MAX) {
      toast.error(t('msg.tooLong', { max: MESSAGE_MAX.toLocaleString() }));
      return;
    }
    setBusy(true);
    try {
      await sendMessage(id, body);
      setDraft('');
      await queryClient.invalidateQueries({ queryKey: ['messages'] });
    } catch (err) {
      toast.error(failureText(err, t('msg.sendFailed')));
    } finally {
      setBusy(false);
    }
  }, [draft, id, queryClient, t]);

  const attach = async (file: File) => {
    setBusy(true);
    try {
      await sendPhoto(id, file, draft.trim());
      setDraft('');
      await queryClient.invalidateQueries({ queryKey: ['messages'] });
    } catch (err) {
      toast.error(failureText(err, t('msg.sendFailed')));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const data = thread.data;
  const groups = useMemo(() => groupByDay(data?.messages ?? []), [data]);
  const loadFailed = thread.isError && !data;
  const others = (data?.participants ?? []).filter((p) => p.id !== meId);
  const participantById = useMemo(() => new Map((data?.participants ?? []).map((p) => [p.id, p])), [data]);
  // The conversation's name is the page's: the phone's top bar shows it with
  // its Back (it read "Mes…" beside a second back arrow in the card).
  const heroRef = usePageHero<HTMLHeadingElement>(data?.title, data ? [{ label: t('msg.title'), to: '/messages' }, { label: data.title }] : null);

  return (
    <div className="flex h-full min-h-0 flex-col rounded-lg border border-navy-secondary bg-navy-secondary/10">
      <header className="flex items-center gap-2 border-b border-navy-secondary px-3 py-2">
        <div className="min-w-0 flex-1">
          <h2 ref={heroRef} className="hidden truncate text-sm font-medium text-ink md:block">{data?.title ?? '…'}</h2>
          {data && (
            <div className="truncate text-2xs text-silver/60" data-testid="thread-subtitle">
              {data.kind === 'STORE_CHANNEL'
                ? t('msg.channelMembers', { count: data.participants.length })
                : data.kind === 'DIRECT'
                  ? // "Associate · Front Beach 218", not the name a second time.
                    others.map((p) => personLine(p)).filter(Boolean).join(' · ')
                  : others.map((p) => p.name).join(', ')}
            </div>
          )}
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void downloadStatementFile(transcriptUrl(id), `messages-${id.slice(0, 8)}.csv`)}
          title={t('msg.transcript')}
          aria-label={t('msg.transcript')}
        >
          <Download className="h-4 w-4" aria-hidden="true" />
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {loadFailed && (
          <ErrorBanner
            action={
              <Button size="sm" variant="secondary" onClick={() => void thread.refetch()}>
                {t('common.retry')}
              </Button>
            }
          >
            {t('msg.loadFailed')}
          </ErrorBanner>
        )}
        {!data ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-2/3" />
            <Skeleton className="ml-auto h-10 w-1/2" />
          </div>
        ) : data.messages.length === 0 ? (
          <p className="py-8 text-center text-sm text-silver/60">{t('msg.threadEmpty')}</p>
        ) : (
          groups.map((g) => (
            <div key={g.day}>
              <div className="my-3 text-center text-2xs uppercase tracking-wider text-silver/50">{g.label}</div>
              {g.messages.map((m) => (
                <Bubble
                  key={m.id}
                  m={m}
                  showSender={data.kind !== 'DIRECT'}
                  // Someone who has since left the group isn't a participant
                  // any more — their userId still finds their face.
                  senderPhoto={personPhotoUrl({
                    photoUrl: m.senderId ? participantById.get(m.senderId)?.photoUrl : null,
                    userId: m.senderId,
                  })}
                />
              ))}
            </div>
          ))
        )}
        {data && data.seenUpTo && data.messages.some((m) => m.mine && m.createdAt <= data.seenUpTo!) && (
          <div className="mt-1 text-right text-2xs text-silver/50">{t('msg.seen')}</div>
        )}
        <div ref={bottomRef} />
      </div>

      <footer className="border-t border-navy-secondary p-2">
        <div className="flex items-end gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void attach(f);
            }}
          />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            aria-label={t('msg.photo')}
            title={t('msg.photo')}
          >
            <Camera className="h-4 w-4" aria-hidden="true" />
          </Button>
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends only with a keyboard; on a phone Return is a newline.
              if (e.key === 'Enter' && !e.shiftKey && (window.matchMedia?.('(pointer: fine)').matches ?? true)) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={t('msg.placeholder')}
            rows={1}
            maxLength={4000}
            className="min-h-10 flex-1 resize-none"
            aria-label={t('msg.placeholder')}
          />
          <Button size="md" onClick={() => void send()} loading={busy} disabled={!draft.trim() || tooLong}>
            <Send className="h-4 w-4" aria-hidden="true" />
            <span className="sr-only">{t('msg.send')}</span>
          </Button>
        </div>
        <div className="mt-1 flex items-baseline justify-between gap-3 px-1">
          <p className="text-2xs text-silver/40">{t('msg.recordNote')}</p>
          {length >= COUNTER_FROM && (
            <p
              role={tooLong ? 'alert' : 'status'}
              aria-live="polite"
              className={cn('shrink-0 text-2xs tabular-nums', tooLong ? 'font-semibold text-alert' : 'text-silver/70')}
            >
              {tooLong
                ? t('msg.tooLong', { max: MESSAGE_MAX.toLocaleString() })
                : t('msg.charCount', { count: length.toLocaleString(), max: MESSAGE_MAX.toLocaleString() })}
            </p>
          )}
        </div>
      </footer>
    </div>
  );
}

function Bubble({ m, showSender, senderPhoto }: { m: MessageRow; showSender: boolean; senderPhoto?: string }) {
  if (m.kind === 'SYSTEM') {
    return <div className="my-2 text-center text-2xs text-silver/50">{m.body}</div>;
  }
  const withFace = showSender && !m.mine && !!m.senderName;
  return (
    <div className={cn('mb-2 flex', m.mine ? 'justify-end' : 'justify-start', withFace && 'items-end gap-2')}>
      {withFace && <Avatar src={senderPhoto} name={m.senderName} size="xs" />}
      <div
        className={cn(
          'max-w-[85%] rounded-2xl px-3 py-2 text-sm md:max-w-[70%]',
          m.mine ? 'rounded-br-sm bg-gold/20 text-ink' : 'rounded-bl-sm bg-navy-secondary/70 text-ink',
        )}
      >
        {showSender && !m.mine && m.senderName && (
          <div className="mb-0.5 text-2xs font-medium text-gold">
            {m.senderName}
            {m.senderRole && <span className="font-normal text-silver/60"> · {m.senderRole}</span>}
          </div>
        )}
        {m.attachment && (
          <a href={m.attachment.url} target="_blank" rel="noreferrer" className="mb-1 block">
            <img
              src={m.attachment.url}
              alt={m.attachment.name ?? ''}
              className="max-h-64 rounded-lg object-cover"
              loading="lazy"
            />
          </a>
        )}
        {m.body && <p className="whitespace-pre-wrap break-words">{m.body}</p>}
        <div className={cn('mt-0.5 text-2xs tabular-nums text-silver', m.mine && 'text-right')} title={fmtDateTime(m.createdAt)}>
          {fmtTime(m.createdAt)}
        </div>
      </div>
    </div>
  );
}

function groupByDay(messages: MessageRow[]): Array<{ day: string; label: string; messages: MessageRow[] }> {
  const out: Array<{ day: string; label: string; messages: MessageRow[] }> = [];
  for (const m of messages) {
    const day = fmtDate(m.createdAt);
    const last = out[out.length - 1];
    if (last && last.day === day) last.messages.push(m);
    else out.push({ day, label: day, messages: [m] });
  }
  return out;
}

/* ---- A first message to one person (/messages?to=) ------------------------- */

function DraftThread({ person, onStarted }: { person: MessagePerson; onStarted: (id: string) => void }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const heroRef = usePageHero<HTMLHeadingElement>(person.name, [{ label: t('msg.title'), to: '/messages' }, { label: person.name }]);
  const send = async () => {
    const body = draft.trim();
    if (!body) return;
    setBusy(true);
    try {
      const r = await startConversation({ participantIds: [person.id], body });
      onStarted(r.id);
    } catch (err) {
      toast.error(failureText(err, t('msg.startFailed')));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex h-full min-h-0 flex-col rounded-lg border border-navy-secondary bg-navy-secondary/10" data-testid="message-draft">
      <header className="flex items-center gap-2 border-b border-navy-secondary px-3 py-2">
        <Avatar src={person.photoUrl ?? undefined} name={person.name} email="" size="sm" />
        <div className="min-w-0 flex-1">
          <h2 ref={heroRef} className="truncate text-sm font-medium text-ink">{person.name}</h2>
          <div className="truncate text-2xs text-silver/60">{personLine(person)}</div>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-sm text-silver/70">{t('msg.draftHint')}</div>
      <footer className="border-t border-navy-secondary p-2">
        <div className="flex items-end gap-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t('msg.placeholder')}
            rows={1}
            maxLength={4000}
            className="min-h-10 flex-1 resize-none"
            aria-label={t('msg.placeholder')}
            autoFocus
          />
          <Button size="md" onClick={() => void send()} loading={busy} disabled={!draft.trim()}>
            <Send className="h-4 w-4" aria-hidden="true" />
            <span className="sr-only">{t('msg.send')}</span>
          </Button>
        </div>
      </footer>
    </div>
  );
}

/* ---- Start a thread -------------------------------------------------------- */

function ComposeDialog({
  open,
  onClose,
  onStarted,
}: {
  open: boolean;
  onClose: () => void;
  onStarted: (id: string) => void;
}) {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<MessagePerson[]>([]);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const directory = useQuery({
    queryKey: ['messages', 'directory', q],
    queryFn: () => messageDirectory(q),
    enabled: open,
    staleTime: 60_000,
  });
  useEffect(() => {
    if (!open) {
      setQ('');
      setPicked([]);
      setBody('');
    }
  }, [open]);

  const start = async () => {
    setBusy(true);
    try {
      const r = await startConversation({
        participantIds: picked.map((p) => p.id),
        body: body.trim(),
      });
      onStarted(r.id);
    } catch (err) {
      toast.error(failureText(err, t('msg.startFailed')));
    } finally {
      setBusy(false);
    }
  };
  const candidates = (directory.data?.people ?? []).filter((p) => !picked.some((x) => x.id === p.id));

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && !o && onClose()} confirmDiscard={() => body.trim().length > 0}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('msg.new')}</DialogTitle>
          <DialogDescription>{t('msg.newHint')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {picked.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {picked.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setPicked((s) => s.filter((x) => x.id !== p.id))}
                  className="flex items-center gap-1.5 rounded-full bg-gold/15 py-0.5 pl-1 pr-2 text-xs text-ink"
                  aria-label={t('msg.remove', { name: p.name })}
                >
                  <Avatar src={photoUrl(p)} name={p.name} email="" size="xs" />
                  {p.name}
                  <span aria-hidden="true" className="text-silver/60">
                    ×
                  </span>
                </button>
              ))}
            </div>
          )}
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('msg.findPerson')} autoFocus={typeof window === 'undefined' || !window.matchMedia?.('(pointer: coarse)').matches} />
          <ul className="max-h-56 divide-y divide-navy-secondary/60 overflow-y-auto rounded-md border border-navy-secondary">
            {directory.isError ? (
              // A failed lookup isn't "nobody matches" — say so, with a retry.
              <li role="alert" className="flex items-center justify-between gap-3 p-3 text-xs text-alert">
                <span>{t('msg.directoryFailed')}</span>
                <Button size="xs" variant="secondary" onClick={() => void directory.refetch()} loading={directory.isFetching}>
                  {t('common.retry')}
                </Button>
              </li>
            ) : candidates.length === 0 ? (
              <li className="p-3 text-xs text-silver/60">{directory.isLoading ? '…' : t('msg.noPeople')}</li>
            ) : (
              candidates.slice(0, 40).map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => setPicked((s) => [...s, p])}
                    className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-navy-secondary/30"
                  >
                    <Avatar src={photoUrl(p)} name={p.name} email="" size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-ink">{p.name}</span>
                      <span className="block truncate text-2xs text-silver/60">{personLine({ ...p, siteName: p.siteName ?? p.clientName })}</span>
                    </span>
                  </button>
                </li>
              ))
            )}
          </ul>
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={t('msg.firstMessageNeeded')}
            aria-label={t('msg.firstMessageNeeded')}
            rows={3}
            maxLength={4000}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          {/* A conversation starts with its first message — no empty threads in two inboxes. */}
          <Button onClick={() => void start()} loading={busy} disabled={picked.length === 0 || !body.trim()}>
            <Send className="mr-1.5 h-4 w-4" aria-hidden="true" />
            {t('msg.start')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
