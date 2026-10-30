import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import type { HugoNoteView } from '@alto-people/shared';
import { ArrowRight, Sparkles } from '@/components/ui/icons';
import { HugoMascot, isHugo } from '@/components/hugo/HugoMascot';
import { HugoNoteCard } from '@/components/assistant/HugoNoteCard';
import { ApiError } from '@/lib/api';
import { acceptHugoNote, askHugo, dismissHugoNote, getHugo, listHugoNotes, type HugoAnswer } from '@/lib/hugoApi';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { useAssistant } from '@/lib/assistantContext';
import { useAuth } from '@/lib/auth';
import { MOOD_POSE, useHugoMood, type HugoMood } from '@/components/assistant/hugoMood';
import { cn } from '@/lib/cn';
import '@/lib/i18n/en/hugoSeat';
import '@/lib/i18n/en/hugoPane';
import '@/lib/i18n/en/hugoWork';

/**
 * Hugo's seat on a home (design system §4.1): the same place on every
 * role's first screen — a full-width bar right after "Needs you" (it used
 * to own the right third of the page, which stayed empty below him, then
 * sat at the bottom where nobody scrolled to him). He is drawn big and
 * doing what he is doing — at his laptop in headphones while a task runs,
 * pointing when one needs you, on a coffee break or reading when nothing
 * does — with a line that says it in plain words (hugoMood). He offers
 * only what is switched on for this organization and this person (the
 * server's registry), takes a question, and answers in place. Switched
 * off, or nothing to offer: renders nothing, so the home never shows an
 * empty assistant. Under it, what he noticed for this person and what of
 * his work needs them (HugoSeatWork) — the first place they look.
 */
/** Roles the assistant has nothing for (the API answers 403): don't ask on every page. */
const NO_ASSISTANT_ROLES: ReadonlySet<string> = new Set(['CLIENT_PORTAL']);
/**
 * Starters for a staff role, offered only when a model answers (it knows
 * the page and has the records as tools). The rules-only registry can't
 * answer these, so without a model the seat offers the registry's own.
 */
const ROLE_PROMPTS: Partial<Record<string, string[]>> = {
  MARKETING_MANAGER: ['Which source brought the most hires this quarter?', 'Where does the careers funnel lose people?'],
  FINANCE_ACCOUNTANT: ['What is blocking the next payroll?', 'Which clients are late paying?'],
  INTERNAL_RECRUITER: ['Which postings have no applicants this week?', 'Who is waiting on an interview?'],
  WORKFORCE_MANAGER: ['Where are we short this week?', 'Who called out today?'],
  TRANSPORTATION_DIRECTOR: ['Which riders haven’t signed their fare authorization?', 'Which vans are due for service?'],
  HR_ADMINISTRATOR: ['What compliance deadlines are coming up?', 'Who is stuck in onboarding?'],
  OPERATIONS_MANAGER: ['Which stores are short today?', 'What is waiting on me?'],
  MANAGER: ['Who on my team is heading into overtime?', 'What is waiting on me?'],
};

/** The role, or null where no session is around (a home rendered alone in a test). */
function useRoleIfSignedIn(): string | null {
  try {
    return useAuth().user?.role ?? null;
  } catch {
    return null;
  }
}

