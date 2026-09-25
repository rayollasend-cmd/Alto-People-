import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Building2, CalendarClock, FileText, Link2, Mail, Pencil, Phone, Send, Star } from 'lucide-react';
import type { Candidate, CandidateStage } from '@alto-people/shared';
import { safeHref } from '@alto-people/shared';
import {
  deleteInterview,
  listInterviewKits,
  listInterviews,
  listOffers,
  signedOfferUrl,
  type InterviewKit,
  type InterviewRecord,
  type OfferRecord,
} from '@/lib/recruiting90Api';
import { listSubmittals, withdrawSubmittal, type CandidateSubmittal } from '@/lib/recruitingApi';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { statusLabel } from '@/lib/status';
import { cn } from '@/lib/cn';
import { AssociateLink } from '@/components/ui/AssociateLink';
import {
  Avatar,
  Badge,
  Button,
  ConfirmDialog,
  Drawer,
  DrawerBody,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  ErrorBanner,
  SkeletonRows,
} from '@/components/ui';
import {
  CandidateTimeline,
  EditCandidateDialog,
  ScheduleInterviewDialog,
  ScorecardSummary,
  ScoreInterviewDialog,
  SubmitToClientDialog,
} from './CandidateWorkPanels';
import { SOURCE_LABEL, STAGE_LABEL, daysSince, ratingLabel } from './recruitingLabels';

/**
 * The full picture for one candidate: profile, where they came from, their
 * interviews and offers, and the stage controls.
 *
 * The board and the table only ever showed a summary card — everything below
 * (notes, phone, interview scores, offer terms) existed in the API but had no
 * screen. Opening a candidate had no destination at all.
 *
 * Interviews and offers are fetched per-candidate on open rather than being
 * threaded down from the list, so the drawer stays correct after someone
 * schedules an interview elsewhere in Recruiting.
 *
 * It is also where the work happens: edit the record, schedule and score
 * interviews, and keep notes on the timeline — each of which had an API
 * and no screen.
 */

const STAGE_VARIANT: Record<
  CandidateStage,
  'default' | 'success' | 'destructive' | 'outline' | 'accent' | 'pending'
> = {
  APPLIED: 'default',
  SCREENING: 'pending',
  INTERVIEW: 'accent',
  OFFER: 'accent',
  HIRED: 'success',
  WITHDRAWN: 'outline',
  REJECTED: 'destructive',
};

const SUBMITTAL_BADGE: Record<
  CandidateSubmittal['status'],
  { label: string; variant: 'pending' | 'success' | 'destructive' | 'outline' }
> = {
  PENDING: { label: 'Waiting on client', variant: 'pending' },
  APPROVED: { label: 'Approved', variant: 'success' },
  DECLINED: { label: 'Passed', variant: 'destructive' },
  WITHDRAWN: { label: 'Withdrawn', variant: 'outline' },
};

/** The forward path a candidate walks. Terminal stages sit outside it. */
const PIPELINE: CandidateStage[] = [
  'APPLIED',
  'SCREENING',
  'INTERVIEW',
  'OFFER',
  'HIRED',
];

const OFFER_VARIANT: Record<
  OfferRecord['status'],
  'default' | 'success' | 'destructive' | 'outline' | 'accent' | 'pending'
> = {
  PENDING_APPROVAL: 'pending',
  DRAFT: 'default',
  SENT: 'accent',
  ACCEPTED: 'success',
  DECLINED: 'destructive',
  EXPIRED: 'outline',
  WITHDRAWN: 'outline',
};

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-2xs uppercase tracking-wider text-silver mb-0.5">
        {label}
      </div>
      <div className="text-sm text-white break-words">{children}</div>
    </div>
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  /** A control that belongs to this section, beside its heading. */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex min-h-8 items-center justify-between gap-2">
        <h3 className="text-2xs uppercase tracking-widest text-silver">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * Where the candidate sits on the forward path. Terminal stages (rejected,
 * withdrawn) have no position on it, so the tracker is replaced by a plain
 * statement of the outcome rather than a misleading half-filled rail.
 */
