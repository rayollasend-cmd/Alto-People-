import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { HugoNoteView, HugoTaskChoice, HugoTaskCreateInput, HugoTaskStatus, HugoTaskView } from '@alto-people/shared';
import { ArrowLeftRight, CalendarPlus, FileText, Plane, Users, Wallet, type LucideIcon } from '@/components/ui/icons';
import { HugoMascot } from '@/components/hugo/HugoMascot';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { useAssistant } from '@/lib/assistantContext';
import { useAuth } from '@/lib/auth';
import { acceptHugoNote, cancelHugoTask, dismissHugoNote, listHugoNotes, listHugoTasks, markHugoSeen, respondToHugoTask, startHugoTask } from '@/lib/hugoApi';
import { useI18n, type MessageKey } from '@/lib/i18n';
import '@/lib/i18n/en/hugoWork';
import { HugoGoalCard } from './HugoGoalCard';
import { HugoGoalStart } from './HugoGoalStart';
import { HugoNoteCard } from './HugoNoteCard';
import { HugoTaskCard } from './HugoTaskCard';
import { History, Repeat } from '@/components/ui/icons';
import { HugoUpcoming } from './HugoUpcoming';
import { HugoUpcomingForm, repeatableWhats } from './HugoUpcomingForm';
import { waitingOrder } from './hugoQueue';
import { hugoWorkError } from './hugoWorkText';

const NEEDS: readonly HugoTaskStatus[] = ['NEEDS_YOU'];
/** "See everything Hugo did": its own chunk, fetched when opened. */
const HugoActivity = lazy(() => import('./HugoActivity'));
const RUNNING: readonly HugoTaskStatus[] = ['WORKING', 'WAITING'];
/** The "New" dots stay a moment before the look counts as seen. */
const SEEN_AFTER_MS = 1500;

interface Quick {
  key: string;
  label: MessageKey;
  icon: LucideIcon;
  /** Start straight away, or ask in the chat (a cover needs the shift). */
  task?: HugoTaskCreateInput;
  ask?: MessageKey;
}

/**
 * The Tasks tab: what Hugo noticed, what needs the person, what he is
 * working on, and what finished in the last two weeks — and a few things
 * to hand him. Every refresh comes from the server (a live nudge refetches
 * it); looking at the tab is what clears the badge.
 */