export function HugoSeat({ className, prompts }: { className?: string; /** Page-specific starters, used when a model answers. */ prompts?: string[] }) {
  const { t } = useI18n();
  const role = useRoleIfSignedIn();
  // Inside the app the seat is a way into the one pane; the question is
  // asked there, where the thread lives. Outside the provider (a test
  // rendering a home alone) it answers in place, as it first did.
  const assistant = useAssistant();
  const mood = useHugoMood();
  const me = useQuery({
    queryKey: ['hugo', 'me'],
    queryFn: getHugo,
    staleTime: 60_000,
    retry: false,
    // A refusal is an answer: don't ask again on every home visit.
    retryOnMount: false,
    enabled: !role || !NO_ASSISTANT_ROLES.has(role),
  });
  const [text, setText] = useState('');
  const [turn, setTurn] = useState<{ question: string; answer: HugoAnswer } | null>(null);
  const ask = useMutation({
    mutationFn: (q: string) => askHugo(q),
    onSuccess: (answer, question) => {
      setTurn({ question, answer });
      setText('');
    },
  });
  // A thin answer (an older API, a generic test mock) is "nothing to offer".
  if (me.isLoading || me.error || !me.data?.can?.length) return null;
  // What the chips offer: this page's (or this role's) questions when a model
  // can answer them; otherwise the registry's. A desk is never offered the
  // associate's "how many sick days" — policy questions still work typed.
  const roleStarters = (prompts?.length ? prompts : role ? ROLE_PROMPTS[role] : undefined) ?? [];
  const registry = me.data.audience === 'associate' || me.data.can.length <= 1 ? me.data.can : me.data.can.filter((c) => c.key !== 'HELP_CENTER');
  const chips: Array<{ key: string; example: string }> =
    me.data.model && roleStarters.length
      ? [...roleStarters.map((q, i) => ({ key: `page-${i}`, example: q })), ...registry.filter((c) => c.key === 'DESK')].slice(0, 3)
      : (registry.length ? registry : me.data.can).slice(0, 3);
  const send = (q: string) => {
    const question = q.trim();
    if (!question || ask.isPending) return;
    if (assistant.mounted && assistant.available) {
      assistant.ask(question);
      setText('');
      return;
    }
    ask.mutate(question);
  };
  return (
    <Card className={className} data-testid="hugo-seat">
      <CardContent className="space-y-3 p-[var(--d-card)]">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:gap-6">
          <div className="flex min-w-0 items-center gap-3 lg:w-80 lg:shrink-0">
            {isHugo(me.data.name) ? (
              <HugoMascot pose={MOOD_POSE[mood]} size={88} play={mood === 'done' ? 3 : 'loop'} className="-my-2" />
            ) : (
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent-fill/15 text-accent" aria-hidden="true">
                <Sparkles className="h-4 w-4" />
              </span>
            )}
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="text-lg font-semibold text-ink">{me.data.name}</span>
                {isHugo(me.data.name) && <span className="rounded-full border border-accent/40 bg-accent-fill/10 px-2 py-px text-xs font-medium text-accent">{t('hugoSeat.tagline')}</span>}
              </div>
              {/* What he is up to, written for the card; his full introduction is in the panel. */}
              {isHugo(me.data.name) ? <HugoMoodLine mood={mood} /> : <div className="text-xs2 text-ink-muted">{me.data.intro}</div>}
            </div>
          </div>
          <form
            className="flex min-w-0 flex-1 gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              send(text);
            }}
          >
            <label htmlFor="hugo-seat-ask" className="sr-only">
              {t('hugoSeat.askName', { name: me.data.name })}
            </label>
            <Input id="hugo-seat-ask" className="min-w-0 flex-1" value={text} maxLength={500} onChange={(e) => setText(e.target.value)} placeholder={t('hugoSeat.askName', { name: me.data.name })} />
            <Button type="submit" size="sm" className="h-10 shrink-0" loading={ask.isPending} disabled={!text.trim() || ask.isPending}>
              {t('hugoSeat.ask')}
            </Button>
          </form>
        </div>
        {chips.length > 0 && (
          <div className="flex flex-wrap gap-2 lg:pl-[21.5rem]">
            {chips.map((c) => (
              <Button key={c.key} size="sm" variant="secondary" className="h-auto min-h-8 whitespace-normal py-1.5 text-left" onClick={() => send(c.example)} disabled={ask.isPending}>
                {c.example}
              </Button>
            ))}
          </div>
        )}
        {assistant.mounted && assistant.available && <HugoSeatWork name={me.data.name} />}
        {ask.error && <p className="text-sm text-negative">{ask.error instanceof ApiError ? ask.error.message : t('hugoSeat.failed')}</p>}
        {turn && (
          <div className="rounded-md border border-line bg-surface-raised/40 p-3 text-sm" aria-live="polite">
            <div className="text-xs2 text-ink-muted">{turn.question}</div>
            <div className="mt-1 whitespace-pre-wrap text-ink">{turn.answer.reply}</div>
            {turn.answer.linkUrl && (
              <Button asChild size="sm" variant="link" className="mt-1 px-0">
                <Link to={turn.answer.linkUrl}>{t('hugoSeat.open')}</Link>
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** The seat's status line: a dot and his mood in plain words. */
function HugoMoodLine({ mood }: { mood: HugoMood }) {
  const { t } = useI18n();
  const { summary, live } = useAssistant();
  const working = summary?.working ?? 0;
  const line =
    mood === 'answering'
      ? t(`hugoPane.step.${live?.step ?? 'records'}` as const)
      : mood === 'working'
        ? working > 1
          ? t('hugoSeat.mood.workingMany', { count: working })
          : t('hugoSeat.mood.working')
        : t(`hugoSeat.mood.${mood}` as const);
  return (
    <div className="mt-0.5 flex items-center gap-1.5 text-sm text-ink-muted" data-testid="hugo-mood" data-mood={mood}>
      <span
        className={cn(
          'h-2 w-2 shrink-0 rounded-full',
          mood === 'needsYou' ? 'bg-accent-fill' : mood === 'coffee' || mood === 'reading' ? 'bg-caution' : 'bg-positive',
          (mood === 'working' || mood === 'answering') && 'animate-pulse',
        )}
        aria-hidden="true"
      />
      <span>{line}</span>
    </div>
  );
}

/**
 * What Hugo has for the person, on their home: the two newest things he
 * noticed (each one tap to act on, or put away), and the tasks waiting on
 * them — one tap opens the Tasks tab. Nothing to show: nothing rendered.
 */
function HugoSeatWork({ name }: { name: string }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { summary, openTasks } = useAssistant();
  const notes = useQuery({ queryKey: ['hugo', 'notes'], queryFn: listHugoNotes, staleTime: 30_000, retry: false });
  const [busy, setBusy] = useState<{ id: string; what: 'accept' | 'dismiss' } | null>(null);
  const done = () => {
    setBusy(null);
    void queryClient.invalidateQueries({ queryKey: ['hugo'], predicate: (q) => q.queryKey[1] !== 'me' });
  };
  const accept = useMutation({
    mutationFn: (n: HugoNoteView) => acceptHugoNote(n.id),
    onMutate: (n) => setBusy({ id: n.id, what: 'accept' }),
    onSuccess: (r) => {
      if (r.task) openTasks(r.task.id);
      else if (r.url) navigate(r.url);
    },
    onSettled: done,
  });
  const dismiss = useMutation({
    mutationFn: (n: HugoNoteView) => dismissHugoNote(n.id),
    onMutate: (n) => setBusy({ id: n.id, what: 'dismiss' }),
    onSettled: done,
  });
  const shown = (notes.data?.notes ?? []).slice(0, 2);
  const needsYou = summary?.needsYou ?? 0;
  const working = summary?.working ?? 0;
  if (!shown.length && !needsYou && !working) return null;
  return (
    <div className="space-y-2 lg:pl-[21.5rem]" data-testid="hugo-seat-work">
      {shown.length > 0 && (
        <>
          <h3 className="text-xs font-medium uppercase tracking-wider text-ink-muted">{t('hugoWork.seat.noticed', { name })}</h3>
          <ul className="grid gap-2 md:grid-cols-2">
            {shown.map((n) => (
              <li key={n.id}>
                <HugoNoteCard note={n} compact busy={busy?.id === n.id ? busy.what : null} onAccept={() => accept.mutate(n)} onDismiss={() => dismiss.mutate(n)} />
              </li>
            ))}
          </ul>
        </>
      )}
      {(needsYou > 0 || working > 0) && (
        <button
          type="button"
          onClick={() => openTasks()}
          className="group flex min-h-11 w-full items-center gap-2 rounded-xl border border-line bg-surface-raised px-3 py-2 text-left text-sm text-ink transition-colors hover:border-accent/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
        >
          <span className="min-w-0 flex-1">
            {needsYou > 0 ? (needsYou === 1 ? t('hugoWork.seat.needsOne') : t('hugoWork.seat.needsMany', { count: needsYou })) : working === 1 ? t('hugoWork.seat.workingOne', { name }) : t('hugoWork.seat.workingMany', { name, count: working })}
          </span>
          <span className="text-xs text-accent">{t('hugoWork.seat.open')}</span>
          <ArrowRight className="h-4 w-4 shrink-0 text-ink-muted transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
