import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Sparkles } from '@/components/ui/icons';
import { ApiError } from '@/lib/api';
import { askHugo, getHugo, type HugoAnswer } from '@/lib/hugoApi';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { useAssistant } from '@/lib/assistantContext';
import { useAuth } from '@/lib/auth';

/**
 * Hugo's seat on a home (design system §4.1): the same place on every
 * role's first screen — a full-width bar after "Needs you" (it used to own
 * the right third of the page, which stayed empty below him). He offers
 * only what is switched on for this organization and this person (the
 * server's registry), takes a question, and answers in place. Switched
 * off, or nothing to offer: renders nothing, so the home never shows an
 * empty assistant.
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
          <div className="flex min-w-0 items-center gap-2 lg:w-80 lg:shrink-0">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent-fill/15 text-accent" aria-hidden="true">
              <Sparkles className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className="text-base font-medium text-ink">{me.data.name}</div>
              {/* Two lines, then the rest on hover — it was cut mid-word ("I'm not a p…"). */}
              <div className="line-clamp-2 text-xs2 text-ink-muted" title={me.data.intro}>
                {me.data.intro}
              </div>
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
