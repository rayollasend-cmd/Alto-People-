import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, CalendarClock, CheckCircle2, FileSignature, Hourglass, Star, UserSearch } from 'lucide-react';
import type { CandidateStage } from '@alto-people/shared';
import { getRecruitingSummary } from '@/lib/recruitingApi';
import { ApiError } from '@/lib/api';
import { fmtTime } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Card, CardContent } from '@/components/ui/Card';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * The recruiter's part of the dashboard.
 *
 * The page promised a recruiter "Recruiting pipeline and open onboarding
 * applications" and showed no recruiting at all — "All systems nominal"
 * with candidates going cold in the funnel. This is the pipeline at a
 * glance and, above all, what is waiting on them: people stuck in one
 * stage, today's interviews, interviews with no score, offers with no
 * answer.
 */

const STAGES: Array<{ stage: CandidateStage; label: string }> = [
  { stage: 'APPLIED', label: 'Applied' },
  { stage: 'SCREENING', label: 'Screening' },
  { stage: 'INTERVIEW', label: 'Interview' },
  { stage: 'OFFER', label: 'Offer' },
];

const STAGE_LABEL: Partial<Record<CandidateStage, string>> = Object.fromEntries(
  STAGES.map((s) => [s.stage, s.label]),
);

function Heading() {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-xs uppercase tracking-[0.18em] text-silver/80 flex items-center gap-2">
        <UserSearch className="h-3.5 w-3.5" aria-hidden="true" />
        Recruiting
      </h2>
      <Link to="/recruiting" className="inline-flex items-center gap-1 text-sm text-gold hover:text-gold-bright">
        Open pipeline
        <ArrowRight className="h-3.5 w-3.5" />
      </Link>
    </div>
  );
}

/** One thing waiting on the recruiter. */
function Waiting({
  icon: Icon,
  tone,
  title,
  to,
  children,
}: {
  icon: typeof Hourglass;
  tone: 'attention' | 'normal';
  title: string;
  to: string;
  children?: React.ReactNode;
}) {
  return (
    <Card className={cn(tone === 'attention' ? 'border-warning/30' : undefined)}>
      <CardContent className="pt-5 space-y-2">
        <Link
          to={to}
          className="group flex items-start gap-3 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
        >
          <span
            className={cn(
              'h-9 w-9 shrink-0 rounded-lg grid place-items-center',
              tone === 'attention' ? 'bg-warning/15 text-warning' : 'bg-gold/10 text-gold',
            )}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
          </span>
          <span className="min-w-0 pt-1.5 text-white font-medium leading-snug group-hover:text-gold-bright">
            {title}
          </span>
        </Link>
        {children}
      </CardContent>
    </Card>
  );
}

export function RecruitingPulse() {
  const q = useQuery({
    queryKey: ['recruiting', 'summary'],
    queryFn: getRecruitingSummary,
    staleTime: 60_000,
  });

  if (q.isError) {
    return (
      <section aria-label="Recruiting" className="space-y-3">
        <Heading />
        <ErrorBanner>
          {q.error instanceof ApiError ? q.error.message : 'Could not load recruiting.'}{' '}
          <Button size="sm" variant="ghost" onClick={() => void q.refetch()}>
            Retry
          </Button>
        </ErrorBanner>
      </section>
    );
  }

  const s = q.data;
  if (!s) {
    return (
      <section aria-label="Recruiting" className="space-y-3">
        <Heading />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {STAGES.map((st) => (
            <Card key={st.stage}>
              <CardContent className="pt-5">
                <Skeleton className="h-3 w-16 mb-3" />
                <Skeleton className="h-7 w-10" />
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
    );
  }

  const nothingWaiting =
    s.stuckCount === 0 &&
    s.interviewsToday.length === 0 &&
    s.unscoredInterviews === 0 &&
    s.offersAwaitingReply === 0;

  return (
    <section aria-label="Recruiting" className="space-y-3">
      <Heading />

      {/* The funnel, each stage a way into that stage's list. */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {STAGES.map((st) => (
          <Link
            key={st.stage}
            to={`/recruiting?stage=${st.stage}`}
            className="rounded-lg border border-navy-secondary bg-navy p-4 elev-1 transition-all hover:-translate-y-0.5 hover:elev-2 hover:border-gold/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
          >
            <div className="text-2xs uppercase tracking-widest text-silver">{st.label}</div>
            <div className="mt-1 font-display text-3xl tabular-nums text-white">{s.byStage[st.stage as keyof typeof s.byStage]}</div>
          </Link>
        ))}
      </div>

      {nothingWaiting ? (
        <Card className="border-success/30 bg-success/5">
          <CardContent className="py-4 flex items-center gap-3 text-sm">
            <CheckCircle2 className="h-5 w-5 shrink-0 text-success" aria-hidden="true" />
            <span className="text-white">Nothing in recruiting is waiting on you.</span>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {s.stuckCount > 0 && (
            <Waiting
              icon={Hourglass}
              tone="attention"
              title={`${s.stuckCount} ${s.stuckCount === 1 ? 'candidate has' : 'candidates have'} waited ${s.stuckAfterDays}+ days in one stage`}
              to="/recruiting"
            >
              <ul className="space-y-1 pl-12 text-sm">
                {s.stuck.map((c) => (
                  <li key={c.id} className="flex items-baseline justify-between gap-2">
                    <Link to={`/recruiting?candidateId=${c.id}`} className="truncate text-silver hover:text-white">
                      {c.name}
                      {c.position ? ` · ${c.position}` : ''}
                    </Link>
                    <span className="shrink-0 text-xs text-warning tabular-nums">
                      {STAGE_LABEL[c.stage]} · {c.daysInStage}d
                    </span>
                  </li>
                ))}
              </ul>
            </Waiting>
          )}
          {s.interviewsToday.length > 0 && (
            <Waiting
              icon={CalendarClock}
              tone="normal"
              title={`${s.interviewsToday.length} interview${s.interviewsToday.length === 1 ? '' : 's'} today`}
              to="/recruiting?stage=INTERVIEW"
            >
              <ul className="space-y-1 pl-12 text-sm">
                {s.interviewsToday.map((i) => (
                  <li key={i.id} className="flex items-baseline justify-between gap-2">
                    <Link to={`/recruiting?candidateId=${i.candidateId}`} className="truncate text-silver hover:text-white">
                      {i.candidateName}
                    </Link>
                    <span className="shrink-0 text-xs text-silver tabular-nums">{fmtTime(i.scheduledFor)}</span>
                  </li>
                ))}
              </ul>
            </Waiting>
          )}
          {s.unscoredInterviews > 0 && (
            <Waiting
              icon={Star}
              tone="attention"
              title={`${s.unscoredInterviews} interview${s.unscoredInterviews === 1 ? ' needs' : 's need'} a score`}
              to="/recruiting?stage=INTERVIEW"
            />
          )}
          {s.offersAwaitingReply > 0 && (
            <Waiting
              icon={FileSignature}
              tone="normal"
              title={`${s.offersAwaitingReply} offer${s.offersAwaitingReply === 1 ? ' is' : 's are'} waiting on an answer`}
              to="/recruiting/extras?tab=offers"
            />
          )}
        </div>
      )}

      <p className="text-sm text-silver">
        <span className="text-white tabular-nums">{s.hiredThisMonth}</span> hired this month
        {s.medianDaysToHire !== null && (
          <>
            {' · '}median <span className="text-white tabular-nums">{s.medianDaysToHire}</span> days from applying to
            hired (last 90 days)
          </>
        )}
      </p>
    </section>
  );
}
