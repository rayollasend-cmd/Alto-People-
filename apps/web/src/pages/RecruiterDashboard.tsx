import { useState, type ReactNode } from 'react';
import { useGreeting, greetingName } from '@/lib/greeting';
import { HomeTemplate } from '@/components/templates';
import { HugoSeat } from '@/components/home/HugoSeat';
import { EmptyState } from '@/components/ui/EmptyState';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  AlarmClock,
  ArrowRight,
  Calendar,
  CalendarClock,
  FileSignature,
  Hourglass,
  Plus,
  Send,
  Sparkles,
  Star,
  UserCheck,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { RecruiterHome } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth, useRoleLabel } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { fmtDate, fmtRelativeDate, fmtTime } from '@/lib/format';
import { cn } from '@/lib/cn';
import { usePullToRefresh, PullToRefreshIndicator } from '@/lib/usePullToRefresh';
import { getRecruiterHome } from '@/lib/recruitingApi';
import { resendInvite } from '@/lib/onboardingApi';
import { RecruiterCalendarFeed } from '@/pages/recruiting/RecruiterCalendarFeed';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { LiveNow } from '@/components/ui/LiveNow';
import { MetricCard } from '@/components/ui/MetricCard';
import { SectionTitle as KitSectionTitle } from '@/components/ui/SectionTitle';
import { Skeleton } from '@/components/ui/Skeleton';
import { RoleDecisionQueue } from '@/components/RoleDecisionQueue';
import { MyPlanCard } from '@/components/MyPlanCard';
import { EVENT_ICON, actorOf, eventText } from '@/pages/recruiting/candidateEventText';
import { SOURCE_LABEL, STAGE_LABEL } from '@/pages/recruiting/recruitingLabels';

/**
 * The recruiter's home.
 *
 * A recruiter used to land on the HR administrator's dashboard — payroll
 * totals, open shifts, a feed of sign-ins, and "All systems nominal —
 * nothing needs your decision" above a pipeline with people going cold in
 * it, the recruiting itself below the fold. This page is the recruiter's
 * day instead, in the order they'd work it:
 *
 *   today's interviews · who applied · what's waiting on you (score,
 *   make the offer, hire, approve, follow up) · what's waiting on
 *   someone else (a client, a signature, a new hire's paperwork) · the
 *   pipeline and open postings · the numbers · what just happened.
 *
 * Every row opens the candidate; every section says what to do next.
 */

const candidateHref = (id: string) => `/recruiting?candidateId=${id}`;
/** Sources arrive lowercased; a known one has its label, any other is capitalized. */
const sourceName = (s: string | null) =>
  s ? (SOURCE_LABEL[s.toLowerCase()] ?? `${s.charAt(0).toUpperCase()}${s.slice(1)}`) : 'No source';
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The kit's section header, with this page's count badge and trailing link. */
function SectionTitle({ children, count, action }: { children: ReactNode; count?: number; action?: ReactNode }) {
  return (
    <KitSectionTitle
      title={
        <span className="inline-flex items-center gap-2">
          {children}
          {count !== undefined && count > 0 && (
            <Badge variant="outline" className="tabular-nums">
              {count}
            </Badge>
          )}
        </span>
      }
      trailing={action}
    />
  );
}

function MoreLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="inline-flex items-center gap-1 text-sm text-gold hover:text-gold-bright">
      {children}
      <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
    </Link>
  );
}

/** One kind of thing that's waiting: a count, a few rows, what to do. */
function WaitCard({
  icon: Icon,
  title,
  tone = 'normal',
  footer,
  children,
}: {
  icon: LucideIcon;
  title: string;
  tone?: 'attention' | 'normal';
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className={cn('h-full', tone === 'attention' && 'border-warning/40')}>
      <CardContent className="flex h-full flex-col p-4">
        <h3 className="flex items-start gap-2 text-sm font-medium text-white">
          <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', tone === 'attention' ? 'text-warning' : 'text-gold')} aria-hidden="true" />
          {title}
        </h3>
        <ul className="mt-2 flex-1 space-y-1.5">{children}</ul>
        {footer && <div className="mt-3 border-t border-navy-secondary/60 pt-2">{footer}</div>}
      </CardContent>
    </Card>
  );
}

