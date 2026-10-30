import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { findSensitiveNumbers } from '@alto-people/shared';
import { hugoBadgeCount, type HugoStep, type HugoTaskOffer } from '@alto-people/shared';
import {
  ArrowLeftRight,
  ArrowRight,
  ArrowUp,
  Bell,
  Bookmark,
  BookOpen,
  Bus,
  CalendarDays,
  Check,
  Copy,
  FileText,
  History,
  Inbox,
  ListTodo,
  Lock,
  MessageSquare,
  Mic,
  MoreHorizontal,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Square,
  Users,
  Volume2,
  Wallet,
  X,
  type LucideIcon,
} from '@/components/ui/icons';
import { HugoMascot, isHugo, preloadHugo, type HugoPose } from '@/components/hugo/HugoMascot';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAssistant } from '@/lib/assistantContext';
import { useI18n, type MessageKey } from '@/lib/i18n';
import '@/lib/i18n/en/hugoPane';
import '@/lib/i18n/en/hugoWork';
import { askHugo, clearHugoThread, decideAssistantAction, handoffToPerson, setHugoReadAloud, type ActionResult, type AssistantActionCard, type AssistantTable, type HugoAnswer } from '@/lib/hugoApi';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/DropdownMenu';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { cn } from '@/lib/cn';
import { useSpeechInput, useSpeechOutput } from './useSpeech';
import { HugoTaskOfferCard } from './HugoTaskOffer';
import { HugoGoalOfferCard } from './HugoGoalOffer';
import { HugoTasksPanel } from './HugoTasksPanel';
import { HugoMemoryChip } from './HugoMemoryChip';
import type { HugoThreadView } from '@alto-people/shared';
import { HUGO_ALLOWANCE_KEY, HugoAllowanceMeter, HugoAllowanceNotice, useHugoAllowance } from './HugoAllowance';
import { HUGO_PROFILE_KEY, HUGO_THREAD_KEY, mergeThread, useHugoProfile, useHugoThread } from './HugoThread';

/** What Hugo knows — its own chunk, fetched the first time it opens. */
const HugoMemoryView = lazy(() => import('./HugoMemoryView').then((m) => ({ default: m.HugoMemoryView })));

/**
 * Hugo's panel: a column at the right that stays open while the person
 * works (below md, the whole screen), with one conversation that follows
 * the account to every device it signs in on (kept on the server for 90
 * days — HugoThread; this tab's session copy only paints it first). Every
 * question carries the page the person is on, so an answer can say "this
 * person"; the conversation so far is read on the server, never sent.
 *
 * Hugo is an agent, not a chat box, and the panel shows it:
 *  - he acts out what he is doing, at a size you notice (status below):
 *    listening while you type or talk, reading your records, working on a
 *    task, talking as the answer lands, celebrating a confirmed action,
 *    handing you to a person, a coffee break when left alone, asleep offline;
 *  - each answer says where it came from; nothing runs until the person
 *    confirms it (action cards); a hand-off is offered, never sent unasked;
 *  - a microphone for asking out loud — in the person's language — and the
 *    answer read back when they did (or always, from the menu);
 *  - "don't share your SSN or bank details here": a message carrying one is
 *    stopped before it is sent (shared/sensitiveText; the API strips any
 *    that get through);
 *  - he works while you do other things: the Tasks tab holds what you
 *    handed him and what he noticed for you (HugoTasksPanel), a Start card
 *    in the chat hands him something new, and the header says when he is
 *    working in the background.
 */

