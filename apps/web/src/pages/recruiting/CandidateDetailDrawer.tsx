import { useEffect, useState, type ReactNode } from 'react';
import { CalendarClock, FileText, Link2, Mail, Phone } from 'lucide-react';
import type { Candidate, CandidateStage } from '@alto-people/shared';
import { safeHref } from '@alto-people/shared';
import {
  listInterviews,
  listOffers,
  type InterviewRecord,
  type OfferRecord,
} from '@/lib/recruiting90Api';
import { ApiError } from '@/lib/api';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { cn } from '@/lib/cn';
import { AssociateLink } from '@/components/ui/AssociateLink';
import {
  Avatar,
  Badge,
  Drawer,
  DrawerBody,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  ErrorBanner,
  SkeletonRows,
} from '@/components/ui';

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
 */

const STAGE_LABEL: Record<CandidateStage, string> = {
  APPLIED: 'Applied',
  SCREENING: 'Screening',
  INTERVIEW: 'Interview',
  OFFER: 'Offer',
  HIRED: 'Hired',
  WITHDRAWN: 'Withdrawn',
  REJECTED: 'Rejected',
};

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

const SOURCE_LABEL: Record<string, string> = {
  referral: 'Referral',
  'careers-page': 'Careers page',
  indeed: 'Indeed',
  linkedin: 'LinkedIn',
  'walk-in': 'Walk-in',
  agency: 'Agency',
  other: 'Other',
  manual: 'Manual',
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

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-2xs uppercase tracking-widest text-silver">{title}</h3>
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
}) {
  const [interviews, setInterviews] = useState<InterviewRecord[] | null>(null);
  const [offers, setOffers] = useState<OfferRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const candidateId = candidate?.id ?? null;

  useEffect(() => {
    if (!candidateId) return;
    let live = true;
    setInterviews(null);
    setOffers(null);
    setError(null);
    Promise.all([listInterviews(candidateId), listOffers(candidateId)])
      .then(([i, o]) => {
        if (!live) return;
        setInterviews(i.interviews);
        setOffers(o.offers);
      })
      .catch((err) => {
        if (!live) return;
        // A failed history load must not hide the profile — the fields above
        // are already in hand from the list response.
        setError(
          err instanceof ApiError
            ? err.message
            : 'Could not load interviews and offers.',
        );
      });
    return () => {
      live = false;
    };
  }, [candidateId]);

  if (!candidate) return null;

  const fullName = `${candidate.firstName} ${candidate.lastName}`;
  const outcome = candidate.rejectedReason ?? candidate.withdrawnReason;

  return (
    <Drawer open={candidate !== null} onOpenChange={onOpenChange} width="max-w-xl">
      <DrawerHeader>
        <div className="flex items-start gap-3">
          <Avatar name={fullName} email={candidate.email} size="md" />
          <div className="min-w-0">
            <DrawerTitle>{fullName}</DrawerTitle>
            <DrawerDescription>
              {candidate.position ?? 'No position recorded'} · applied{' '}
              {fmtDate(candidate.createdAt)}
            </DrawerDescription>
          </div>
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
          <Section title="Notes">
            <p className="whitespace-pre-wrap text-sm text-silver">
              {candidate.notes}
            </p>
          </Section>
        )}

        {error && <ErrorBanner>{error}</ErrorBanner>}

        <Section title="Interviews">
          {interviews === null && !error ? (
            <SkeletonRows count={2} />
          ) : !interviews?.length ? (
            <p className="text-sm text-silver/70">No interviews scheduled.</p>
          ) : (
            <ul className="space-y-2">
              {interviews.map((i) => (
                <li
                  key={i.id}
                  className="rounded-md border border-navy-secondary bg-navy/60 px-3 py-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.5 text-sm text-white">
                      <CalendarClock className="h-3.5 w-3.5 shrink-0 text-silver" />
                      {fmtDateTime(i.scheduledFor)}
                    </span>
                    {i.rating !== null && (
                      <Badge variant="outline" className="tabular-nums">
                        {i.rating}/5
                      </Badge>
                    )}
                  </div>
                  <div className="mt-1 text-xs2 text-silver">
                    {i.kitName ?? 'No kit'}
                    {i.interviewerEmail ? ` · ${i.interviewerEmail}` : ''}
                    {i.completedAt ? ' · completed' : ' · scheduled'}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Offers">
          {offers === null && !error ? (
            <SkeletonRows count={1} />
          ) : !offers?.length ? (
            <p className="text-sm text-silver/70">No offers extended.</p>
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
                    <Badge variant={OFFER_VARIANT[o.status]}>{o.status}</Badge>
                  </div>
                  <div className="mt-1 text-xs2 text-silver">
                    {o.clientName} · starts {o.startDate}
                    {o.salary
                      ? ` · ${o.currency} ${o.salary}/yr`
                      : o.hourlyRate
                        ? ` · ${o.currency} ${o.hourlyRate}/hr`
                        : ''}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </DrawerBody>

      {actions && <DrawerFooter>{actions}</DrawerFooter>}
    </Drawer>
  );
}