export function HugoTasksPanel({ hugo, onNavigate }: { hugo: boolean; onNavigate: () => void }) {
  const { t } = useI18n();
  const { user, can } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { ask, focusTaskId, clearFocus, openTasks } = useAssistant();
  const assistant = useAssistant();
  // Waiting for you / Upcoming / the activity log (Muse phase 5).
  const { focusSection, clearFocusSection } = assistant;
  const [view, setView] = useState<'list' | 'activity'>('list');
  const [repeating, setRepeating] = useState(false);
  const waitingRef = useRef<HTMLElement>(null);
  const tasks = useQuery({ queryKey: ['hugo', 'tasks'], queryFn: listHugoTasks, refetchInterval: 60_000 });
  const notes = useQuery({ queryKey: ['hugo', 'notes'], queryFn: listHugoNotes, refetchInterval: 120_000 });
  const [busy, setBusy] = useState<{ id: string; what: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['hugo', 'tasks'] });
    void queryClient.invalidateQueries({ queryKey: ['hugo', 'notes'] });
    void queryClient.invalidateQueries({ queryKey: ['hugo', 'summary'] });
  };
  const fail = (err: unknown) => setError(hugoWorkError(err, t));

  const respond = useMutation({
    mutationFn: ({ id, choice }: { id: string; choice: HugoTaskChoice }) => respondToHugoTask(id, choice),
    onMutate: ({ id, choice }) => {
      setError(null);
      setBusy({ id, what: choice });
    },
    onSuccess: refresh,
    onError: fail,
    onSettled: () => setBusy(null),
  });
  const stop = useMutation({
    mutationFn: (id: string) => cancelHugoTask(id),
    onMutate: (id) => {
      setError(null);
      setBusy({ id, what: 'stop' });
    },
    onSuccess: refresh,
    onError: fail,
    onSettled: () => setBusy(null),
  });
  const accept = useMutation({
    mutationFn: (note: HugoNoteView) => acceptHugoNote(note.id),
    onMutate: (note) => {
      setError(null);
      setBusy({ id: note.id, what: 'accept' });
    },
    onSuccess: (r) => {
      refresh();
      if (r.task) openTasks(r.task.id);
      else if (r.url) {
        onNavigate();
        navigate(r.url);
      }
    },
    onError: fail,
    onSettled: () => setBusy(null),
  });
  const dismiss = useMutation({
    mutationFn: (note: HugoNoteView) => dismissHugoNote(note.id),
    onMutate: (note) => {
      setError(null);
      setBusy({ id: note.id, what: 'dismiss' });
    },
    onSuccess: refresh,
    onError: fail,
    onSettled: () => setBusy(null),
  });
  const quickStart = useMutation({
    mutationFn: (task: HugoTaskCreateInput) => startHugoTask(task, 'panel'),
    onMutate: () => setError(null),
    onSuccess: (r) => {
      refresh();
      openTasks(r.task.id);
    },
    onError: fail,
  });

  const list = useMemo(() => tasks.data?.tasks ?? [], [tasks.data]);
  const noteList = useMemo(() => notes.data?.notes ?? [], [notes.data]);
  // Waiting for you: every kind that waits on the person, the most urgent first (hugoQueue).
  const needsYou = list.filter((x) => NEEDS.includes(x.status)).sort(waitingOrder);
  // A recurring brief between runs is Upcoming, not "working on it".
  const upcoming = list.filter((x) => x.kind === 'RECURRING' && RUNNING.includes(x.status));
  const running = list.filter((x) => RUNNING.includes(x.status) && x.kind !== 'RECURRING');
  const finished = list.filter((x) => !NEEDS.includes(x.status) && !RUNNING.includes(x.status));

  // Looking is what clears the badge — after a moment, so the "New" dots are seen first.
  const unseen = useMemo(
    () => ({ tasks: list.filter((x) => !x.seen).map((x) => x.id), notes: noteList.filter((n) => n.status === 'NEW').map((n) => n.id) }),
    [list, noteList],
  );
  const unseenKey = `${unseen.tasks.join(',')}|${unseen.notes.join(',')}`;
  useEffect(() => {
    if (!unseen.tasks.length && !unseen.notes.length) return;
    const id = window.setTimeout(() => {
      void markHugoSeen(unseen).then(() => void queryClient.invalidateQueries({ queryKey: ['hugo', 'summary'] }));
    }, SEEN_AFTER_MS);
    return () => window.clearTimeout(id);
    // The ids, not the arrays' identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unseenKey]);

  // A link or a Start card asked for one task: open it up once it is in the list.
  useEffect(() => {
    if (!focusTaskId || !list.some((x) => x.id === focusTaskId)) return;
    const id = window.setTimeout(clearFocus, 4000);
    return () => window.clearTimeout(id);
  }, [focusTaskId, list, clearFocus]);

  // The home's "I need a quick answer" line and the badge: straight to Waiting for you.
  useEffect(() => {
    if (focusSection !== 'waiting' || tasks.isLoading) return;
    setView('list');
    const id = window.setTimeout(() => {
      waitingRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
      waitingRef.current?.focus?.({ preventScroll: true });
      clearFocusSection();
    }, 0);
    return () => window.clearTimeout(id);
  }, [focusSection, tasks.isLoading, clearFocusSection]);

  const quick: Quick[] = [
    ...(user?.associateId
      ? ([
          { key: 'cover', label: 'hugoWork.quick.cover', icon: ArrowLeftRight, ask: 'hugoWork.quick.coverAsk' },
          { key: 'paycheck', label: 'hugoWork.quick.paycheck', icon: Wallet, task: { kind: 'WATCH_PAYCHECK' } },
          { key: 'openShifts', label: 'hugoWork.quick.openShifts', icon: CalendarPlus, task: { kind: 'WATCH_OPEN_SHIFTS', days: 7 } },
          { key: 'timeOff', label: 'hugoWork.quick.timeOff', icon: Plane, task: { kind: 'WATCH_TIME_OFF' } },
          { key: 'document', label: 'hugoWork.quick.document', icon: FileText, task: { kind: 'WATCH_DOCUMENT' } },
        ] satisfies Quick[])
      : []),
    ...(can('manage:scheduling') && user?.role !== 'CLIENT_PORTAL'
      ? ([{ key: 'chase', label: 'hugoWork.quick.chase', icon: Users, task: { kind: 'CHASE_CONFIRMATIONS' } }] satisfies Quick[])
      : []),
  ];
  // Don't offer what is already running.
  const runningKinds = new Set([...running, ...needsYou].map((x) => x.kind));
  const offerable = quick.filter((q) => !q.task || q.task.kind === 'WATCH_TIME_OFF' || q.task.kind === 'WATCH_DOCUMENT' || !runningKinds.has(q.task.kind));

  if (tasks.isLoading || notes.isLoading) {
    return (
      <div className="space-y-3" aria-busy="true">
        <Skeleton className="h-20 w-full rounded-xl" />
        <Skeleton className="h-20 w-full rounded-xl" />
      </div>
    );
  }
  if (tasks.isError) {
    return (
      <div className="space-y-3 text-center" role="alert">
        <p className="text-sm text-ink-muted">{t('hugoWork.loadFailed')}</p>
        <Button size="sm" variant="outline" onClick={() => void tasks.refetch()}>
          {t('hugoWork.retry')}
        </Button>
      </div>
    );
  }

  const empty = !list.length && !noteList.length;
  // A goal (Muse phase 3) has its own card: the plan, the proposal to approve, the result in place.
  const TaskCard = (task: HugoTaskView) => (task.kind === 'GOAL' ? HugoGoalCard : HugoTaskCard);
  // Goals need the model: offered only while it is on (GET /hugo says).
  const goalsOn = assistant.me?.model === true;
  const card = (task: HugoTaskView) => {
    const Card = TaskCard(task);
    return (
      <li key={task.id}>
        <Card
          task={task}
          focused={task.id === focusTaskId}
          busy={busy?.id === task.id ? (busy.what as HugoTaskChoice | 'stop') : null}
          onRespond={(choice) => respond.mutate({ id: task.id, choice })}
          onStop={() => stop.mutate(task.id)}
          onNavigate={onNavigate}
        />
      </li>
    );
  };

  const whats = repeatableWhats(assistant.me, Boolean(user?.associateId));
  if (view === 'activity') {
    return (
      <Suspense fallback={<Skeleton className="h-20 w-full rounded-xl" />}>
        <HugoActivity name={assistant.me?.name ?? 'Hugo'} onBack={() => setView('list')} onNavigate={onNavigate} />
      </Suspense>
    );
  }

  return (
    <div className="space-y-5" data-testid="hugo-tasks">
      {error && (
        <p className="rounded-lg border border-negative/40 bg-negative/10 px-3 py-2 text-sm text-ink" role="alert">
          {error}
        </p>
      )}
      {needsYou.length > 0 && (
        <section ref={waitingRef} tabIndex={-1} aria-labelledby="hugo-sec-needs" data-testid="hugo-sec-waiting" className="scroll-mt-2 focus:outline-none">
          <h3 id="hugo-sec-needs" className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-ink-muted">
            <span>{t('hugoWork.sec.waiting')}</span>
            <span className="inline-grid min-w-5 place-items-center rounded-full bg-accent-fill px-1.5 text-[11px] font-semibold leading-5 text-on-accent" aria-label={t('hugoWork.sec.waitingCount', { count: needsYou.length })}>
              {needsYou.length}
            </span>
          </h3>
          <ul className="space-y-2">{needsYou.map(card)}</ul>
        </section>
      )}
      {empty && (
        <div className="flex flex-col items-center gap-2 pt-2 text-center">
          {hugo && <HugoMascot pose="working" size={112} />}
          <p className="font-display text-2xl text-ink">{t('hugoWork.empty.title')}</p>
          <p className="max-w-[34ch] text-sm leading-relaxed text-ink-muted">{t('hugoWork.empty.body')}</p>
        </div>
      )}
      {noteList.length > 0 && (
        <section aria-labelledby="hugo-sec-noticed">
          <h3 id="hugo-sec-noticed" className="mb-2 text-xs font-medium uppercase tracking-wider text-ink-muted">
            {t('hugoWork.sec.noticed')}
          </h3>
          <ul className="space-y-2">
            {noteList.map((n) => (
              <li key={n.id}>
                <HugoNoteCard
                  note={n}
                  busy={busy?.id === n.id ? (busy.what as 'accept' | 'dismiss') : null}
                  onAccept={() => accept.mutate(n)}
                  onDismiss={() => dismiss.mutate(n)}
                />
              </li>
            ))}
          </ul>
        </section>
      )}
      {running.length > 0 && (
        <section aria-labelledby="hugo-sec-working">
          <h3 id="hugo-sec-working" className="mb-2 text-xs font-medium uppercase tracking-wider text-ink-muted">
            {t('hugoWork.sec.working')}
          </h3>
          <ul className="space-y-2">{running.map(card)}</ul>
        </section>
      )}
      <HugoUpcoming tasks={upcoming} focusTaskId={focusTaskId} onChanged={refresh} onError={fail} />
      {finished.length > 0 && (
        <section aria-labelledby="hugo-sec-finished">
          <h3 id="hugo-sec-finished" className="mb-2 text-xs font-medium uppercase tracking-wider text-ink-muted">
            {t('hugoWork.sec.finished')}
          </h3>
          <ul className="space-y-2">{finished.map(card)}</ul>
        </section>
      )}
      {(offerable.length > 0 || goalsOn) && (
        <section aria-labelledby="hugo-sec-quick">
          <h3 id="hugo-sec-quick" className="mb-2 text-xs font-medium uppercase tracking-wider text-ink-muted">
            {t('hugoWork.quick.title')}
          </h3>
          {goalsOn && (
            <div className="mb-2">
              <HugoGoalStart name={assistant.me?.name ?? 'Hugo'} onStarted={(id) => openTasks(id)} />
            </div>
          )}
          <ul className="space-y-2">
            {offerable.map((q) => {
              const Icon = q.icon;
              return (
                <li key={q.key}>
                  <button
                    type="button"
                    disabled={quickStart.isPending}
                    onClick={() => (q.task ? quickStart.mutate(q.task) : q.ask && ask(t(q.ask)))}
                    className="group flex min-h-12 w-full items-center gap-3 rounded-xl border border-line bg-surface-raised px-3 py-2 text-left text-sm text-ink transition-colors hover:border-accent/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright disabled:opacity-60"
                  >
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent-fill/15 text-accent" aria-hidden="true">
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">{t(q.label)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {whats.length > 0 && (
        <section aria-label={t('hugoWork.repeat.title')} data-testid="hugo-repeat">
          {repeating ? (
            <HugoUpcomingForm
              whats={whats}
              onStarted={(task) => {
                setRepeating(false);
                refresh();
                openTasks(task.id);
              }}
              onCancel={() => setRepeating(false)}
              onError={fail}
            />
          ) : (
            <button
              type="button"
              onClick={() => setRepeating(true)}
              className="group flex min-h-12 w-full items-center gap-3 rounded-xl border border-line bg-surface-raised px-3 py-2 text-left text-sm text-ink transition-colors hover:border-accent/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
            >
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent-fill/15 text-accent" aria-hidden="true">
                <Repeat className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1">{t('hugoWork.quick.repeat')}</span>
            </button>
          )}
        </section>
      )}
      <div className="border-t border-line pt-3 text-center">
        <Button size="sm" variant="ghost" className="h-9" onClick={() => setView('activity')} data-testid="hugo-activity-open">
          <History className="h-4 w-4" aria-hidden="true" />
          {t('hugoWork.activity.open', { name: assistant.me?.name ?? 'Hugo' })}
        </Button>
      </div>
    </div>
  );
}