/** A candidate on one line: their name opens them; the rest explains. */
function Row({ id, name, detail, trailing }: { id: string; name: string; detail?: ReactNode; trailing?: ReactNode }) {
  return (
    <li className="flex items-baseline justify-between gap-2 text-sm">
      <span className="min-w-0 truncate">
        <Link to={candidateHref(id)} className="text-white hover:text-gold hover:underline">
          {name}
        </Link>
        {detail && <span className="text-silver"> · {detail}</span>}
      </span>
      {trailing && <span className="shrink-0 text-xs tabular-nums text-silver">{trailing}</span>}
    </li>
  );
}

const INTERVIEW_STATE: Record<RecruiterHome['interviewsToday'][number]['state'], { label: string; variant: 'accent' | 'success' | 'pending' }> = {
  upcoming: { label: 'Upcoming', variant: 'accent' },
  done: { label: 'Scored', variant: 'success' },
  needs_score: { label: 'Needs a score', variant: 'pending' },
};

function Today({ home }: { home: RecruiterHome }) {
  const { t } = useI18n();
  const list = home.interviewsToday;
  return (
    <Card>
      <CardContent className="p-4 md:p-5">
        <SectionTitle
          count={list.length}
          action={<MoreLink to="/recruiting?view=list&stage=INTERVIEW">{t('recruiterHome.interviewing')}</MoreLink>}
        >
          <CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />
          {t('recruiterHome.todaysInterviews')}
        </SectionTitle>
        {list.length === 0 ? (
          <EmptyState
            icon={CalendarClock}
            title={t('recruiterHome.noInterviews')}
            description={t('recruiterHome.noInterviewsBody')}
            action={<MoreLink to="/recruiting?view=list&stage=SCREENING">{t('recruiterHome.inScreening')}</MoreLink>}
            className="py-6"
          />
        ) : (
          <ul className="divide-y divide-navy-secondary/60" aria-label={t('recruiterHome.todaysInterviews')}>
            {list.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 first:pt-0 last:pb-0">
                <span className="w-16 shrink-0 text-sm tabular-nums text-white">{fmtTime(i.scheduledFor)}</span>
                <span className="min-w-0 flex-1">
                  <Link to={candidateHref(i.candidateId)} className="text-sm text-white hover:text-gold hover:underline">
                    {i.candidateName}
                  </Link>
                  <span className="block truncate text-xs text-silver">
                    {[i.position, `${i.durationMinutes} min`, i.location, i.mine ? 'you' : i.interviewerName]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                <Badge variant={INTERVIEW_STATE[i.state].variant}>{INTERVIEW_STATE[i.state].label}</Badge>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function NewApplicants({ home }: { home: RecruiterHome }) {
  const { t } = useI18n();
  const a = home.newApplicants;
  return (
    <Card>
      <CardContent className="p-4 md:p-5">
        <SectionTitle action={<MoreLink to="/recruiting?view=list&stage=ALL&sort=newest">{t('recruiterHome.newest')}</MoreLink>}>
          <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
          {t('recruiterHome.newApplicants')}
        </SectionTitle>
        <div className="flex items-baseline gap-2">
          <span className="font-display text-4xl text-gold tabular-nums">{a.last24h}</span>
          <span className="text-sm text-silver">
            {t('recruiterHome.lastDayThisWeek', { n: a.last7d })}
          </span>
        </div>
        {a.bySource.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5" aria-label={t('recruiterHome.bySourceAria')}>
            {a.bySource.slice(0, 5).map((s) => (
              <Badge key={s.source ?? 'none'} variant="outline">
                {sourceName(s.source)} {s.count}
              </Badge>
            ))}
          </div>
        )}
        {a.recent.length > 0 && (
          <ul className="mt-3 space-y-1.5">
            {a.recent.map((c) => (
              <Row
                key={c.candidateId}
                id={c.candidateId}
                name={c.candidateName}
                detail={c.postingTitle ?? c.position ?? sourceName(c.source)}
                trailing={fmtRelativeDate(c.createdAt)}
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** Everything in the recruiter's own queue: the count the home's "Waiting on you" carries. */
function waitingOnYouTotal(home: RecruiterHome): number {
  const w = home.waitingOnYou;
  return (
    w.toScore.total +
    w.clientApproved.length +
    w.readyToHire.length +
    w.offersToApprove.length +
    w.stuck.total +
    w.closingSoon.total
  );
}

/** `headless`: the home's template titles the section and carries the count. */
function WaitingOnYou({ home, headless = false }: { home: RecruiterHome; headless?: boolean }) {
  const { t } = useI18n();
  const w = home.waitingOnYou;
  const total = waitingOnYouTotal(home);
  return (
    <section aria-labelledby={headless ? 'home-decisions' : 'waiting-on-you'}>
      {!headless && (
        <SectionTitle count={total}>
          <span id="waiting-on-you">{t('recruiterHome.waitingOnYou')}</span>
        </SectionTitle>
      )}
      {total === 0 ? (
        <Card>
          <CardContent className="p-4 text-sm text-silver">
            {t('recruiterHome.nothingWaitingOnYou')}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {w.readyToHire.length > 0 && (
            <WaitCard icon={UserCheck} title={`Signed — ready to hire (${w.readyToHire.length})`}>
              {w.readyToHire.map((o) => (
                <Row
                  key={o.offerId}
                  id={o.candidateId}
                  name={o.candidateName}
                  detail={`${o.jobTitle} · ${o.clientName}`}
                  trailing={`starts ${fmtDate(o.startDate)}`}
                />
              ))}
            </WaitCard>
          )}
          {w.clientApproved.length > 0 && (
            <WaitCard icon={Send} title={`Clients said yes — make the offer (${w.clientApproved.length})`}>
              {w.clientApproved.map((s) => (
                <li key={s.submittalId} className="text-sm">
                  <div className="flex items-baseline justify-between gap-2">
                    <Link to={candidateHref(s.candidateId)} className="truncate text-white hover:text-gold hover:underline">
                      {s.candidateName}
                    </Link>
                    <Link
                      to={`/recruiting/extras?tab=offers&new=1&candidate=${s.candidateId}`}
                      className="shrink-0 text-xs text-gold hover:underline"
                    >
                      Make offer
                    </Link>
                  </div>
                  <div className="truncate text-xs text-silver">
                    {s.clientName}
                    {s.storeName ? ` · ${s.storeName}` : ''}
                    {s.feedback ? ` — “${s.feedback}”` : ''}
                  </div>
                </li>
              ))}
            </WaitCard>
          )}
          {w.toScore.total > 0 && (
            <WaitCard
              icon={Star}
              tone="attention"
              title={`Interviews to score (${w.toScore.total}${w.toScore.mine ? ` · ${w.toScore.mine} yours` : ''})`}
              footer={
                w.toScore.total > w.toScore.items.length ? (
                  <MoreLink to="/recruiting?view=list&stage=INTERVIEW&sort=waiting">See the rest</MoreLink>
                ) : undefined
              }
            >
              {w.toScore.items.map((i) => (
                <Row
                  key={i.interviewId}
                  id={i.candidateId}
                  name={i.candidateName}
                  detail={i.mine ? 'yours' : (i.interviewerName ?? 'no interviewer')}
                  trailing={fmtRelativeDate(i.scheduledFor)}
                />
              ))}
            </WaitCard>
          )}
          {w.offersToApprove.length > 0 && (
            <WaitCard
              icon={FileSignature}
              tone="attention"
              title={`Offers to approve (${w.offersToApprove.length})`}
              footer={<MoreLink to="/recruiting/extras?tab=offers">Review offers</MoreLink>}
            >
              {w.offersToApprove.map((o) => (
                <li key={o.offerId} className="text-sm">
                  <Link to={candidateHref(o.candidateId)} className="text-white hover:text-gold hover:underline">
                    {o.candidateName}
                  </Link>
                  <span className="text-silver"> · {o.jobTitle}</span>
                  {o.approvalNote && <div className="text-xs text-warning">{o.approvalNote}</div>}
                </li>
              ))}
            </WaitCard>
          )}
          {w.closingSoon.total > 0 && (
            <WaitCard
              icon={AlarmClock}
              tone="attention"
              title={`Closing soon — no response (${w.closingSoon.total})`}
              footer={
                <p className="text-xs text-silver">
                  Anything on their record — a note, a move, an interview — keeps them open. Otherwise they close as No
                  response; you can reopen them.
                </p>
              }
            >
              {w.closingSoon.items.map((c) => (
                <Row
                  key={c.candidateId}
                  id={c.candidateId}
                  name={c.candidateName}
                  detail={STAGE_LABEL[c.stage as keyof typeof STAGE_LABEL] ?? c.stage}
                  trailing={`closes ${fmtDate(c.closesAt)}`}
                />
              ))}
            </WaitCard>
          )}
          {w.stuck.total > 0 && (
            <WaitCard
              icon={Hourglass}
              tone="attention"
              title={`Gone quiet ${w.stuck.afterDays}+ days (${w.stuck.total})`}
              footer={<MoreLink to="/recruiting?view=list&stage=ALL&stuck=1&sort=waiting">See all {w.stuck.total}</MoreLink>}
            >
              {w.stuck.items.map((c) => (
                <Row
                  key={c.candidateId}
                  id={c.candidateId}
                  name={c.candidateName}
                  detail={STAGE_LABEL[c.stage as keyof typeof STAGE_LABEL] ?? c.stage}
                  trailing={`${c.daysInStage}d`}
                />
              ))}
            </WaitCard>
          )}
        </div>
      )}
    </section>
  );
}

function WaitingOnOthers({ home }: { home: RecruiterHome }) {
  const { t } = useI18n();
  const w = home.waitingOnOthers;
  const queryClient = useQueryClient();
  const [resending, setResending] = useState<string | null>(null);
  const total = w.withClients.total + w.awaitingSignature.total + w.onboardingNotStarted.total;

  const resend = async (applicationId: string, name: string) => {
    setResending(applicationId);
    try {
      const r = await resendInvite(applicationId);
      if (r.inviteUrl) {
        await navigator.clipboard?.writeText(r.inviteUrl).catch(() => undefined);
        toast.success(`New link for ${name} copied — email isn't set up here, so send it to them yourself.`);
      } else {
        toast.success(`Onboarding invite sent to ${name} again.`);
      }
      void queryClient.invalidateQueries({ queryKey: ['recruiting', 'home'] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not resend the invite.');
    } finally {
      setResending(null);
    }
  };

  return (
    <section aria-labelledby="waiting-on-others">
      <SectionTitle count={total}>
        <span id="waiting-on-others">{t('recruiterHome.waitingOnOthers')}</span>
      </SectionTitle>
      {total === 0 ? (
        <Card>
          <CardContent className="p-4 text-sm text-silver">
            {t('recruiterHome.nothingWithOthers')}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {w.withClients.total > 0 && (
            <WaitCard icon={Users} title={`With clients to review (${w.withClients.total})`}>
              {w.withClients.items.map((s) => (
                <Row
                  key={s.submittalId}
                  id={s.candidateId}
                  name={s.candidateName}
                  detail={s.storeName ? `${s.clientName} · ${s.storeName}` : s.clientName}
                  trailing={s.days === 0 ? 'today' : `${s.days}d`}
                />
              ))}
            </WaitCard>
          )}
          {w.awaitingSignature.total > 0 && (
            <WaitCard
              icon={FileSignature}
              title={`Offers out for signature (${w.awaitingSignature.total})`}
              tone={w.awaitingSignature.items.some((o) => o.expiringSoon) ? 'attention' : 'normal'}
            >
              {w.awaitingSignature.items.map((o) => (
                <Row
                  key={o.offerId}
                  id={o.candidateId}
                  name={o.candidateName}
                  detail={o.jobTitle}
                  trailing={
                    o.expiresAt ? (
                      <span className={o.expiringSoon ? 'text-warning' : undefined}>expires {fmtDate(o.expiresAt)}</span>
                    ) : (
                      `sent ${fmtRelativeDate(o.sentAt)}`
                    )
                  }
                />
              ))}
            </WaitCard>
          )}
          {w.onboardingNotStarted.total > 0 && (
            <WaitCard
              icon={Calendar}
              tone="attention"
              title={`Hired, onboarding not started (${w.onboardingNotStarted.total})`}
              footer={<MoreLink to="/onboarding?status=DRAFT">Onboarding</MoreLink>}
            >
              {w.onboardingNotStarted.items.map((a) => (
                <li key={a.applicationId} className="flex items-center justify-between gap-2 text-sm">
                  <span className="min-w-0">
                    <Link to={candidateHref(a.candidateId)} className="block truncate text-white hover:text-gold hover:underline">
                      {a.candidateName}
                    </Link>
                    <span className="block truncate text-xs text-silver">
                      {a.clientName} · invited {a.days === 0 ? 'today' : `${a.days}d ago`}
                      {a.closesAt && (
                        <span
                          className={
                            Date.parse(a.closesAt) - Date.now() < 3 * 86_400_000 ? 'text-warning' : undefined
                          }
                        >
                          {' '}
                          · closes around {fmtDate(a.closesAt)}
                        </span>
                      )}
                    </span>
                  </span>
                  <Button
                    size="xs"
                    variant="ghost"
                    className="shrink-0"
                    loading={resending === a.applicationId}
                    disabled={resending !== null}
                    onClick={() => void resend(a.applicationId, a.candidateName)}
                    aria-label={`Resend the onboarding invite to ${a.candidateName}`}
                  >
                    Resend invite
                  </Button>
                </li>
              ))}
            </WaitCard>
          )}
        </div>
      )}
    </section>
  );
}

function PipelineAndPostings({ home }: { home: RecruiterHome }) {
  const { t } = useI18n();
  const stages = ['APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER'] as const;
  return (
    <div className="grid gap-3 lg:grid-cols-3">
      <Card>
        <CardContent className="p-4 md:p-5">
          <SectionTitle action={<MoreLink to="/recruiting">{t('recruiterHome.board')}</MoreLink>}>{t('recruiterHome.pipeline')}</SectionTitle>
          <ul className="grid grid-cols-2 gap-2">
            {stages.map((s) => (
              <li key={s}>
                <Link
                  to={`/recruiting?view=list&stage=${s}`}
                  className="block rounded-md border border-navy-secondary px-3 py-2 transition-colors hover:border-silver/40"
                >
                  <div className="text-2xs uppercase tracking-widest text-silver">{STAGE_LABEL[s]}</div>
                  <div className="font-display text-2xl tabular-nums text-white">{home.pipeline[s]}</div>
                </Link>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      <Card className="lg:col-span-2">
        <CardContent className="p-4 md:p-5">
          <SectionTitle count={home.postings.total} action={<MoreLink to="/recruiting/extras?tab=postings">{t('recruiterHome.postings')}</MoreLink>}>
            {t('recruiterHome.openPostings')}
          </SectionTitle>
          {home.postings.items.length === 0 ? (
            <EmptyState
              icon={Plus}
              title={t('recruiterHome.noPostings')}
              description={t('recruiterHome.noPostingsBody')}
              action={<MoreLink to="/recruiting/extras?tab=postings">{t('recruiterHome.openPosting')}</MoreLink>}
              className="py-6"
            />
          ) : (
            <ul className="divide-y divide-navy-secondary/60">
              {home.postings.items.map((p) => {
                const filled = Math.min(p.hired, p.openings);
                const pct = Math.round((filled / Math.max(1, p.openings)) * 100);
                return (
                  <li key={p.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2 first:pt-0 last:pb-0">
                    <Link to={`/recruiting?posting=${p.id}`} className="min-w-0 flex-1 truncate text-sm text-white hover:text-gold hover:underline">
                      {p.title}
                      {p.clientName && <span className="text-silver"> · {p.clientName}</span>}
                    </Link>
                    <span className="flex items-center gap-2 text-xs text-silver">
                      <span
                        role="meter"
                        aria-label={`${p.title} filled`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={pct}
                        className="h-1.5 w-16 overflow-hidden rounded-full"
                        style={{ background: 'rgb(var(--color-chart-1) / 0.18)' }}
                      >
                        <span className="block h-full rounded-full" style={{ width: `${pct}%`, background: 'rgb(var(--color-chart-1))' }} />
                      </span>
                      <span className="tabular-nums">
                        {filled} of {p.openings} filled
                      </span>
                    </span>
                    <span className="w-full text-xs tabular-nums text-silver sm:w-44 sm:text-right">
                      {plural(p.applicants, 'applicant')}
                      {p.applicants7d > 0 ? ` (+${p.applicants7d})` : ''}
                      {p.daysOpen !== null ? ` · ${p.daysOpen}d open` : ''}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

const fmtBudget = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

/** How a requisition's status reads — PLANNED is one still waiting on its approver. */
const REQ_STATUS: Record<string, { label: string; variant: 'pending' | 'success' | 'info' | 'outline' }> = {
  PLANNED: { label: 'Awaiting approval', variant: 'pending' },
  OPEN: { label: 'Approved — hiring', variant: 'success' },
  FROZEN: { label: 'On hold', variant: 'info' },
};

/**
 * The requisitions behind the pipeline: what the recruiter is hiring
 * against and what is still waiting on an approver (named), beside the
 * postings, with the budget each seat carries.
 */
function Requisitions({ reqs }: { reqs: NonNullable<RecruiterHome['requisitions']> }) {
  const waiting = reqs.byStatus.PLANNED ?? 0;
  return (
    <section aria-labelledby="requisitions">
      <SectionTitle count={reqs.total} action={<MoreLink to="/headcount">Headcount</MoreLink>}>
        <span id="requisitions">Requisitions</span>
      </SectionTitle>
      {reqs.items.length === 0 ? (
        <Card>
          <CardContent className="p-4 text-sm text-silver">Every position is filled or closed — the pipeline is hiring against nothing right now.</CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-4 md:p-5">
            {waiting > 0 && (
              <p className="mb-2 text-xs text-warning">
                {waiting} requisition{waiting === 1 ? '' : 's'} still waiting on approval — hiring against {waiting === 1 ? 'it' : 'them'} starts when it lands.
              </p>
            )}
            <ul className="divide-y divide-navy-secondary/60">
              {reqs.items.map((r) => {
                const s = REQ_STATUS[r.status] ?? { label: r.status, variant: 'outline' as const };
                return (
                  <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2 first:pt-0 last:pb-0 text-sm">
                    <span className="min-w-0 flex-1 truncate text-ink">
                      {r.title}
                      <span className="text-silver">
                        {' '}
                        · {r.code}
                        {r.clientName ? ` · ${r.clientName}` : ''}
                      </span>
                    </span>
                    <span className="text-xs tabular-nums text-silver">
                      {r.fteAuthorized} FTE{r.targetStartDate ? ` · starts ${fmtDate(r.targetStartDate)}` : ''}
                      {r.budgetAmount != null ? ` · ${fmtBudget(r.budgetAmount)}${r.budgetPeriod === 'MONTHLY' ? '/mo' : '/yr'}` : ''}
                    </span>
                    {r.waitingOn && (
                      <span className="w-full text-xs text-silver md:w-auto">
                        Waiting on {r.waitingOn}
                        {r.requestedAt ? ` since ${fmtDate(r.requestedAt.slice(0, 10))}` : ''}
                      </span>
                    )}
                    <Badge variant={s.variant}>{s.label}</Badge>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}
    </section>
  );
}

function Numbers({ home }: { home: RecruiterHome }) {
  const { t } = useI18n();
  const n = home.numbers;
  return (
    <section aria-labelledby="numbers">
      <SectionTitle action={<MoreLink to="/recruiting/analytics">{t('recruiterHome.analytics')}</MoreLink>}>
        <span id="numbers">{t('recruiterHome.numbers')}</span>
      </SectionTitle>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard label={t('recruiterHome.hiresThisMonth')} value={n.hiresThisMonth} hint={t('recruiterHome.nLastMonth', { n: n.hiresLastMonth })} />
        <MetricCard
          label={t('recruiterHome.medianTimeToHire')}
          value={n.medianDaysToHire === null ? '—' : n.medianDaysToHire < 1 ? '< 1 day' : `${n.medianDaysToHire} days`}
          hint={t('recruiterHome.last90Days')}
        />
        <MetricCard
          label={t('recruiterHome.offerAcceptance')}
          value={n.offerAcceptancePct === null ? '—' : `${n.offerAcceptancePct}%`}
          hint={n.offersDecided ? `${plural(n.offersDecided, 'offer')} decided, last 90 days` : 'No offers decided in 90 days'}
        />
        <MetricCard
          label={t('recruiterHome.inPipeline')}
          value={home.pipeline.APPLIED + home.pipeline.SCREENING + home.pipeline.INTERVIEW + home.pipeline.OFFER}
          hint={t('recruiterHome.nAtOffer', { n: home.pipeline.OFFER })}
        />
      </div>
    </section>
  );
}

function Activity({ home }: { home: RecruiterHome }) {
  const { t } = useI18n();
  return (
    <section aria-labelledby="activity">
      <SectionTitle>
        <span id="activity">{t('recruiterHome.activity')}</span>
      </SectionTitle>
      <Card>
        <CardContent className="p-4 md:p-5">
          {home.activity.length === 0 ? (
            <p className="text-sm text-silver/70">{t('recruiterHome.nothingYet')}</p>
          ) : (
            <ul className="space-y-3">
              {home.activity.map((e) => {
                const Icon = EVENT_ICON[e.kind];
                const who = actorOf(e);
                return (
                  <li key={e.id} className="flex gap-3">
                    <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-navy-secondary/60">
                      <Icon className="h-3.5 w-3.5 text-silver" aria-hidden="true" />
                    </span>
                    <div className="min-w-0 text-sm">
                      <Link to={candidateHref(e.candidateId)} className="text-white hover:text-gold hover:underline">
                        {e.candidateName}
                      </Link>
                      <span className="text-silver"> — {eventText(e)}</span>
                      <div className="text-xs text-silver/70">
                        {who ? `${who} · ` : ''}
                        {fmtRelativeDate(e.createdAt)}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

export function RecruiterDashboard() {
  const roleLabel = useRoleLabel();
  const { user, role, can } = useAuth();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const pullState = usePullToRefresh(() => queryClient.invalidateQueries());
  const q = useQuery({
    queryKey: ['recruiting', 'home'],
    queryFn: getRecruiterHome,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  const home = q.data;
  const greet = useGreeting();
  const name = greetingName(user, '');

  const retry = (
    <Button size="sm" variant="secondary" onClick={() => void q.refetch()}>
      Retry
    </Button>
  );

  return (
    <>
      <PullToRefreshIndicator state={pullState} />
      {/* Design system §4.1 (UX upgrade step 6, the sweep): the Home template.
          Today's interviews are the hero, the recruiter's own queue "Waiting
          on you" (counted), the pipeline's doors as ways in. */}
      <HomeTemplate
        title={
          <>
            <LiveNow render={(now) => greet(now.getHours())} />
            {name && <>, <span className="text-accent">{name}</span></>}.
          </>
        }
        topbarTitle="Home"
        subtitle={t('recruiterHome.subtitle')}
        meta={
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex items-center gap-2 text-xs2 uppercase tracking-[0.18em] text-ink-muted">
              <Calendar className="h-3 w-3" aria-hidden="true" />
              <LiveNow render={(now) => fmtDate(now)} />
            </span>
            {role && (
              <Badge variant="accent" caps className="tracking-[0.18em]">
                {roleLabel(role)}
              </Badge>
            )}
          </div>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <RecruiterCalendarFeed />
            {can('manage:recruiting') ? (
              <Button asChild size="sm">
                <Link to="/recruiting?new=1">
                  <Plus className="h-4 w-4" />
                  {t('recruiterHome.newCandidate')}
                </Link>
              </Button>
            ) : (
              <Button asChild variant="outline" size="sm">
                <Link to="/recruiting">{t('recruiterHome.openPipeline')}</Link>
              </Button>
            )}
          </div>
        }
        hero={
          home ? (
            <Today home={home} />
          ) : q.isError ? (
            <EmptyState
              icon={CalendarClock}
              title={t('recruiterHome.todaysInterviews')}
              description={q.error instanceof ApiError ? q.error.message : t('recruiterHome.loadError')}
              action={retry}
            />
          ) : (
            <Skeleton className="h-56" />
          )
        }
        decisions={home ? { title: t('recruiterHome.waitingOnYou'), count: waitingOnYouTotal(home), content: <WaitingOnYou home={home} headless /> } : undefined}
        assistant={<HugoSeat />}
        waysIn={
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <Link to="/recruiting">{t('recruiterHome.openPipeline')}</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/recruiting?view=list&stage=INTERVIEW">{t('recruiterHome.interviewing')}</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/onboarding">{t('recruiterHome.onboarding')}</Link>
            </Button>
          </div>
        }
      >
        {!home && !q.isError && (
          <div className="space-y-4" aria-label={t('recruiterHome.loadingAria')}>
            <Skeleton className="h-40" />
            <Skeleton className="h-40" />
          </div>
        )}
        {home && (
          <>
            <NewApplicants home={home} />
            <WaitingOnOthers home={home} />
            <PipelineAndPostings home={home} />
            {home.requisitions && <Requisitions reqs={home.requisitions} />}
            <Numbers home={home} />
            <Activity home={home} />
          </>
        )}
        {/* Approvals from outside recruiting (time off and the like) — only
            when there are any; "nothing needs your decision" would contradict
            the waiting list above. */}
        <RoleDecisionQueue title={t('recruiterHome.otherApprovals')} hideWhenEmpty />
        <MyPlanCard />
      </HomeTemplate>
    </>
  );
}