function StageTracker({ stage }: { stage: CandidateStage }) {
  const idx = PIPELINE.indexOf(stage);
  if (idx === -1) {
    return (
      <Badge variant={STAGE_VARIANT[stage]}>{STAGE_LABEL[stage]}</Badge>
    );
  }
  return (
    <ol className="flex items-center gap-1" aria-label="Pipeline progress">
      {PIPELINE.map((s, i) => {
        const done = i < idx;
        const current = i === idx;
        return (
          <li key={s} className="flex items-center gap-1">
            <span
              aria-current={current ? 'step' : undefined}
              className={cn(
                'rounded-full px-2 py-0.5 text-2xs whitespace-nowrap transition-colors',
                current && 'bg-gold-fill text-on-accent font-medium',
                done && 'bg-navy-secondary text-silver',
                !done && !current && 'text-silver/50',
              )}
            >
              {STAGE_LABEL[s]}
            </span>
            {i < PIPELINE.length - 1 && (
              <span
                aria-hidden="true"
                className={cn(
                  'h-px w-3',
                  i < idx ? 'bg-silver/50' : 'bg-navy-secondary',
                )}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function CandidateDetailDrawer({
  candidate,
  onOpenChange,
  onChanged,
  actions,
}: {
  /** null closes the drawer; the caller owns which candidate is open. */
  candidate: Candidate | null;
  onOpenChange: (open: boolean) => void;
  /**
   * Stage controls, supplied by the page so the drawer reuses the exact
   * advance/hire/reject/withdraw handlers the table and board already use
   * instead of growing a second copy of that logic.
   */
  actions?: ReactNode;
  /** Something on the record changed here — the page should refetch it. */
  onChanged?: () => void;
}) {
  const { can } = useAuth();
  const [interviews, setInterviews] = useState<InterviewRecord[] | null>(null);
  const [offers, setOffers] = useState<OfferRecord[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  // The interview being moved or called off, when there is one.
  const [moving, setMoving] = useState<InterviewRecord | null>(null);
  const [cancelling, setCancelling] = useState<InterviewRecord | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [scoring, setScoring] = useState<{ interview: InterviewRecord; kit: InterviewKit | null } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [withdrawing, setWithdrawing] = useState<CandidateSubmittal | null>(null);
  const [withdrawBusy, setWithdrawBusy] = useState(false);
  // Bumped by every write made from the drawer, so the timeline reloads.
  const [bump, setBump] = useState(0);

  const candidateId = candidate?.id ?? null;

  const interviewsQuery = useQuery({
    queryKey: ['CandidateDetailDrawer', 'interviews', candidateId],
    queryFn: () => Promise.all([listInterviews(candidateId!), listOffers(candidateId!)]),
    enabled: Boolean(candidateId),
  });
  const error = interviewsQuery.error ? interviewsQuery.error instanceof ApiError
            ? interviewsQuery.error.message
            : 'Could not load interviews and offers.' : null;
  // Who it has been put in front of, and what they said.
  const submittalsQuery = useQuery({
    queryKey: ['CandidateDetailDrawer', 'submittals', candidateId],
    queryFn: () => listSubmittals(candidateId!),
    enabled: Boolean(candidateId),
  });
  const submittals = submittalsQuery.data?.submittals ?? null;
  useEffect(() => {
    setInterviews(null);
    setOffers(null);
  }, [candidateId]);
  useEffect(() => {
    if (interviewsQuery.data === undefined) return;
    const [i, o] = interviewsQuery.data;
    setInterviews(i.interviews);
    setOffers(o.offers);
  }, [interviewsQuery.data]);

  if (!candidate) return null;

  const changed = () => {
    setBump((n) => n + 1);
    void interviewsQuery.refetch();
    void submittalsQuery.refetch();
    onChanged?.();
  };

  const withdraw = async () => {
    if (!withdrawing) return;
    setWithdrawBusy(true);
    try {
      await withdrawSubmittal(withdrawing.id);
      toast.success(`Withdrawn — ${withdrawing.clientName} no longer sees ${candidate.firstName}.`);
      setWithdrawing(null);
      changed();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not withdraw.');
    } finally {
      setWithdrawBusy(false);
    }
  };

  const cancelInterview = async () => {
    if (!cancelling) return;
    setCancelBusy(true);
    try {
      await deleteInterview(cancelling.id);
      toast.success('Interview cancelled — the calendar invites are withdrawn.');
      setCancelling(null);
      changed();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not cancel the interview.');
    } finally {
      setCancelBusy(false);
    }
  };

  const openScore = async (i: InterviewRecord) => {
    let kit: InterviewKit | null = null;
    if (i.kitId) {
      try {
        kit = (await listInterviewKits()).kits.find((k) => k.id === i.kitId) ?? null;
      } catch {
        // No kit questions to show — the overall score still works.
      }
    }
    setScoring({ interview: i, kit });
  };

  const fullName = `${candidate.firstName} ${candidate.lastName}`;
  const outcome = candidate.rejectedReason ?? candidate.withdrawnReason;
  // The empty interviews/offers sections were dead ends; the offer one now
  // hands off to the offer drawer, pre-seeded. Only for candidates still in
  // the funnel — extending an offer to a rejected/withdrawn/hired person
  // is a per-candidate judgment call, not a shortcut.
  const isTerminal =
    candidate.stage === 'HIRED' ||
    candidate.stage === 'REJECTED' ||
    candidate.stage === 'WITHDRAWN';
  const canManage = can('manage:recruiting');
  const canExtendOffer = canManage && !isTerminal;
  const inStage = daysSince(candidate.stageChangedAt);

  return (
    <Drawer open={candidate !== null} onOpenChange={onOpenChange} width="max-w-xl">
      <DrawerHeader>
        <div className="flex items-start gap-3">
          <Avatar name={fullName} email={candidate.email} size="md" />
          <div className="min-w-0 flex-1">
            <DrawerTitle>{fullName}</DrawerTitle>
            <DrawerDescription>
              {candidate.position ?? 'No position recorded'} · applied{' '}
              {fmtDate(candidate.createdAt)}
              {!isTerminal && (
                <>
                  {' '}
                  · in {STAGE_LABEL[candidate.stage]} for {inStage === 0 ? 'under a day' : `${inStage} day${inStage === 1 ? '' : 's'}`}
                </>
              )}
            </DrawerDescription>
          </div>
          {canManage && (
            // Clear of the drawer's own close button in the top corner.
            <Button size="sm" variant="outline" className="mr-10 shrink-0" onClick={() => setEditing(true)}>
              <Pencil className="h-3.5 w-3.5" />
              Edit
            </Button>
          )}
        </div>
        <div className="mt-3 overflow-x-auto">
          <StageTracker stage={candidate.stage} />
        </div>
      </DrawerHeader>

      <DrawerBody className="space-y-6">
        {/* The hire handoff's landing spot: a hired candidate's record used
            to be a dead end with no way out to the associate it created. */}
        {candidate.stage === 'HIRED' && candidate.hiredAssociateId && (
          <div className="rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm text-white">
            <span className="font-medium text-success">Hired</span>
            {candidate.hiredAt ? ` ${fmtDate(candidate.hiredAt)}` : ''} · associate
            record:{' '}
            <AssociateLink associateId={candidate.hiredAssociateId}>
              {fullName}
            </AssociateLink>
          </div>
        )}
        {outcome && (
          <div
            className={cn(
              'rounded-md border px-3 py-2 text-sm',
              candidate.rejectedReason
                ? 'border-alert/40 bg-alert/10 text-alert'
                : 'border-navy-secondary bg-navy-secondary/40 text-silver',
            )}
          >
            <span className="font-medium">
              {candidate.rejectedReason ? 'Rejected' : 'Withdrawn'}:
            </span>{' '}
            {outcome}
          </div>
        )}

        <Section title="Contact">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Email">
              <a
                href={`mailto:${candidate.email}`}
                className="inline-flex items-center gap-1.5 text-gold hover:underline"
              >
                <Mail className="h-3.5 w-3.5 shrink-0" />
                {candidate.email}
              </a>
            </Field>
            <Field label="Phone">
              {candidate.phone ? (
                <a
                  href={`tel:${candidate.phone}`}
                  className="inline-flex items-center gap-1.5 text-gold hover:underline"
                >
                  <Phone className="h-3.5 w-3.5 shrink-0" />
                  {candidate.phone}
                </a>
              ) : (
                <span className="text-silver">—</span>
              )}
            </Field>
            <Field label="Source">
              {candidate.source
                ? (SOURCE_LABEL[candidate.source] ?? candidate.source)
                : '—'}
            </Field>
            <Field label="Stage">
              <Badge variant={STAGE_VARIANT[candidate.stage]}>
                {STAGE_LABEL[candidate.stage]}
              </Badge>
            </Field>
          </div>
          {(candidate.resumeUrl || candidate.linkedinUrl) && (
            <div className="flex flex-wrap gap-2 pt-1">
              {candidate.resumeUrl && (
                <a
                  href={safeHref(candidate.resumeUrl)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-md border border-navy-secondary px-2.5 py-1 text-xs2 text-silver hover:text-white hover:border-silver/40 transition-colors"
                >
                  <FileText className="h-3.5 w-3.5" />
                  Resume
                </a>
              )}
              {candidate.linkedinUrl && (
                <a
                  href={safeHref(candidate.linkedinUrl)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-md border border-navy-secondary px-2.5 py-1 text-xs2 text-silver hover:text-white hover:border-silver/40 transition-colors"
                >
                  <Link2 className="h-3.5 w-3.5" />
                  LinkedIn
                </a>
              )}
            </div>
          )}
        </Section>

        {candidate.notes && (
          <Section title="About">
            <p className="whitespace-pre-wrap text-sm text-silver">
              {candidate.notes}
            </p>
          </Section>
        )}

        {error && <ErrorBanner>{error}</ErrorBanner>}

        <Section
          title="Interviews"
          action={
            canManage && !isTerminal ? (
              <Button size="sm" variant="outline" onClick={() => setScheduling(true)}>
                <CalendarClock className="h-3.5 w-3.5" />
                Schedule
              </Button>
            ) : null
          }
        >
          {interviews === null && !error ? (
            <SkeletonRows count={2} />
          ) : !interviews?.length ? (
            <p className="text-sm text-silver/70">No interviews scheduled.</p>
          ) : (
            <div className="space-y-2">
            <ScorecardSummary interviews={interviews} />
            <ul className="space-y-2">
              {interviews.map((i) => {
                const upcoming = !i.completedAt && new Date(i.scheduledFor).getTime() > Date.now();
                return (
                <li
                  key={i.id}
                  className="rounded-md border border-navy-secondary bg-navy/60 px-3 py-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.5 text-sm text-white">
                      <CalendarClock className="h-3.5 w-3.5 shrink-0 text-silver" />
                      {fmtDateTime(i.scheduledFor)}
                    </span>
                    {i.rating !== null ? (
                      <Badge
                        variant={i.rating > 0 ? 'success' : i.rating < 0 ? 'destructive' : 'outline'}
                      >
                        {ratingLabel(i.rating)}
                      </Badge>
                    ) : (
                      canManage &&
                      !i.completedAt && (
                        <Button size="sm" variant="ghost" onClick={() => void openScore(i)}>
                          <Star className="h-3.5 w-3.5" />
                          Score
                        </Button>
                      )
                    )}
                  </div>
                  <div className="mt-1 text-xs2 text-silver">
                    {i.durationMinutes} min
                    {i.location ? ` · ${i.location}` : ''}
                    {' · '}
                    {i.kitName ?? 'No kit'}
                    {i.interviewerEmail ? ` · ${i.interviewerEmail}` : ''}
                    {i.completedAt ? ' · scored' : upcoming ? ' · scheduled' : ' · needs a score'}
                  </div>
                  {canManage && upcoming && (
                    <div className="mt-2 flex gap-2">
                      <Button size="sm" variant="outline" onClick={() => setMoving(i)}>
                        Reschedule
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-alert hover:text-alert"
                        onClick={() => setCancelling(i)}
                      >
                        Cancel
                      </Button>
                    </div>
                  )}
                </li>
                );
              })}
            </ul>
            </div>
          )}
        </Section>

        <Section
          title="Client review"
          action={
            canManage && !isTerminal ? (
              <Button size="sm" variant="outline" onClick={() => setSubmitting(true)}>
                <Building2 className="h-3.5 w-3.5" />
                Put forward
              </Button>
            ) : null
          }
        >
          {submittalsQuery.error ? (
            <ErrorBanner>Could not load the client reviews.</ErrorBanner>
          ) : submittals === null ? (
            <SkeletonRows count={1} />
          ) : submittals.length === 0 ? (
            <p className="text-sm text-silver/70">Not put in front of a client yet.</p>
          ) : (
            <ul className="space-y-2">
              {submittals.map((s) => (
                <li key={s.id} className="rounded-md border border-navy-secondary bg-navy/60 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-sm text-white">
                      {s.clientName}
                      {s.locationName ? ` · ${s.locationName}` : ''}
                    </span>
                    <Badge variant={SUBMITTAL_BADGE[s.status].variant}>{SUBMITTAL_BADGE[s.status].label}</Badge>
                  </div>
                  <div className="mt-1 text-xs2 text-silver">
                    Sent {fmtDate(s.createdAt)}
                    {s.submittedByEmail ? ` by ${s.submittedByEmail}` : ''}
                    {s.decidedAt ? ` · answered ${fmtDate(s.decidedAt)}${s.decidedByEmail ? ` by ${s.decidedByEmail}` : ''}` : ''}
                  </div>
                  {s.feedback && (
                    <p className="mt-2 whitespace-pre-wrap rounded border border-navy-secondary bg-navy-secondary/30 px-2.5 py-1.5 text-sm text-silver">
                      {s.feedback}
                    </p>
                  )}
                  {canManage && s.status === 'PENDING' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="mt-1 -ml-2 text-silver"
                      onClick={() => setWithdrawing(s)}
                    >
                      Withdraw from client
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Offers">
          {offers === null && !error ? (
            <SkeletonRows count={1} />
          ) : !offers?.length ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-silver/70">No offers extended.</p>
              {canExtendOffer && (
                <Button asChild size="sm" variant="outline">
                  <Link
                    to={`/recruiting/extras?tab=offers&new=1&candidate=${candidate.id}`}
                  >
                    <Send className="h-3.5 w-3.5" />
                    Extend offer
                  </Link>
                </Button>
              )}
            </div>
          ) : (
            <ul className="space-y-2">
              {offers.map((o) => (
                <li
                  key={o.id}
                  className="rounded-md border border-navy-secondary bg-navy/60 px-3 py-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm text-white truncate">
                      {o.jobTitle}
                    </span>
                    <Badge variant={OFFER_VARIANT[o.status]}>{statusLabel(o.status)}</Badge>
                  </div>
                  <div className="mt-1 text-xs2 text-silver">
                    {o.clientName} · starts {o.startDate}
                    {o.salary
                      ? ` · ${o.currency} ${o.salary}/yr`
                      : o.hourlyRate
                        ? ` · ${o.currency} ${o.hourlyRate}/hr`
                        : ''}
                  </div>
                  {o.status === 'PENDING_APPROVAL' && o.approvalNote && (
                    <div className="mt-1 text-xs2 text-warning">Held for approval — {o.approvalNote}</div>
                  )}
                  {o.status === 'SENT' && <div className="mt-1 text-xs2 text-silver">Awaiting their signature</div>}
                  {o.signedName && o.signedAt && (
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs2 text-silver">
                      Signed by {o.signedName}, {fmtDate(o.signedAt)}
                      {o.hasSignedPdf && (
                        <a
                          href={signedOfferUrl(o.id)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-gold hover:underline"
                        >
                          Signed letter
                        </a>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Activity">
          <CandidateTimeline
            candidateId={candidate.id}
            canManage={canManage}
            // A stage move made by the page's own buttons lands here too.
            refreshKey={`${candidate.stage}|${candidate.stageChangedAt}|${bump}`}
          />
        </Section>
      </DrawerBody>

      {actions && <DrawerFooter>{actions}</DrawerFooter>}

      {canManage && (
        <>
          <EditCandidateDialog candidate={candidate} open={editing} onOpenChange={setEditing} onSaved={changed} />
          <ScheduleInterviewDialog
            candidate={candidate}
            interview={moving}
            open={scheduling || moving !== null}
            onOpenChange={(o) => {
              if (o) return;
              setScheduling(false);
              setMoving(null);
            }}
            onScheduled={changed}
          />
          <ConfirmDialog
            open={cancelling !== null}
            onOpenChange={(o) => !o && setCancelling(null)}
            title="Cancel this interview?"
            description={
              cancelling
                ? `${fmtDateTime(cancelling.scheduledFor)} — ${candidate.firstName} and the interviewer get a cancellation that takes it out of their calendars.`
                : undefined
            }
            confirmLabel="Cancel interview"
            cancelLabel="Keep it"
            destructive
            busy={cancelBusy}
            onConfirm={cancelInterview}
          />
          <SubmitToClientDialog
            candidate={candidate}
            open={submitting}
            onOpenChange={setSubmitting}
            onSubmitted={changed}
          />
          <ConfirmDialog
            open={withdrawing !== null}
            onOpenChange={(o) => !o && setWithdrawing(null)}
            title={withdrawing ? `Withdraw from ${withdrawing.clientName}?` : 'Withdraw?'}
            description={`${candidate.firstName} comes off their review list. You can put them forward again later.`}
            confirmLabel="Withdraw"
            cancelLabel="Keep it"
            busy={withdrawBusy}
            onConfirm={withdraw}
          />
          <ScoreInterviewDialog
            interview={scoring?.interview ?? null}
            kit={scoring?.kit ?? null}
            onOpenChange={(o) => !o && setScoring(null)}
            onScored={changed}
          />
        </>
      )}
    </Drawer>
  );
}
