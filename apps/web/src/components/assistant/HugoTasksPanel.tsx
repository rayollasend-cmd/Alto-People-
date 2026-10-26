import { useEffect, useMemo, useState } from 'react';
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
import { HugoNoteCard } from './HugoNoteCard';
import { HugoTaskCard } from './HugoTaskCard';
import { hugoWorkError } from './hugoWorkText';

const NEEDS: readonly HugoTaskStatus[] = ['NEEDS_YOU'];
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
  const needsYou = list.filter((x) => NEEDS.includes(x.status));
  const running = list.filter((x) => RUNNING.includes(x.status));
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
  const card = (task: HugoTaskView) => (
    <li key={task.id}>
      <HugoTaskCard
        task={task}
        focused={task.id === focusTaskId}
        busy={busy?.id === task.id ? (busy.what as HugoTaskChoice | 'stop') : null}
        onRespond={(choice) => respond.mutate({ id: task.id, choice })}
        onStop={() => stop.mutate(task.id)}
        onNavigate={onNavigate}
      />
    </li>
  );

  return (
    <div className="space-y-5" data-testid="hugo-tasks">
      {error && (
        <p className="rounded-lg border border-negative/40 bg-negative/10 px-3 py-2 text-sm text-ink" role="alert">
          {error}
        </p>
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
      {needsYou.length > 0 && (
        <section aria-labelledby="hugo-sec-needs">
          <h3 id="hugo-sec-needs" className="mb-2 text-xs font-medium uppercase tracking-wider text-ink-muted">
            {t('hugoWork.sec.needsYou')}
          </h3>
          <ul className="space-y-2">{needsYou.map(card)}</ul>
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
      {finished.length > 0 && (
        <section aria-labelledby="hugo-sec-finished">
          <h3 id="hugo-sec-finished" className="mb-2 text-xs font-medium uppercase tracking-wider text-ink-muted">
            {t('hugoWork.sec.finished')}
          </h3>
          <ul className="space-y-2">{finished.map(card)}</ul>
        </section>
      )}
      {offerable.length > 0 && (
        <section aria-labelledby="hugo-sec-quick">
          <h3 id="hugo-sec-quick" className="mb-2 text-xs font-medium uppercase tracking-wider text-ink-muted">
            {t('hugoWork.quick.title')}
          </h3>
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
    </div>
  );
}