interface Turn {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** What the answer came from (the registry's intent) — the source line under it. */
  intent?: string;
  linkUrl?: string | null;
  handoff?: { summary: string; who: string | null } | null;
  handoffSent?: boolean;
  /** Actions the assistant set up; each runs only when the person confirms it. */
  actions?: AssistantActionCard[];
  /** What happened to each action, by id. */
  results?: Record<string, ActionResult>;
  tables?: AssistantTable[];
  /** Work the answer offered to take on; each starts only on the person's tap. */
  offers?: HugoTaskOffer[];
  /** What this answer kept in What Hugo knows (the chip, with Undo), and how many it forgot. */
  remembered?: HugoAnswer['remembered'];
  forgot?: number;
  /** When this tab added it — lines it up with the server's copy of the thread (HugoThread mergeThread). */
  localAt?: number;
}

const KEY = (userId: string) => `alto:assistant:thread:${userId}`;
const READ_ALOUD_KEY = 'alto.hugo.readAloud';
const MAX_TURNS = 40;

function readThread(userId: string): Turn[] {
  try {
    const raw = window.sessionStorage.getItem(KEY(userId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Turn[]) : [];
  } catch {
    return [];
  }
}

function writeThread(userId: string, turns: Turn[]): void {
  try {
    window.sessionStorage.setItem(KEY(userId), JSON.stringify(turns.slice(-MAX_TURNS)));
  } catch {
    /* session storage is a convenience */
  }
}

function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

/** What Hugo is doing — the status line, and the pose he shows it with. */
type Status = 'ready' | 'listening' | 'hearing' | 'reading' | 'working' | 'answered' | 'speaking' | 'done' | 'handoff' | 'coffee' | 'offline';
const POSE_OF: Record<Status, HugoPose> = {
  ready: 'listening',
  listening: 'listening',
  hearing: 'listening',
  reading: 'reading',
  working: 'working',
  answered: 'talking',
  speaking: 'talking',
  done: 'celebrate',
  handoff: 'handoff',
  coffee: 'coffee',
  offline: 'offline',
};
/** Reading the records first, then working on the answer. */
const READING_MS = 1500;
const ANSWERED_MS = 2600;
const DONE_MS = 3400;
const HELLO_MS = 2600;
/** Left alone this long, he takes a coffee break (any keystroke brings him back). */
const COFFEE_MS = 60_000;

/** The registry's intents that read the person's records — the source line under an answer. */
const SOURCED = new Set(['PAYDAY', 'RIDE', 'SCHEDULE', 'RENEW', 'DESK', 'COVERAGE', 'HELP_CENTER', 'MODEL', 'DRIVER_NEXT_RUN', 'DRIVER_RUN_RIDERS']);
/** A suggestion's icon, by what it asks for. */
const ICON_OF: Record<string, LucideIcon> = {
  PAYDAY: Wallet,
  RIDE: Bus,
  SCHEDULE: CalendarDays,
  RENEW: FileText,
  DESK: Inbox,
  COVERAGE: Users,
  HELP_CENTER: BookOpen,
  DRIVER_NEXT_RUN: Bus,
  DRIVER_RUN_RIDERS: Users,
  HANDOFF: MessageSquare,
  TASK_FIND_COVER: ArrowLeftRight,
  TASK_TELL_ME_WHEN: Bell,
  TASK_CHASE: Users,
  TASK_LIST: ListTodo,
};

const isPhone = () => typeof window !== 'undefined' && window.matchMedia?.('(max-width: 767px)').matches;

export function AssistantPane() {
  const { user, isOffline } = useAuth();
  const { t, lang } = useI18n();
  const { available, me, open, setOpen, takeQueued, page, tab, setTab, openTasks, summary, setLive } = useAssistant();
  const userId = user?.id ?? '';
  const [turns, setTurns] = useState<Turn[]>(() => (userId ? readThread(userId) : []));
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const [readAloud, setReadAloud] = useState(() => readFlag(READ_ALOUD_KEY));
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // The clock his states run on: when the panel opened, the question went, the answer landed…
  const [now, setNow] = useState(() => Date.now());
  const [openedAt, setOpenedAt] = useState(() => Date.now());
  const [askedAt, setAskedAt] = useState(0);
  const [answeredAt, setAnsweredAt] = useState(0);
  const [doneAt, setDoneAt] = useState(0);
  const [activeAt, setActiveAt] = useState(() => Date.now());
  // The answer as it is made (POST /hugo/ask/stream): the step he is on, and the words so far.
  const [liveStep, setLiveStep] = useState<HugoStep | null>(null);
  const [liveText, setLiveText] = useState('');
  // What Hugo knows, open over the panel.
  const [memoryOpen, setMemoryOpen] = useState(false);
  const askedByVoice = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const voiceOut = useSpeechOutput(lang);
  const queryClient = useQueryClient();
  // The conversation and the person's settings follow the account (API lib/hugoThread): the session copy is only first paint.
  const thread = useHugoThread(available && open && Boolean(userId));
  const profile = useHugoProfile(available && open);
  // Their own allowance for his thinking (the meter, the 80% line, the used-up banner) — only when a model answers.
  const allowance = useHugoAllowance(available && open && Boolean(me?.model));

  useEffect(() => {
    if (userId) writeThread(userId, turns);
  }, [userId, turns]);

  const ask = useMutation({
    mutationFn: (q: string) => {
      // The conversation so far is read on the server — the account's own turns — never sent from here.
      return askHugo(q, {
        page,
        onEvent: (e) => {
          if (e.t === 'step') {
            setLiveStep(e.step);
            setLive({ step: e.step });
          } else if (e.t === 'text') setLiveText((x) => x + e.d);
          else setLiveText('');
        },
      });
    },
    onMutate: (q) => {
      const qid = `${Date.now()}-u`;
      setTurns((x) => [...x, { id: qid, role: 'user', text: q, localAt: Date.now() }]);
      setText('');
      setAskedAt(Date.now());
      setLiveStep(null);
      setLiveText('');
      setLive({ step: null });
      return { qid };
    },
    onSettled: () => {
      setLiveStep(null);
      setLiveText('');
      setLive(null);
    },
    onSuccess: (a: HugoAnswer, _q, ctx) => {
      // The server kept both: the question takes its id, the answer comes with its own (one copy, whatever arrived first).
      const at = Date.now();
      const kept = a.turns ?? null;
      setTurns((x) => x.map((y) => (kept && y.id === ctx?.qid ? { ...y, id: kept.question.id, localAt: at } : y)));
      setTurns((x) => [...x.filter((y) => !kept || y.id !== kept.answer.id), { id: kept?.answer.id ?? `${at}-a`, localAt: at, role: 'assistant', text: a.reply, intent: a.intent, linkUrl: a.linkUrl, handoff: a.handoff ?? null, actions: a.actions ?? [], tables: a.tables ?? [], offers: a.offers ?? [], remembered: a.remembered, forgot: a.forgot }]);
      setAnsweredAt(Date.now());
      // An answer may have used some of the person's thinking time: the meter refreshes.
      void queryClient.invalidateQueries({ queryKey: HUGO_ALLOWANCE_KEY });
      // "What are you working on?" — the answer is the Tasks tab.
      if (a.view === 'tasks') setTab('tasks');
      setActiveAt(Date.now());
      if (askedByVoice.current || readAloud) voiceOut.speak(a.reply);
    },
    onError: (err) => {
      const msg = err instanceof ApiError ? err.message : t('hugoPane.error.answer');
      setTurns((x) => [...x, { id: `${Date.now()}-e`, role: 'assistant', text: msg, localAt: Date.now() }]);
    },
  });

  const handoff = useMutation({
    mutationFn: (summary: string) => handoffToPerson(summary),
    onSuccess: (r) => {
      setTurns((x) => x.map((y) => (y.handoff && !y.handoffSent ? { ...y, handoffSent: true } : y)).concat({ id: r.turn?.id ?? `${Date.now()}-h`, localAt: Date.now(), role: 'assistant', text: r.reply, linkUrl: r.linkUrl }));
      if (r.sent) setDoneAt(Date.now());
    },
  });

  const decide = useMutation({
    mutationFn: ({ card, decision }: { turnId: string; card: AssistantActionCard; decision: 'confirm' | 'cancel' }) => decideAssistantAction(card.token, decision),
    onSuccess: (r, v) => {
      setTurns((x) => x.map((y) => (y.id === v.turnId ? { ...y, results: { ...(y.results ?? {}), [v.card.id]: r } } : y)));
      if (r.status === 'done' || r.status === 'pending_approval') setDoneAt(Date.now());
    },
    onError: (err, v) => {
      const message = err instanceof ApiError ? err.message : t('hugoPane.error.action');
      setTurns((x) => x.map((y) => (y.id === v.turnId ? { ...y, results: { ...(y.results ?? {}), [v.card.id]: { status: 'failed', title: v.card.title, message, linkUrl: null } } } : y)));
    },
  });

  // The server's thread is the truth: what this tab added since it was fetched stays until the server has it.
  useEffect(() => {
    if (!thread.data || ask.isPending) return;
    const server = thread.data;
    const fetchedAt = thread.dataUpdatedAt;
    setTurns((local) => mergeThread(server, fetchedAt, local));
  }, [thread.data, thread.dataUpdatedAt, ask.isPending]);

  // "Start over" — on every device: the server forgets the turns, and other devices drop their copy.
  const startOver = useMutation({
    mutationFn: () => clearHugoThread(),
    onMutate: () => {
      const before = turns;
      setTurns([]);
      return { before };
    },
    onSuccess: (r) => queryClient.setQueryData<HugoThreadView>(HUGO_THREAD_KEY, (old) => ({ turns: [], clearedAt: r.clearedAt, retentionDays: old?.retentionDays ?? 90 })),
    onError: (_e, _v, ctx) => setTurns([...(ctx?.before ?? []), { id: `${Date.now()}-e`, role: 'assistant', text: t('hugoPane.thread.clearFailed'), localAt: Date.now() }]),
  });

  // Read aloud follows the account. Never chosen on any device: this browser's earlier choice goes up, once.
  const readAloudSet = useMutation({
    mutationFn: (on: boolean) => setHugoReadAloud(on),
    onSuccess: (p) => queryClient.setQueryData(HUGO_PROFILE_KEY, p),
  });
  useEffect(() => {
    const p = profile.data;
    if (!p) return;
    if (p.readAloud === null) {
      if (readFlag(READ_ALOUD_KEY) && readAloudSet.isIdle) readAloudSet.mutate(true);
      return;
    }
    setReadAloud(p.readAloud);
    try {
      window.localStorage.setItem(READ_ALOUD_KEY, p.readAloud ? '1' : '0');
    } catch {
      /* the first-paint copy is a convenience */
    }
    // Once per answer from the server; the mutation is stable enough to leave out.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.data]);

  const send = (q: string, opts: { voice?: boolean } = {}) => {
    const trimmed = q.trim();
    if (!trimmed || ask.isPending || findSensitiveNumbers(trimmed).length) return;
    askedByVoice.current = Boolean(opts.voice);
    voiceOut.stop();
    ask.mutate(trimmed);
  };

  const voiceIn = useSpeechInput(lang, (said) => {
    setActiveAt(Date.now());
    // Said aloud, it goes at once — unless it carries a number Hugo must not see; then it waits, with the warning.
    if (findSensitiveNumbers(said).length) setText(said);
    else send(said, { voice: true });
  });

  // A question handed in from a seat, the palette or a chip.
  useEffect(() => {
    if (!open) return;
    setOpenedAt(Date.now());
    setActiveAt(Date.now());
    preloadHugo(['hello', 'listening', 'reading', 'working', 'talking', 'face']);
    const q = takeQueued();
    if (q) send(q);
    // A phone's keyboard would cover his greeting; a mouse user starts typing.
    else if (!isPhone()) inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // His clock: twice a second while the panel is open.
  useEffect(() => {
    if (!open) return;
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [open]);

  // Follow the conversation to its newest line — but an empty one opens at
  // the top, his greeting whole (on a phone it opened scrolled to the
  // suggestions, Hugo cut in half).
  useEffect(() => {
    if (!turns.length && !ask.isPending) return;
    listRef.current?.scrollTo?.({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns, ask.isPending, liveText]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  // The panel closing stops him talking.
  useEffect(() => {
    if (!open) voiceOut.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // It opens on the chat again next time.
  useEffect(() => {
    if (!open) setMemoryOpen(false);
  }, [open]);

  if (!available || !open || !me) return null;
  const name = me.name;
  const hugo = isHugo(name);
  const lastTurn = turns[turns.length - 1];
  const handoffOpen = Boolean(lastTurn?.handoff && !lastTurn.handoffSent);
  const draft = voiceIn.listening ? voiceIn.interim : text;
  const sensitive = findSensitiveNumbers(text).length > 0;

  // While the answer streams he says what he is doing: reading a kind of
  // record, setting something up (at the laptop), then the words.
  const liveStatus: Status | null = !ask.isPending ? null : liveText ? 'answered' : liveStep ? (liveStep === 'action' ? 'working' : 'reading') : null;
  const status: Status = isOffline
    ? 'offline'
    : voiceIn.listening
      ? 'hearing'
      : voiceOut.speaking
        ? 'speaking'
        : liveStatus
          ? liveStatus
          : ask.isPending || handoff.isPending || decide.isPending
          ? now - askedAt < READING_MS && ask.isPending
            ? 'reading'
            : 'working'
          : now - doneAt < DONE_MS
            ? 'done'
            : now - answeredAt < ANSWERED_MS
              ? 'answered'
              : handoffOpen
                ? 'handoff'
                : text || focused
                  ? 'listening'
                  : now - activeAt > COFFEE_MS
                    ? 'coffee'
                    : 'ready';
  const working = summary?.working ?? 0;
  // Idle in front of you, busy behind the scenes: say so.
  const background = working > 0 && (status === 'ready' || status === 'coffee');
  const pose = background ? 'working' : POSE_OF[status];
  const heroPose: HugoPose = status === 'ready' && now - openedAt < HELLO_MS ? 'hello' : pose;
  const statusText = background
    ? working === 1
      ? t('hugoWork.bg.one')
      : t('hugoWork.bg.many', { count: working })
    : ask.isPending && liveStep && !liveText
      ? t(`hugoPane.step.${liveStep}` as const)
      : t(`hugoPane.status.${status}` as MessageKey);
  const badge = hugoBadgeCount(summary);
  const hour = new Date(now).getHours();
  const greeting = user?.firstName
    ? t(hour < 12 ? 'hugoPane.greeting.morning' : hour < 18 ? 'hugoPane.greeting.afternoon' : 'hugoPane.greeting.evening', { name: user.firstName })
    : t('hugoPane.greeting.anon');
  const closeOnPhone = () => isPhone() && setOpen(false);
  const wake = () => setActiveAt(Date.now());

  const toggleReadAloud = (on: boolean) => {
    setReadAloud(on);
    try {
      window.localStorage.setItem(READ_ALOUD_KEY, on ? '1' : '0');
    } catch {
      /* a convenience */
    }
    readAloudSet.mutate(on);
    if (!on) voiceOut.stop();
  };

  const copy = (turn: Turn) => {
    void navigator.clipboard?.writeText(turn.text).then(() => {
      setCopiedId(turn.id);
      window.setTimeout(() => setCopiedId((c) => (c === turn.id ? null : c)), 1600);
    });
  };

  return (
    <aside
      role="complementary"
      aria-label={`${name} · ${t('hugoPane.agent')}`}
      data-testid="assistant-pane"
      data-hugo-status={status}
      className={cn(
        'fixed inset-0 z-40 flex h-[100dvh] flex-col bg-surface text-ink',
        'md:relative md:inset-auto md:z-auto md:h-auto md:w-[23rem] lg:w-[26rem] md:shrink-0 md:border-l md:border-line',
      )}
    >
      {/* Who he is and what he is doing, live. */}
      <header className="flex shrink-0 items-center gap-3 border-b border-line px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        {hugo ? (
          <HugoMascot pose={turns.length || background ? pose : 'face'} size={52} eager className="-my-1" />
        ) : (
          <span className="grid h-10 w-10 place-items-center rounded-full bg-accent-fill/15 text-accent" aria-hidden="true">
            <Sparkles className="h-5 w-5" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-base font-semibold">{name}</span>
            <span className="shrink-0 rounded-full border border-accent/40 bg-accent-fill/10 px-2 py-px text-xs font-medium text-accent">{t('hugoPane.agent')}</span>
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-ink-muted" aria-live="polite">
            <span
              className={cn(
                'h-2 w-2 shrink-0 rounded-full',
                status === 'offline' ? 'bg-negative' : status === 'coffee' && !background ? 'bg-caution' : 'bg-positive',
                ((status !== 'ready' && status !== 'coffee' && status !== 'offline') || background) && 'animate-pulse',
              )}
              aria-hidden="true"
            />
            <span className="truncate" data-testid="hugo-status">
              {statusText}
            </span>
          </div>
        </div>
        {voiceOut.speaking && (
          <Button variant="ghost" size="sm" onClick={voiceOut.stop}>
            <Square className="h-3.5 w-3.5" aria-hidden="true" />
            {t('hugoPane.stop')}
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={t('hugoPane.more')}>
              <MoreHorizontal className="h-5 w-5" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[13rem]">
            {voiceOut.supported && (
              <DropdownMenuCheckboxItem checked={readAloud} onCheckedChange={(v) => toggleReadAloud(Boolean(v))}>
                {t('hugoPane.readAloud')}
              </DropdownMenuCheckboxItem>
            )}
            <DropdownMenuItem disabled={!turns.length || startOver.isPending} onSelect={() => startOver.mutate()} data-testid="hugo-start-over">
              <RotateCcw className="h-4 w-4" aria-hidden="true" />
              {t('hugoPane.startOver')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setMemoryOpen(true)} data-testid="hugo-memory-open">
              <Bookmark className="h-4 w-4" aria-hidden="true" />
              {t('hugoPane.memory.title', { name })}
            </DropdownMenuItem>
            {/* Their own allowance for his thinking, and how long the conversation is kept — on every device. */}
            <DropdownMenuSeparator />
            <div className="w-[17rem] max-w-full">
              <HugoAllowanceMeter allowance={allowance.data} />
              <p className="flex items-start gap-1.5 px-2 py-1.5 text-xs leading-snug text-ink-muted" data-testid="hugo-thread-kept">
                <History className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                {t('hugoPane.thread.kept', { days: profile.data?.retentionDays ?? thread.data?.retentionDays ?? 90 })}
              </p>
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="ghost" size="icon-sm" onClick={() => setOpen(false)} aria-label={t('hugoPane.close', { name })}>
          <X className="h-5 w-5" aria-hidden="true" />
        </Button>
      </header>
      {/* The promise an agent has to keep, always in view. */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-line bg-surface-sunken px-4 py-1.5 text-xs text-ink-muted">
        <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-positive" aria-hidden="true" />
        <span className="truncate">{t('hugoPane.promise')}</span>
      </div>

      {/* What he says, and what he is doing for you. */}
      <Tabs value={tab} onValueChange={(v) => setTab(v === 'tasks' ? 'tasks' : 'chat')} className="flex min-h-0 flex-1 flex-col">
        <TabsList className="shrink-0 px-2" aria-label={name}>
          <TabsTrigger value="chat" className="flex-1 sm:flex-none">
            {t('hugoWork.tab.chat')}
          </TabsTrigger>
          <TabsTrigger value="tasks" className="flex-1 sm:flex-none" aria-label={badge ? t('hugoWork.tab.tasksCount', { count: badge }) : undefined} data-testid="hugo-tab-tasks">
            {t('hugoWork.tab.tasks')}
            {badge > 0 && (
              <span className="ml-1.5 inline-grid min-w-5 place-items-center rounded-full bg-accent-fill px-1 text-xs font-semibold leading-5 text-on-accent" aria-hidden="true">
                {badge > 9 ? '9+' : badge}
              </span>
            )}
          </TabsTrigger>
        </TabsList>

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
          <TabsContent value="tasks" className="pt-0">
            <HugoTasksPanel hugo={hugo} onNavigate={closeOnPhone} />
          </TabsContent>
          <TabsContent value="chat" className="pt-0" aria-live="polite">
            {turns.length === 0 && (
              <div className="space-y-5">
                <div className="flex flex-col items-center gap-2 text-center">
                  {hugo && <HugoMascot pose={heroPose} size={128} eager />}
                  <p className="font-display text-2xl text-ink">{greeting}</p>
                  <p className="max-w-[34ch] text-sm leading-relaxed text-ink-muted">{me.intro}</p>
                  <button
                    type="button"
                    onClick={() => setMemoryOpen(true)}
                    className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-ink-muted underline-offset-2 hover:text-ink hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
                    data-testid="hugo-memory-peek"
                  >
                    <Bookmark className="h-4 w-4 text-accent" aria-hidden="true" />
                    {t('hugoPane.memory.peek', { name })}
                  </button>
                </div>
                {page.record && (
                  <p className="rounded-lg border border-line bg-surface-raised px-3 py-2 text-sm text-ink-muted">
                    {t('hugoPane.onRecord', { name: page.record.name, type: page.record.type })}
                  </p>
                )}
                {me.can.length > 0 && (
                  <div>
                    <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-ink-muted">{t('hugoPane.tryAsking')}</h3>
                    <ul className="space-y-2">
                      {me.can.map((c) => {
                        const Icon = ICON_OF[c.key] ?? Sparkles;
                        return (
                          <li key={c.key}>
                            <button
                              type="button"
                              onClick={() => send(c.example)}
                              disabled={ask.isPending}
                              className="group flex min-h-12 w-full items-center gap-3 rounded-xl border border-line bg-surface-raised px-3 py-2 text-left text-sm text-ink transition-colors hover:border-accent/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright disabled:opacity-60"
                            >
                              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent-fill/15 text-accent" aria-hidden="true">
                                <Icon className="h-4 w-4" aria-hidden="true" />
                              </span>
                              <span className="min-w-0 flex-1">{c.example}</span>
                              <ArrowRight className="h-4 w-4 shrink-0 text-ink-muted transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
              </div>
            )}
            <ol className="space-y-4">
              {turns.map((turn, i) => {
                const mine = turn.role === 'user';
                const firstOfRun = !mine && turns[i - 1]?.role !== 'assistant';
                return (
                  <li key={turn.id} className={cn('flex gap-2', mine ? 'justify-end' : 'justify-start')}>
                    {!mine && (
                      <span className="w-7 shrink-0 pt-0.5" aria-hidden="true">
                        {firstOfRun && (hugo ? <HugoMascot pose="face" size={28} play="still" /> : <Sparkles className="h-5 w-5 text-accent" />)}
                      </span>
                    )}
                    <div className={cn('flex max-w-[86%] flex-col', mine ? 'items-end' : 'items-start')}>
                      <div
                        className={cn(
                          'rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed',
                          mine ? 'rounded-br-md bg-accent-fill/15 text-ink' : 'rounded-bl-md border border-line bg-surface-raised text-ink',
                        )}
                      >
                        <p className="whitespace-pre-wrap">{turn.text}</p>
                        {turn.linkUrl && (
                          <Button asChild size="sm" variant="secondary" className="mt-2 h-8">
                            <Link to={turn.linkUrl} onClick={closeOnPhone}>
                              {t('hugoPane.open')}
                              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                            </Link>
                          </Button>
                        )}
                        {(turn.tables ?? []).map((tb) => (
                          <AnswerTable key={tb.linkUrl} table={tb} onNavigate={closeOnPhone} />
                        ))}
                        {(turn.actions ?? []).map((card) => (
                          <ActionCard
                            key={card.id}
                            card={card}
                            result={turn.results?.[card.id] ?? null}
                            busy={decide.isPending && decide.variables?.card.id === card.id}
                            onDecide={(decision) => decide.mutate({ turnId: turn.id, card, decision })}
                            onNavigate={closeOnPhone}
                          />
                        ))}
                        {(turn.offers ?? []).map((offer, oi) => (
                          offer.task.kind === 'GOAL' ? (
                            <HugoGoalOfferCard key={`${offer.task.kind}-${oi}`} offer={offer} onSeeTasks={(id) => openTasks(id)} />
                          ) : (
                            <HugoTaskOfferCard key={`${offer.task.kind}-${oi}`} offer={offer} onSeeTasks={(id) => openTasks(id)} />
                          )
                        ))}
                        {turn.handoff && !turn.handoffSent && (
                          <div className="mt-2">
                            <Button size="sm" variant="outline" loading={handoff.isPending} onClick={() => handoff.mutate(turn.handoff!.summary)}>
                              {turn.handoff.who ? t('hugoPane.sendTo', { who: turn.handoff.who }) : t('hugoPane.sendToSupervisor')}
                            </Button>
                          </div>
                        )}
                      </div>
                      {!mine && (turn.remembered?.length || turn.forgot) ? (
                        <HugoMemoryChip name={name} remembered={turn.remembered} forgot={turn.forgot} onOpen={() => setMemoryOpen(true)} />
                      ) : null}
                      {!mine && (
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 pl-1 text-xs text-ink-muted">
                          {turn.intent && SOURCED.has(turn.intent) && (
                            <span className="inline-flex items-center gap-1">
                              <ShieldCheck className="h-3.5 w-3.5 text-positive" aria-hidden="true" />
                              {t(`hugoPane.source.${turn.intent}` as MessageKey)}
                            </span>
                          )}
                          {voiceOut.supported && (
                            <button type="button" className="inline-flex min-h-8 items-center gap-1 rounded px-1 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright" onClick={() => voiceOut.speak(turn.text)}>
                              <Volume2 className="h-3.5 w-3.5" aria-hidden="true" />
                              {t('hugoPane.listen')}
                            </button>
                          )}
                          <button type="button" className="inline-flex min-h-8 items-center gap-1 rounded px-1 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright" onClick={() => copy(turn)}>
                            {copiedId === turn.id ? <Check className="h-3.5 w-3.5 text-positive" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
                            {copiedId === turn.id ? t('hugoPane.copied') : t('hugoPane.copy')}
                          </button>
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
              {ask.isPending && (
                <li className="flex justify-start gap-2" data-testid="hugo-live">
                  <span className="w-7 shrink-0 pt-0.5" aria-hidden="true">
                    {liveText && (hugo ? <HugoMascot pose="face" size={28} play="still" /> : <Sparkles className="h-5 w-5 text-accent" />)}
                  </span>
                  {liveText ? (
                    // His words as he writes them; the finished answer replaces them (and is what a screen reader hears).
                    <div className="max-w-[86%] rounded-2xl rounded-bl-md border border-line bg-surface-raised px-3.5 py-2.5 text-sm leading-relaxed text-ink">
                      <span className="sr-only">{t('hugoPane.thinking', { name })}</span>
                      <p className="whitespace-pre-wrap" aria-hidden="true">
                        {liveText}
                        <span className="hugo-caret" />
                      </p>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 rounded-2xl rounded-bl-md border border-line bg-surface-raised px-3.5 py-2.5 text-sm text-ink-muted">
                      <span className="sr-only">{t('hugoPane.thinking', { name })}</span>
                      <span aria-hidden="true">{statusText}</span>
                      <span className="hugo-dots" aria-hidden="true">
                        <span />
                        <span />
                        <span />
                      </span>
                    </div>
                  )}
                </li>
              )}
            </ol>
          </TabsContent>
        </div>

        {tab === 'chat' && (
          <form
            className="shrink-0 border-t border-line px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
            onSubmit={(e) => {
              e.preventDefault();
              send(text);
            }}
          >
            <HugoAllowanceNotice allowance={allowance.data} />
            {sensitive && (
              <p role="alert" className="mb-2 flex items-start gap-1.5 rounded-lg border border-negative/40 bg-negative/10 px-3 py-2 text-sm text-ink">
                <Lock className="mt-0.5 h-4 w-4 shrink-0 text-negative" aria-hidden="true" />
                {t('hugoPane.privacy.blocked', { name })}
              </p>
            )}
            {voiceIn.error && (
              <p role="status" className="mb-2 text-sm text-ink-muted">
                {t(voiceIn.error === 'denied' ? 'hugoPane.mic.denied' : 'hugoPane.mic.noSpeech')}
              </p>
            )}
            <label htmlFor="assistant-ask" className="sr-only">
              {t('hugoPane.ask', { name })}
            </label>
            <div
              className={cn(
                'flex items-end gap-1.5 rounded-2xl border bg-surface-raised p-1.5 transition-colors',
                voiceIn.listening ? 'border-accent' : sensitive ? 'border-negative' : 'border-line focus-within:border-accent',
              )}
            >
              <Textarea
                ref={inputRef}
                id="assistant-ask"
                value={draft}
                rows={1}
                maxLength={500}
                readOnly={voiceIn.listening}
                placeholder={voiceIn.listening ? t('hugoPane.askAloud') : t('hugoPane.ask', { name })}
                className="min-h-10 max-h-40 flex-1 resize-none rounded-xl border-0 border-transparent bg-transparent px-2.5 py-2 shadow-none hover:border-transparent focus:border-transparent focus:ring-0 focus:ring-offset-0"
                onFocus={() => {
                  setFocused(true);
                  wake();
                  preloadHugo(['celebrate', 'handoff', 'coffee']);
                }}
                onBlur={() => setFocused(false)}
                onChange={(e) => {
                  setText(e.target.value);
                  wake();
                  // Grow with the words, up to the cap.
                  e.target.style.height = 'auto';
                  e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    send(text);
                  }
                }}
              />
              {voiceIn.supported && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={cn('shrink-0 rounded-xl', voiceIn.listening && 'hugo-mic-live text-accent')}
                  aria-pressed={voiceIn.listening}
                  aria-label={voiceIn.listening ? t('hugoPane.mic.stop') : t('hugoPane.mic.start')}
                  title={t('hugoPane.mic.note')}
                  onClick={() => {
                    wake();
                    voiceIn.clearError();
                    if (voiceIn.listening) voiceIn.stop();
                    else {
                      voiceOut.stop();
                      voiceIn.start();
                    }
                  }}
                  disabled={ask.isPending}
                >
                  <Mic className="h-5 w-5" aria-hidden="true" />
                </Button>
              )}
              <Button type="submit" size="icon" className="shrink-0 rounded-xl" aria-label={t('hugoPane.send')} disabled={!text.trim() || ask.isPending || sensitive || voiceIn.listening}>
                <ArrowUp className="h-5 w-5" aria-hidden="true" />
              </Button>
            </div>
            <p className="mt-2 flex items-center gap-1.5 px-1 text-xs text-ink-muted">
              <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {t('hugoPane.privacy')}
            </p>
          </form>
        )}
      </Tabs>
      {memoryOpen && (
        <Suspense fallback={null}>
          <HugoMemoryView
            name={name}
            hugo={hugo}
            onClose={() => {
              setMemoryOpen(false);
              if (!isPhone()) window.requestAnimationFrame(() => inputRef.current?.focus());
            }}
          />
        </Suspense>
      )}
    </aside>
  );
}

/**
 * One proposed action: what will happen, to whom, and the person's choice.
 * Nothing runs until they tap the first button; the result replaces the
 * buttons in place, calmly.
 */
function ActionCard({
  card,
  result,
  busy,
  onDecide,
  onNavigate,
}: {
  card: AssistantActionCard;
  result: ActionResult | null;
  busy: boolean;
  onDecide: (d: 'confirm' | 'cancel') => void;
  onNavigate: () => void;
}) {
  const { t } = useI18n();
  const expired = !result && new Date(card.expiresAt).getTime() < Date.now();
  return (
    <div className="mt-2 rounded-xl border border-line bg-surface p-3" role="group" aria-label={t('hugoPane.proposed', { title: card.title })}>
      <div className="text-sm font-medium text-ink">{card.title}</div>
      {card.detail && <div className="mt-0.5 text-xs text-ink-muted">{card.detail}</div>}
      {result ? (
        <div className={cn('mt-2 text-sm', result.status === 'failed' ? 'text-negative' : 'text-ink-muted')} role="status">
          {result.status === 'done' && <Check className="mr-1 inline h-3.5 w-3.5 align-[-2px] text-positive" aria-hidden="true" />}
          {result.message}
          {result.linkUrl && (
            <Button asChild size="sm" variant="link" className="ml-1 h-auto px-0">
              <Link to={result.linkUrl} onClick={onNavigate}>
                {t('hugoPane.open')}
              </Link>
            </Button>
          )}
        </div>
      ) : expired ? (
        <div className="mt-2 text-xs text-ink-muted">{t('hugoPane.expired')}</div>
      ) : (
        <div className="mt-2.5 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => onDecide('confirm')} loading={busy}>
            {card.confirmLabel}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onDecide('cancel')} disabled={busy}>
            {t('hugoPane.cancel')}
          </Button>
        </div>
      )}
    </div>
  );
}

/** A numbers answer: the first rows, and the report builder one tap away. */
function AnswerTable({ table, onNavigate }: { table: AssistantTable; onNavigate: () => void }) {
  const { t } = useI18n();
  const cols = table.columns.slice(0, 5);
  const rows = table.rows.slice(0, 8);
  return (
    <div className="mt-2 rounded-xl border border-line bg-surface p-3">
      <div className="text-sm font-medium text-ink">{table.title}</div>
      {rows.length === 0 ? (
        <div className="mt-1 text-xs text-ink-muted">{t('hugoPane.noRows')}</div>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">{table.title}</caption>
            <thead>
              <tr className="text-ink-muted">
                {cols.map((c) => (
                  <th key={c} scope="col" className="pb-1 pr-3 font-medium">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="text-ink">
              {rows.map((r, i) => (
                <tr key={i} className="border-t border-line/60">
                  {cols.map((c) => (
                    <td key={c} className="py-1 pr-3 tabular-nums">
                      {String(r[c] ?? '—')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Button asChild size="sm" variant="link" className="mt-1 h-auto px-0">
        <Link to={table.linkUrl} onClick={onNavigate}>
          {t('hugoPane.reportBuilder')}
        </Link>
      </Button>
    </div>
  );
}
