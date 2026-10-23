import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { CheckCircle2 } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { answerNps, getNpsInvite } from '@/lib/npsApi';
import { cn } from '@/lib/cn';
import { Logo } from '@/components/Logo';
import { Button } from '@/components/ui/Button';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Textarea } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import { LinkProblem } from '@/components/LinkProblem';

/**
 * A store manager's answer to the quarter's one question. Reached from the
 * email's signed link; no login and no portal chrome, so the portal itself
 * stays exactly as it is. The answer can be changed while the wave is open.
 */

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-surface text-ink">
      <div className="mx-auto max-w-lg px-4 py-10 md:px-6 md:py-14">
        <div className="mb-8 flex items-center justify-center">
          <Logo size="lg" alt="Company logo" />
        </div>
        {children}
      </div>
    </div>
  );
}

export function NpsSurveyPage() {
  const { token = '' } = useParams();
  const q = useQuery({
    queryKey: ['nps', token],
    queryFn: () => getNpsInvite(token),
    retry: (n, err) => !(err instanceof ApiError && err.status === 404) && n < 2,
  });
  const invite = q.data ?? null;
  const gone = q.error instanceof ApiError && q.error.status === 404;
  const loadError = q.error && !gone ? (q.error instanceof ApiError ? q.error.message : 'Could not load the survey.') : null;
  const [score, setScore] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [done, setDone] = useState(false);
  const answer = useMutation({
    mutationFn: () => answerNps(token, { score: score!, comment: comment.trim() || null }),
    onSuccess: () => setDone(true),
  });

  useEffect(() => {
    if (invite && score === null && invite.score !== null) setScore(invite.score);
  }, [invite, score]);
  useEffect(() => {
    document.title = invite ? `One question — ${invite.orgName}` : 'One question';
  }, [invite]);

  return (
    <Shell>
      {gone ? (
        // Survey links don't expire (a closed survey says so below); a 404 is a link we never sent.
        <LinkProblem kind="invalid" title="This link isn’t valid" reason="It may have been cut off when it was copied. Open the latest survey email from us for the right link." />
      ) : loadError ? (
        <ErrorBanner>{loadError}</ErrorBanner>
      ) : !invite ? (
        <Skeleton className="h-64" />
      ) : done ? (
        <div role="status" className="rounded-xl border border-success/40 bg-success/10 p-6">
          <div className="flex items-center gap-2 text-lg font-medium">
            <CheckCircle2 className="h-5 w-5 text-success" aria-hidden="true" />
            Thank you
          </div>
          <p className="mt-2 text-sm text-ink-muted">Your answer goes straight to {invite.orgName}&rsquo;s leadership. You can change it from this link until the survey closes.</p>
        </div>
      ) : invite.closed ? (
        <div role="status" className="rounded-xl border border-line bg-surface-raised p-6">
          <div className="text-lg font-medium">This quarter&rsquo;s survey has closed</div>
          <p className="mt-2 text-sm text-ink-muted">Thank you for your time. The next one arrives at the start of the quarter.</p>
        </div>
      ) : (
        <form
          className="rounded-xl border border-line bg-surface-raised p-5 md:p-6"
          onSubmit={(e) => {
            e.preventDefault();
            if (score !== null) answer.mutate();
          }}
        >
          <div className="text-xs uppercase tracking-[0.18em] text-ink-muted">
            {invite.clientName} · {invite.quarter}
          </div>
          <div className="mt-2 font-display text-2xl">
            <h1>How likely are you to recommend {invite.orgName} to another store?</h1>
          </div>
          <div role="radiogroup" aria-label="Score from 0, not at all likely, to 10, extremely likely" className="mt-5 grid grid-cols-11 gap-1">
            {Array.from({ length: 11 }, (_, n) => (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={score === n}
                aria-label={String(n)}
                onClick={() => setScore(n)}
                className={cn(
                  'h-11 rounded-md border text-sm font-medium tabular-nums transition-colors',
                  score === n ? 'border-accent bg-accent-fill text-accent-on' : 'border-line bg-surface hover:border-accent/60',
                )}
              >
                {n}
              </button>
            ))}
          </div>
          <div className="mt-1.5 flex justify-between text-2xs text-ink-muted">
            <span>Not at all likely</span>
            <span>Extremely likely</span>
          </div>
          <label className="mt-5 block text-sm">
            <span className="text-ink-muted">What is the one thing we could do better? (optional)</span>
            <Textarea className="mt-1.5" rows={3} maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} />
          </label>
          {answer.isError && <ErrorBanner className="mt-3">{answer.error instanceof ApiError ? answer.error.message : 'Your answer did not go through. Try again.'}</ErrorBanner>}
          <Button type="submit" className="mt-5 w-full sm:w-auto" loading={answer.isPending} disabled={score === null || answer.isPending}>
            {invite.answered ? 'Update my answer' : 'Send my answer'}
          </Button>
        </form>
      )}
    </Shell>
  );
}
