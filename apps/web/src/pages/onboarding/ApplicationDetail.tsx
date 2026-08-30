import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  Circle,
  ClipboardList,
  Clock,
  Copy,
  Eye,
  FileDown,
  MailCheck,
  MailWarning,
  ExternalLink,
  MinusCircle,
  PartyPopper,
  Send,
  ShieldCheck,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  UserCheck,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  fmtDate,
  fmtMoney,
  fmtRelativeDate,
  fmtWeekdayTz,
  parseYmd,
  ymdLocal,
} from '@/lib/format';
import {
  hasCapability,
  type ApplicationDetail as ApplicationDetailType,
  type AuditLogEntry,
  type ChecklistTask,
  type I9DocumentList,
  type InviteDeliveryInfo,
} from '@alto-people/shared';
import {
  approveApplication,
  compliancePacketUrl,
  getApplication,
  getApplicationAudit,
  getApplicationPolicies,
  getDirectDeposit,
  getProfile,
  getW4,
  nextReviewApplication,
  rejectApplication,
  resendInvite,
  skipTask,
  skipTaskWithReason,
} from '@/lib/onboardingApi';
import {
  getI9Status,
  listI9Documents,
  submitI9Section2,
  type I9DocumentListItem,
} from '@/lib/i9Api';
import {
  autoDetectSection2,
  minDocsForSection2List,
} from '@/pages/compliance/section2Verification';
import { RejectDocumentDialog } from '@/components/RejectDocumentDialog';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { statusTone } from '@/lib/status';
import { ProgressBar } from '@/components/ProgressBar';
import { AuditTimeline } from '@/components/AuditTimeline';
import { DocumentViewer } from '@/components/DocumentViewer';
import { previewDocumentUrl } from '@/lib/documentsApi';
import { Badge } from '@/components/ui/Badge';
import { Breadcrumb } from '@/components/ui/Breadcrumb';
import { Button } from '@/components/ui/Button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { Field } from '@/components/ui/Field';
import { Skeleton } from '@/components/ui/Skeleton';
import { EsignSection } from './EsignSection';
import { cn } from '@/lib/cn';

const EMPLOYMENT_LABEL: Record<string, string> = {
  W2_EMPLOYEE: 'W-2',
  CONTRACTOR_1099_INDIVIDUAL: '1099 (Individual)',
  CONTRACTOR_1099_BUSINESS: '1099 (Business)',
};

const TRACK_LABEL: Record<string, string> = {
  STANDARD: 'Standard',
  J1: 'J-1',
  CLIENT_SPECIFIC: 'Client-specific',
};

const TASK_LABEL: Record<string, string> = {
  PROFILE_INFO: 'Profile information',
  DOCUMENT_UPLOAD: 'Identity documents',
  E_SIGN: 'Document e-signatures',
  BACKGROUND_CHECK: 'Background check',
  W4: 'W-4 tax withholding',
  DIRECT_DEPOSIT: 'Direct deposit',
  POLICY_ACK: 'Policy acknowledgments',
  J1_DOCS: 'J-1 documents',
  I9_VERIFICATION: 'I-9 verification',
};

// Kinds whose skip is a one-click outline button (the historical set).
// Every other kind is skippable too — the API accepts any kind — but the
// remaining ones (profile, W-4, direct deposit, policy acks) carry payroll/
// compliance weight, so their skip is a quiet text affordance behind a
// required-reason dialog instead of an inviting button. Without this a
// 1099 contractor could never reach 100%.
const STUB_KINDS = new Set([
  'DOCUMENT_UPLOAD',
  'E_SIGN',
  'BACKGROUND_CHECK',
  'I9_VERIFICATION',
  'J1_DOCS',
]);

/** Task kinds whose submitted data renders inline in SubmittedDataCard. */
const SUBMITTED_DATA_KINDS = new Set([
  'PROFILE_INFO',
  'W4',
  'DIRECT_DEPOSIT',
  'POLICY_ACK',
]);

const W4_FILING_LABEL: Record<string, string> = {
  SINGLE: 'Single',
  MARRIED_FILING_JOINTLY: 'Married filing jointly',
  HEAD_OF_HOUSEHOLD: 'Head of household',
};

/** Route component — the standalone page. */
export function ApplicationDetail() {
  const { id } = useParams<{ id: string }>();
  return (
    <div className="mx-auto">
      <Breadcrumb
        className="mb-3"
        segments={[
          { label: 'Onboarding', to: '/onboarding' },
          { label: 'Application' },
        ]}
      />
      <ApplicationDetailBody applicationId={id} mode="page" />
    </div>
  );
}

interface ApplicationDetailBodyProps {
  applicationId: string | undefined;
  /**
   * `page` — full bleed, big title, surfaces compliance + resend buttons inline.
   * `drawer` — title is rendered by the parent Drawer header; we just paint
   *            the body. Slightly tighter typographic scale.
   */
  mode: 'page' | 'drawer';
}

/**
 * Phase 72 — extracted body so the same content can render in either the
 * full-page route or inside a Drawer slide-over. Both modes share data
 * loading + skip/resend handlers; they differ only in how the title row
 * is laid out.
 */
export function ApplicationDetailBody({ applicationId, mode }: ApplicationDetailBodyProps) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  // Where the Compliance verifier should send the reviewer back to. The
  // list's slide-over drawer is component state (not URL-synced), so in
  // drawer mode the current URL would reopen the LIST with the drawer
  // closed — link the application's canonical route instead; it restores
  // the same body plus the review-next chain. Page mode keeps the exact
  // location (path + query).
  const returnTo =
    mode === 'drawer' && applicationId
      ? `/onboarding/applications/${applicationId}`
      : `${location.pathname}${location.search}`;
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [approveOpen, setApproveOpen] = useState(false);
  // Non-null once the approve endpoint answered 409 `approval_warnings`.
  // The dialog stays open, lists the gaps, and relabels its confirm button
  // "Approve anyway" (which resubmits with acknowledgeWarnings: true).
  const [approveWarnings, setApproveWarnings] = useState<string[] | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  // In-flight flag for the header's one-click approve (no dialog to own it).
  const [directApproving, setDirectApproving] = useState(false);
  // Task pending the required-reason skip confirmation (sensitive kinds only).
  const [skipTarget, setSkipTarget] = useState<ChecklistTask | null>(null);
  // Ceremony screen surfaced after a successful approval. Captures the
  // hire date so the celebration can show it; cleared when the user
  // dismisses or navigates. The standard toast no longer fires for
  // approvals — the celebration *is* the success surface.
  const [celebration, setCelebration] = useState<{ hireDate: string } | null>(
    null,
  );

  // Capability check (not a hardcoded role list) so every role granted
  // manage:onboarding — HR_ADMINISTRATOR, OPERATIONS_MANAGER, MANAGER,
  // INTERNAL_RECRUITER, WORKFORCE_MANAGER, MARKETING_MANAGER — can
  // approve/reject. Hardcoded role list here used to lock out recruiters.
  const canManage = user ? hasCapability(user.role, 'manage:onboarding') : false;
  // The document reject endpoint (/documents/admin/:id/reject) is gated on
  // manage:documents, not manage:onboarding — mirror it exactly so the
  // affordance never renders for a caller who'd only 403.
  const canRejectDocs = user
    ? hasCapability(user.role, 'manage:documents')
    : false;

  const detailQuery = useQuery({
    queryKey: ['application', applicationId],
    queryFn: () => getApplication(applicationId!),
    enabled: !!applicationId,
  });
  const auditQuery = useQuery({
    queryKey: ['application', applicationId, 'audit'],
    queryFn: async () =>
      (await getApplicationAudit(applicationId!)).entries,
    enabled: !!applicationId && canManage,
  });

  // Hiring-wave assembly line: who's next in the review queue (and how
  // many are waiting) so approving flows straight into the next review
  // instead of a list round-trip.
  const reviewQueueQuery = useQuery({
    queryKey: ['review-queue', applicationId],
    queryFn: () => nextReviewApplication(applicationId ?? undefined),
    enabled: !!applicationId && canManage,
  });
  const queueNext = reviewQueueQuery.data ?? null;

  const detail: ApplicationDetailType | null = detailQuery.data ?? null;
  const audit: AuditLogEntry[] = auditQuery.data ?? [];
  // Prefix-match invalidates ['application', id] AND ['application', id, 'audit'].
  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: ['application', applicationId],
    });
  const setError = setMutationError;
  const error = mutationError
    ? mutationError
    : detailQuery.error
      ? detailQuery.error instanceof ApiError
        ? detailQuery.error.message
        : 'Failed to load.'
      : null;

  if (error) {
    return <ErrorBanner>{error}</ErrorBanner>;
  }

  if (!detail) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-24" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      </div>
    );
  }

  const handleSkip = async (task: ChecklistTask) => {
    try {
      await skipTask(detail.id, task.id);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Skip failed.');
    }
  };

  // Sensitive kinds land here from the required-reason dialog.
  const handleSkipWithReason = async (reason: string) => {
    if (!skipTarget) return;
    try {
      await skipTaskWithReason(detail.id, skipTarget.id, reason);
      setSkipTarget(null);
      await refresh();
    } catch (err) {
      setSkipTarget(null);
      setError(err instanceof ApiError ? err.message : 'Skip failed.');
    }
  };

  const handleResend = async () => {
    try {
      const res = await resendInvite(detail.id);
      if (res.inviteUrl) {
        await navigator.clipboard.writeText(res.inviteUrl).catch(() => {});
        toast.success('Fresh invite link copied.', {
          description: 'Email is stubbed — paste the link in Slack or a manual email.',
          icon: <Copy className="h-4 w-4" />,
        });
      } else {
        toast.success('Fresh invite emailed.');
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === 'user_already_active') {
        toast.message('Invite already accepted.', {
          description: 'This associate has already set their password.',
        });
        return;
      }
      toast.error('Could not resend the invite.', {
        description: err instanceof Error ? err.message : 'Something went wrong.',
      });
    }
  };

  const handleApprove = async (hireDate: string, acknowledgeWarnings: boolean) => {
    try {
      // Widened variable (not a fresh literal) so the extra optional flag is
      // structurally assignable to the client fn's `{ hireDate }` parameter —
      // the API contract (ApproveApplicationInputSchema) accepts it.
      const body: { hireDate: string; acknowledgeWarnings?: boolean } = {
        hireDate,
      };
      if (acknowledgeWarnings) body.acknowledgeWarnings = true;
      await approveApplication(detail.id, body);
      setApproveOpen(false);
      setApproveWarnings(null);
      await refresh();
      void queryClient.invalidateQueries({ queryKey: ['review-queue'] });
      // Skip the toast — open the celebration instead. The "hire is real"
      // moment is the most consequential surface in the onboarding flow
      // and deserves a ceremony, not a passing notification.
      setCelebration({ hireDate });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'approval_warnings') {
        // Not a failure toast — surface the gaps inside the dialog so the
        // admin can read them and either cancel or approve anyway. The
        // one-click header approve lands here with the dialog still closed,
        // so open it too (no-op when the dialog triggered the attempt).
        setApproveWarnings(extractApprovalWarnings(err.details));
        setApproveOpen(true);
        return;
      }
      const msg =
        err instanceof ApiError ? err.message : 'Could not approve.';
      toast.error('Approval failed.', { description: msg });
    }
  };

  const handleReject = async (reason: string | undefined) => {
    if (!reason) return;
    try {
      await rejectApplication(detail.id, { reason });
      toast.success('Application rejected.', {
        icon: <ThumbsDown className="h-4 w-4" />,
      });
      setRejectOpen(false);
      await refresh();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not reject.';
      toast.error('Rejection failed.', { description: msg });
    }
  };

  // One-click approve: only when the record already holds a usable hire
  // date (today or future, LOCAL — same rule as the dialog's prefill). A
  // past start date still needs the dialog so it can't silently become the
  // official hire date that drives I-9/E-Verify deadlines.
  const startYmd = detail.startDate ? detail.startDate.slice(0, 10) : null;
  const directApproveDate =
    startYmd && startYmd >= ymdLocal() ? startYmd : null;

  const handleDirectApprove = async () => {
    if (!directApproveDate || directApproving) return;
    setDirectApproving(true);
    try {
      await handleApprove(directApproveDate, false);
    } finally {
      setDirectApproving(false);
    }
  };

  const counts = detail.tasks.reduce<Record<string, number>>((acc, t) => {
    acc[t.status] = (acc[t.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <>
      {/* Header. In `page` mode this is the H1 + metadata + actions row.
          In `drawer` mode the parent Drawer paints the title, so we drop
          the H1 and keep the metadata + actions below it. */}
      <header className="mb-6">
        {mode === 'page' && (
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="min-w-0">
              <h1 className="font-display text-3xl md:text-4xl text-white mb-2 leading-tight">
                {canManage ? (
                  <Link
                    to={`/people?associateId=${detail.associateId}`}
                    className="hover:text-gold transition-colors"
                    title="Open this associate's profile"
                  >
                    {detail.associateName}
                  </Link>
                ) : (
                  detail.associateName
                )}
              </h1>
              <DetailMeta detail={detail} />
            </div>
            {canManage && (
              <DetailActions
                detail={detail}
                onResend={handleResend}
                onApprove={() => setApproveOpen(true)}
                onReject={() => setRejectOpen(true)}
                directApproveDate={directApproveDate}
                directApproving={directApproving}
                onDirectApprove={handleDirectApprove}
              />
            )}
          </div>
        )}
        {mode === 'drawer' && (
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <DetailMeta detail={detail} />
            {canManage && (
              <DetailActions
                detail={detail}
                onResend={handleResend}
                onApprove={() => setApproveOpen(true)}
                onReject={() => setRejectOpen(true)}
                directApproveDate={directApproveDate}
                directApproving={directApproving}
                onDirectApprove={handleDirectApprove}
                compact
              />
            )}
          </div>
        )}

        {canManage &&
          detail.lastInviteDelivery &&
          detail.status !== 'APPROVED' &&
          detail.status !== 'REJECTED' && (
            <DeliverabilityStrip info={detail.lastInviteDelivery} />
          )}

        {/* Review assembly line: jump straight to the next waiting
            application instead of a list round-trip per hire. */}
        {canManage &&
          (detail.status === 'SUBMITTED' || detail.status === 'IN_REVIEW') &&
          queueNext?.applicationId &&
          queueNext.remaining > 0 && (
            <div className="mt-3 no-print">
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  navigate(`/onboarding/applications/${queueNext.applicationId}`)
                }
                title="Skip to the next application awaiting review (docs-ready ones come first)."
              >
                Review next application → ({queueNext.remaining} more waiting)
              </Button>
            </div>
          )}
      </header>

      <Card className="mb-6 overflow-hidden">
        <CardHeader className="pb-2">
          <div className="flex items-baseline justify-between gap-4">
            <CardTitle className="text-base text-silver/80 uppercase tracking-wider font-sans">
              Checklist progress
            </CardTitle>
            <div
              className={cn(
                'tabular-nums font-display leading-none',
                detail.percentComplete === 100 ? 'text-success' : 'text-gold',
                mode === 'drawer' ? 'text-2xl md:text-3xl' : 'text-3xl md:text-4xl'
              )}
            >
              {detail.percentComplete}%
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-2">
          <ProgressBar percent={detail.percentComplete} hideLabel />
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs2">
            <CountChip
              icon={CheckCircle2}
              label="Done"
              count={(counts.DONE ?? 0) + (counts.SKIPPED ?? 0)}
              total={detail.tasks.length}
              tone="success"
            />
            <CountChip
              icon={Clock}
              label="In progress"
              count={counts.IN_PROGRESS ?? 0}
              total={detail.tasks.length}
              tone="warning"
            />
            <CountChip
              icon={Circle}
              label="Pending"
              count={counts.PENDING ?? 0}
              total={detail.tasks.length}
              tone="silver"
            />
            {(counts.SKIPPED ?? 0) > 0 && (
              <CountChip
                icon={MinusCircle}
                label="Skipped"
                count={counts.SKIPPED ?? 0}
                total={detail.tasks.length}
                tone="silver"
              />
            )}
          </div>
        </CardContent>
      </Card>

      <section
        className={cn(
          'grid grid-cols-1 gap-3 mb-8',
          mode === 'drawer' ? '' : 'md:grid-cols-2'
        )}
      >
        {detail.tasks.map((t) => (
          <TaskTile
            key={t.id}
            task={t}
            canSkip={canManage}
            // Payroll/compliance kinds detour through the required-reason
            // confirmation; the historical stub kinds keep one-click skip.
            quietSkip={!STUB_KINDS.has(t.kind)}
            onSkip={() =>
              STUB_KINDS.has(t.kind) ? void handleSkip(t) : setSkipTarget(t)
            }
            // Destinations are admin surfaces (People directory, Compliance)
            // that invite-scoped roles can't open — no dead links for them.
            destination={
              canManage
                ? taskDestination(t.kind, detail.associateId, returnTo)
                : null
            }
          />
        ))}
      </section>

      {/* Submitted W-4 / direct deposit / policy-ack / profile data, inline.
          These endpoints are gated exactly like the I-9 card below (manage
          scope via assertCanModifyApplication) — same reason for canManage. */}
      {canManage &&
        detail.tasks.some((t) => SUBMITTED_DATA_KINDS.has(t.kind)) && (
          <section className="mb-6">
            <SubmittedDataCard detail={detail} mode={mode} />
          </section>
        )}

      {/* I-9 Section 1 data and the uploaded identity documents behind it are
          HR-only — invite-scoped roles (SHIFT_SUPERVISOR) see checklist
          progress, never the documents. The API enforces the same boundary in
          assertCanModifyApplication; this just avoids rendering a card that
          would only 403. */}
      {canManage && detail.tasks.some((t) => t.kind === 'I9_VERIFICATION') && (
        <section className="mb-6">
          <I9Card
            applicationId={detail.id}
            startDate={detail.startDate}
            associateId={detail.associateId}
            canVerify={canManage}
            canReject={canRejectDocs}
            returnTo={returnTo}
          />
        </section>
      )}

      {/* Same reasoning — EsignSection loads signed agreement bodies on mount,
          which are now gated server-side. */}
      {canManage && (
        <section className="mb-6">
          <EsignSection
            applicationId={detail.id}
            canManage={canManage}
            esignTasks={detail.tasks.filter((t) => t.kind === 'E_SIGN')}
            associateId={detail.associateId}
          />
        </section>
      )}

      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle>Activity</CardTitle>
          </CardHeader>
          <CardContent>
            <AuditTimeline entries={audit} />
          </CardContent>
        </Card>
      )}

      {mode === 'drawer' && (
        <div className="mt-4">
          <Link
            to={`/onboarding/applications/${detail.id}`}
            className="text-sm text-silver hover:text-gold underline-offset-4 hover:underline"
          >
            Open full page →
          </Link>
        </div>
      )}

      <ApproveDialog
        open={approveOpen}
        onOpenChange={(o) => {
          setApproveOpen(o);
          // Cancel / close discards the warning state — reopening starts a
          // fresh attempt (the server re-checks and re-issues if still true).
          if (!o) setApproveWarnings(null);
        }}
        defaultDate={detail.startDate ? detail.startDate.slice(0, 10) : null}
        warnings={approveWarnings}
        onConfirm={handleApprove}
      />
      <ApprovedCelebration
        open={celebration !== null}
        onOpenChange={(o) => !o && setCelebration(null)}
        nextInQueue={
          queueNext?.applicationId && queueNext.remaining > 0 ? queueNext : null
        }
        associateName={detail.associateName}
        clientName={detail.clientName}
        position={detail.position}
        hireDate={celebration?.hireDate ?? ''}
        applicationId={detail.id}
        completedTasks={detail.tasks.filter((t) => t.status === 'DONE').length}
        totalTasks={detail.tasks.length}
      />
      <ConfirmDialog
        open={rejectOpen}
        onOpenChange={setRejectOpen}
        title="Reject application"
        description={`Reject ${detail.associateName}'s onboarding? They can be re-considered later via a new application.`}
        confirmLabel="Reject"
        destructive
        requireReason
        reasonLabel="Reason (saved to audit log)"
        reasonPlaceholder="e.g. Failed background check, withdrew, role no longer available"
        onConfirm={handleReject}
      />
      <ConfirmDialog
        open={skipTarget !== null}
        onOpenChange={(o) => !o && setSkipTarget(null)}
        title="Skip task"
        description={
          skipTarget
            ? `Skip "${TASK_LABEL[skipTarget.kind] ?? skipTarget.title}" for ${detail.associateName}? The checklist counts it as complete without any input from them.`
            : undefined
        }
        confirmLabel="Skip task"
        requireReason
        reasonLabel="Reason"
        reasonPlaceholder="e.g. 1099 contractor — W-4 withholding not applicable"
        onConfirm={handleSkipWithReason}
      />
    </>
  );
}

function DetailMeta({ detail }: { detail: ApplicationDetailType }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-silver text-sm">
      <span className="text-white">{detail.clientName}</span>
      {detail.position && (
        <>
          <span className="text-silver/70">·</span>
          <span>{detail.position}</span>
        </>
      )}
      {detail.startDate && (
        <>
          <span className="text-silver/70">·</span>
          <span>
            Starts{' '}
            <span className="text-white">{fmtDateLabel(detail.startDate)}</span>
          </span>
        </>
      )}
      <Badge variant="outline" className="text-2xs">
        {TRACK_LABEL[detail.onboardingTrack] ?? detail.onboardingTrack} track
      </Badge>
      <Badge
        variant={detail.employmentType === 'W2_EMPLOYEE' ? 'default' : 'accent'}
      >
        {EMPLOYMENT_LABEL[detail.employmentType] ?? detail.employmentType}
      </Badge>
      {detail.updatedAfterSubmitAt &&
        (detail.status === 'SUBMITTED' || detail.status === 'IN_REVIEW') && (
          <Badge
            variant="pending"
            title="The applicant changed their information after submitting — review the latest data before approving."
          >
            Updated after submission
          </Badge>
        )}
    </div>
  );
}

function DetailActions({
  detail,
  onResend,
  onApprove,
  onReject,
  directApproveDate,
  directApproving,
  onDirectApprove,
  compact,
}: {
  detail: ApplicationDetailType;
  onResend: () => void;
  /** Opens the hire-date dialog (also the fallback when no usable date). */
  onApprove: () => void;
  onReject: () => void;
  /** YYYY-MM-DD when the record's start date is today-or-future — enables
   *  the one-click approve; null falls back to the dialog. */
  directApproveDate: string | null;
  directApproving: boolean;
  onDirectApprove: () => void;
  compact?: boolean;
}) {
  // Approve / Reject only shown while the application is still under review.
  // After APPROVED or REJECTED the buttons disappear — the API also rejects
  // re-decisions with 409, but hiding them avoids a confusing dead button.
  // Approve also requires the checklist at 100%.
  const decided = detail.status === 'APPROVED' || detail.status === 'REJECTED';
  // Checklist-less applications (pre-fix CSV migrations, legacy rows) have
  // nothing to complete — the API lets them through to the approve-anyway
  // warning flow, so the button must not dead-end at a permanent 0%.
  const checklistComplete =
    detail.tasks.length === 0 || detail.percentComplete === 100;

  return (
    <div className="flex flex-wrap gap-2 shrink-0">
      <a
        href={`${compliancePacketUrl(detail.id)}?inline=1`}
        target="_blank"
        rel="noreferrer"
        className={cn(
          'inline-flex items-center gap-2 px-3 text-sm rounded-md border border-navy-secondary bg-navy-secondary/40 text-white hover:border-gold/60 hover:text-gold transition-colors',
          compact ? 'h-8' : 'h-9'
        )}
        title="View the audit packet in the browser"
      >
        <Eye className="h-4 w-4" />
        {compact ? 'View' : 'View packet'}
      </a>
      <a
        href={compliancePacketUrl(detail.id)}
        download={`compliance-packet-${detail.associateName.replace(/\s+/g, '-').toLowerCase()}.pdf`}
        className={cn(
          'inline-flex items-center gap-2 px-3 text-sm rounded-md border border-navy-secondary bg-navy-secondary/40 text-white hover:border-gold/60 hover:text-gold transition-colors',
          compact ? 'h-8' : 'h-9'
        )}
        title="Download single-PDF audit packet for this application"
      >
        <FileDown className="h-4 w-4" />
        {compact ? 'Packet' : 'Download'}
      </a>
      {!decided && (
        <Button asChild variant="secondary" size="sm">
          <Link
            to={`/onboarding/in-person/${detail.id}`}
            title="Onboard with the associate physically present — scan IDs from the laptop webcam"
          >
            <UserCheck className="h-4 w-4" />
            {compact ? 'In person' : 'Onboard in person'}
          </Link>
        </Button>
      )}
      {!decided && (
        <Button variant="outline" size="sm" onClick={onResend}>
          <Send className="h-4 w-4" />
          Resend invite
        </Button>
      )}
      {!decided && (
        <Button
          variant="outline"
          size="sm"
          onClick={onReject}
          className="text-alert hover:text-alert"
        >
          <ThumbsDown className="h-4 w-4" />
          Reject
        </Button>
      )}
      {/* One-click approve when the record already holds a usable start
          date: the primary button submits directly with that date, and the
          small calendar button beside it opens the old dialog to change it.
          No usable date → the primary button IS the dialog path. */}
      {!decided && directApproveDate && (
        <Button
          variant="outline"
          size="sm"
          onClick={onApprove}
          disabled={!checklistComplete || directApproving}
          className="px-2"
          aria-label="Approve with a different hire date"
          title="Change the hire date before approving"
        >
          <CalendarDays className="h-4 w-4" />
        </Button>
      )}
      {!decided && (
        <Button
          size="sm"
          onClick={directApproveDate ? onDirectApprove : onApprove}
          loading={directApproving}
          disabled={!checklistComplete}
          title={
            checklistComplete
              ? directApproveDate
                ? 'Approve now with the start date already on file'
                : undefined
              : 'Checklist must be 100% before approving'
          }
        >
          <ThumbsUp className="h-4 w-4" />
          {directApproveDate
            ? `Approve · starts ${fmtDateLabel(directApproveDate)}`
            : 'Approve'}
        </Button>
      )}
    </div>
  );
}

/**
 * Best-effort extraction of `details.warnings: string[]` from the 409
 * `approval_warnings` error envelope. Falls back to a generic line so the
 * dialog never shows an empty alert box if the payload shape drifts.
 */
function extractApprovalWarnings(details: unknown): string[] {
  if (details && typeof details === 'object' && 'warnings' in details) {
    const w = (details as { warnings?: unknown }).warnings;
    if (Array.isArray(w)) {
      const lines = w.filter((x): x is string => typeof x === 'string');
      if (lines.length > 0) return lines;
    }
  }
  return ['This application has unresolved verification gaps.'];
}

function ApproveDialog({
  open,
  onOpenChange,
  defaultDate,
  warnings,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultDate: string | null;
  /** Non-null after a 409 `approval_warnings` — switches the dialog into
   *  "Approve anyway" mode. */
  warnings: string[] | null;
  onConfirm: (hireDate: string, acknowledgeWarnings: boolean) => Promise<void>;
}) {
  // LOCAL today — the UTC slice prefilled tomorrow's date as the official
  // hire date for anyone approving after ~5-8pm west of UTC, and the hire
  // date drives I-9/E-Verify deadlines downstream.
  const today = ymdLocal();
  const [hireDate, setHireDate] = useState(defaultDate ?? today);
  const [submitting, setSubmitting] = useState(false);

  // Re-seed when the dialog re-opens for a different application or after
  // the parent's defaultDate changes (e.g. picked a new application).
  useEffect(() => {
    if (open) setHireDate(defaultDate ?? today);
  }, [open, defaultDate, today]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting || !hireDate) return;
    setSubmitting(true);
    try {
      // Once warnings are on screen, resubmitting means the admin has read
      // and accepted them.
      await onConfirm(hireDate, warnings !== null);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Approve onboarding</DialogTitle>
          <DialogDescription>
            This activates the associate's account and stamps their hire date.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <Field label="Hire date" required>
            {(p) => (
              <Input
                type="date"
                value={hireDate}
                onChange={(e) => setHireDate(e.target.value)}
                {...p}
              />
            )}
          </Field>
          {warnings && (
            <div
              role="alert"
              className="rounded-md border border-alert/40 bg-alert/[0.07] px-3 py-2.5 text-sm"
            >
              <div className="flex items-center gap-2 text-alert font-medium">
                <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
                Verification gaps found
              </div>
              <ul className="mt-1.5 space-y-1 text-xs text-alert/90 list-disc pl-5">
                {warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
              <p className="mt-1.5 text-xs text-silver leading-relaxed">
                Cancel to resolve these first, or approve anyway to activate
                the hire despite them.
              </p>
            </div>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" loading={submitting} disabled={!hireDate}>
              <ThumbsUp className="h-4 w-4" />
              {warnings ? 'Approve anyway' : 'Approve'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ===== ApprovedCelebration ================================================= */

/**
 * The post-approval ceremony.
 *
 * The moment a hire becomes real is the highest-stakes surface in the
 * onboarding flow — peers (Rippling, Workday) treat it as a celebration,
 * not a state change. This dialog replaces the previous "Application
 * approved" toast with a full-width modal:
 *
 *   - Candidate name in font-display at hero scale
 *   - Success-tinted left rail and a PartyPopper glyph
 *   - Hire date + position + client confirmation
 *   - Onboarding checklist progress recap
 *   - Two CTAs: "View checklist" (secondary) and "Back to applications"
 *     (primary). The welcome email is already triggered server-side on
 *     approval; the buttons direct the admin to the next surface.
 */
function ApprovedCelebration({
  open,
  onOpenChange,
  associateName,
  clientName,
  position,
  hireDate,
  applicationId,
  completedTasks,
  totalTasks,
  nextInQueue = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  associateName: string;
  clientName: string;
  position: string | null;
  hireDate: string;
  applicationId: string;
  completedTasks: number;
  totalTasks: number;
  /** Next application awaiting review — powers the assembly-line button. */
  nextInQueue?: { applicationId: string | null; remaining: number } | null;
}) {
  const navigate = useNavigate();
  // parseYmd → local midnight, so the label can't shift a day across
  // timezones; weekday + fmtDate keeps the ceremony copy on-system.
  const hireDateParsed = hireDate ? parseYmd(hireDate.slice(0, 10)) : null;
  const hireDateLabel = hireDateParsed
    ? `${fmtWeekdayTz(hireDateParsed)}, ${fmtDate(hireDateParsed)}`
    : '';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl p-0 overflow-hidden">
        <div className="relative border-l-2 border-l-success/70 bg-gradient-to-br from-success/[0.08] via-navy to-navy p-8 md:p-10">
          <div
            aria-hidden="true"
            className="absolute -top-8 -right-8 h-32 w-32 rounded-full bg-success/15 blur-2xl"
          />
          <div className="relative">
            <div className="inline-flex items-center gap-2 text-2xs uppercase tracking-widest text-success">
              <PartyPopper className="h-3 w-3" aria-hidden="true" />
              Hired
            </div>
            <h2 className="font-display text-3xl md:text-5xl text-white mt-3 leading-[1.05] tracking-tight">
              Welcome, <span className="text-gold-bright">{associateName}</span>.
            </h2>
            <p className="text-silver mt-3 text-sm md:text-base max-w-prose leading-relaxed">
              {position ? `${position} at ${clientName}` : clientName}
              {hireDateLabel && (
                <>
                  {' · '}
                  <span className="text-white">Starts {hireDateLabel}</span>
                </>
              )}
              . Their account is active and the welcome email is on its way.
            </p>

            <div className="mt-6 rounded-md border border-navy-secondary bg-navy/60 p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="text-2xs uppercase tracking-widest text-silver">
                  Onboarding checklist
                </div>
                <div className="text-xs text-silver tabular-nums">
                  <span className="text-white">{completedTasks}</span>
                  {' / '}
                  {totalTasks} complete
                </div>
              </div>
              <div className="mt-2 h-1.5 rounded-full bg-navy-secondary overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-success to-gold transition-all"
                  style={{
                    width: `${
                      totalTasks > 0
                        ? Math.round((completedTasks / totalTasks) * 100)
                        : 0
                    }%`,
                  }}
                />
              </div>
              <p className="text-xs text-silver mt-2 leading-relaxed">
                They'll work through the remaining tasks at their own pace.
                You'll see I-9 Section 2 in your queue when they finish
                Section 1.
              </p>
            </div>

            <div className="mt-7 flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
              <Button
                variant="secondary"
                onClick={() => {
                  onOpenChange(false);
                  navigate(`/onboarding/applications/${applicationId}`);
                }}
              >
                <Sparkles className="h-4 w-4" />
                Review checklist
              </Button>
              {nextInQueue?.applicationId ? (
                <Button
                  size="lg"
                  onClick={() => {
                    onOpenChange(false);
                    navigate(`/onboarding/applications/${nextInQueue.applicationId}`);
                  }}
                >
                  Review next ({nextInQueue.remaining} left) →
                </Button>
              ) : (
                <Button
                  size="lg"
                  onClick={() => {
                    onOpenChange(false);
                    navigate('/onboarding');
                  }}
                >
                  Back to applications
                </Button>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ===== Subcomponents ====================================================== */

function CountChip({
  icon: Icon,
  label,
  count,
  total: _total,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  count: number;
  total: number;
  tone: 'success' | 'warning' | 'silver';
}) {
  if (count === 0 && tone === 'silver') return null;
  const cx =
    tone === 'success'
      ? 'text-success'
      : tone === 'warning'
        ? 'text-warning'
        : 'text-silver';
  return (
    <span className={cn('inline-flex items-center gap-1.5', cx)}>
      <Icon className="h-3.5 w-3.5" />
      <span className="tabular-nums font-medium">{count}</span>
      <span className="text-silver/70 uppercase tracking-wider">{label}</span>
    </span>
  );
}

interface TaskTileProps {
  task: ChecklistTask;
  canSkip: boolean;
  /** Payroll/compliance kinds: render the skip as a subdued text affordance
   *  (reason-gated by the parent) instead of the inviting outline button. */
  quietSkip: boolean;
  onSkip: () => void;
  /** Deep link to where this task's full record lives (null = no link). */
  destination: { to: string; label: string } | null;
}

const STATUS_TONE: Record<
  string,
  {
    bg: string;
    border: string;
    iconCx: string;
    icon: React.ComponentType<{ className?: string }>;
    badgeBg: string;
    badgeText: string;
    label: string;
  }
> = {
  DONE: {
    bg: 'bg-success/[0.04]',
    border: 'border-success/40 hover:border-success/70',
    iconCx: 'text-success',
    icon: CheckCircle2,
    badgeBg: 'bg-success/15',
    badgeText: 'text-success',
    label: 'Done',
  },
  SKIPPED: {
    bg: 'bg-navy',
    border: 'border-silver/30 hover:border-silver/50',
    iconCx: 'text-silver',
    icon: MinusCircle,
    badgeBg: 'bg-silver/15',
    badgeText: 'text-silver',
    label: 'Skipped',
  },
  IN_PROGRESS: {
    bg: 'bg-warning/[0.06]',
    border: 'border-warning/40 hover:border-warning/70',
    iconCx: 'text-warning',
    icon: Clock,
    badgeBg: 'bg-warning/15',
    badgeText: 'text-warning',
    label: 'In progress',
  },
  PENDING: {
    bg: 'bg-navy',
    border: 'border-navy-secondary hover:border-silver/40',
    iconCx: 'text-silver/70',
    icon: Circle,
    badgeBg: 'bg-silver/10',
    badgeText: 'text-silver',
    label: 'Pending',
  },
  BLOCKED: {
    bg: 'bg-alert/[0.06]',
    border: 'border-alert/40 hover:border-alert/70',
    iconCx: 'text-alert',
    icon: Circle,
    badgeBg: 'bg-alert/15',
    badgeText: 'text-alert',
    label: 'Blocked',
  },
};

/**
 * Deep link into the Compliance Section 2 verifier for one associate.
 * `returnTo` (this page's path + query) rides along as ?return= so the
 * verifier can send the reviewer straight back after verifying — leaving
 * for /compliance used to strand them there mid-review-chain.
 */
function i9VerifierHref(associateId: string, returnTo?: string): string {
  return `/compliance?tab=i9&associateId=${associateId}${
    returnTo ? `&return=${encodeURIComponent(returnTo)}` : ''
  }`;
}

/**
 * Where each checklist task's FULL record lives. The tiles used to be dead
 * ends — seeing the I-9 meant menu → Compliance → I-9 → find the person
 * again. Every destination is a deep link that lands with the person open.
 */
function taskDestination(
  kind: string,
  associateId: string,
  /** When set, the I-9 verifier gets a ?return= back to this page. */
  returnTo?: string,
): { to: string; label: string } | null {
  switch (kind) {
    case 'PROFILE_INFO':
    case 'DIRECT_DEPOSIT':
      return { to: `/people?associateId=${associateId}`, label: 'Open profile' };
    case 'DOCUMENT_UPLOAD':
    case 'W4':
    case 'POLICY_ACK':
    case 'E_SIGN':
      return {
        to: `/people?associateId=${associateId}&tab=documents`,
        label: 'Open document vault',
      };
    case 'I9_VERIFICATION':
      return {
        to: i9VerifierHref(associateId, returnTo),
        label: 'Open I-9 in Compliance',
      };
    case 'BACKGROUND_CHECK':
      return {
        to: `/compliance?tab=background&associateId=${associateId}`,
        label: 'Open background checks',
      };
    case 'J1_DOCS':
      return {
        to: `/compliance?tab=j1&associateId=${associateId}`,
        label: 'Open J-1 program',
      };
    default:
      return null;
  }
}

function TaskTile({ task, canSkip, quietSkip, onSkip, destination }: TaskTileProps) {
  const tone = STATUS_TONE[task.status] ?? STATUS_TONE.PENDING;
  const Icon = tone.icon;
  const isComplete = task.status === 'DONE' || task.status === 'SKIPPED';

  return (
    <div
      className={cn(
        'group rounded-lg border p-4 transition-colors',
        tone.bg,
        tone.border
      )}
    >
      <div className="flex items-start gap-3">
        <Icon className={cn('h-5 w-5 mt-0.5 shrink-0', tone.iconCx)} aria-hidden />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="font-medium text-white truncate">
              {TASK_LABEL[task.kind] ?? task.title}
            </div>
            <span
              className={cn(
                'text-2xs uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0',
                tone.badgeBg,
                tone.badgeText
              )}
              data-status={task.status}
            >
              {tone.label}
            </span>
          </div>
          {task.description && (
            <div className="text-xs text-silver mt-1 line-clamp-2">
              {task.description}
            </div>
          )}
          {destination && (
            <Link
              to={destination.to}
              className="mt-2 inline-flex items-center gap-1 text-xs text-gold hover:underline"
            >
              {destination.label}
              <ExternalLink className="h-3 w-3" aria-hidden />
            </Link>
          )}
        </div>
        {canSkip && !isComplete && (
          quietSkip ? (
            // Deliberately understated: skipping W-4 / deposit / policy /
            // profile is legitimate (1099 contractors) but shouldn't read
            // as a casual shortcut. The trailing ellipsis signals the
            // required-reason dialog behind it.
            <button
              type="button"
              onClick={onSkip}
              className="shrink-0 self-start text-xs text-silver/60 hover:text-silver underline-offset-4 hover:underline transition-colors"
              title="Mark not applicable — requires a reason"
            >
              Skip…
            </button>
          ) : (
            <Button size="sm" variant="outline" onClick={onSkip} className="shrink-0">
              Skip
            </Button>
          )
        )}
      </div>
    </div>
  );
}

/* ===== Submitted data card ================================================ */

/**
 * Read-only inline view of what the associate actually submitted for the
 * W-4, direct deposit, policy-ack and profile tasks. Reviewing these used
 * to mean leaving the drawer for the People directory / document vault
 * (~6 clicks + 2 page loads per application), which also destroyed the
 * review-next chain. Everything shown here is exactly what the four GET
 * endpoints already return to this caller — no additional PII.
 */
function SubmittedDataCard({
  detail,
  mode,
}: {
  detail: ApplicationDetailType;
  mode: 'page' | 'drawer';
}) {
  const id = detail.id;
  const kinds = new Set(detail.tasks.map((t) => t.kind));

  // Keyed under ['application', id, …] so the parent's prefix-match
  // invalidation (after skip/approve) refreshes these too. retry: false —
  // a 403/404 answer is an answer, not a flake.
  const profileQuery = useQuery({
    queryKey: ['application', id, 'submitted', 'profile'],
    queryFn: () => getProfile(id),
    enabled: kinds.has('PROFILE_INFO'),
    retry: false,
  });
  const w4Query = useQuery({
    queryKey: ['application', id, 'submitted', 'w4'],
    queryFn: () => getW4(id),
    enabled: kinds.has('W4'),
    retry: false,
  });
  const depositQuery = useQuery({
    queryKey: ['application', id, 'submitted', 'direct-deposit'],
    queryFn: () => getDirectDeposit(id),
    enabled: kinds.has('DIRECT_DEPOSIT'),
    retry: false,
  });
  const policiesQuery = useQuery({
    queryKey: ['application', id, 'submitted', 'policies'],
    queryFn: async () => (await getApplicationPolicies(id)).policies,
    enabled: kinds.has('POLICY_ACK'),
    retry: false,
  });

  const w4 = w4Query.data ?? null;
  const deposit = depositQuery.data ?? null;
  const profile = profileQuery.data ?? null;
  const policies = policiesQuery.data ?? [];
  const ackedCount = policies.filter((p) => p.acknowledged).length;
  const profileEmpty =
    !!profile && !profile.dob && !profile.phone && !profile.addressLine1;
  const addressLine = profile
    ? [
        profile.addressLine1,
        profile.addressLine2,
        profile.city,
        [profile.state, profile.zip].filter(Boolean).join(' '),
      ]
        .filter(Boolean)
        .join(', ')
    : '';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ClipboardList className="h-4 w-4 text-gold" aria-hidden />
          Submitted data
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div
          className={cn(
            'grid grid-cols-1 gap-x-8 gap-y-5',
            mode === 'drawer' ? '' : 'md:grid-cols-2'
          )}
        >
          {kinds.has('W4') && (
            <SubmittedSection
              title="W-4 tax withholding"
              link={taskDestination('W4', detail.associateId)}
            >
              {w4Query.isPending ? (
                <SectionSkeleton />
              ) : w4Query.isError ? (
                <SectionError error={w4Query.error} />
              ) : !w4?.hasSubmission ? (
                <NotSubmitted />
              ) : (
                <>
                  <DataRow
                    label="Filing status"
                    value={
                      w4.filingStatus
                        ? W4_FILING_LABEL[w4.filingStatus] ?? w4.filingStatus
                        : '—'
                    }
                  />
                  <DataRow label="Dependents" value={fmtMoney(w4.dependentsAmount)} />
                  <DataRow
                    label="Extra withholding"
                    value={fmtMoney(w4.extraWithholding)}
                  />
                  <DataRow
                    label="SSN"
                    value={
                      <span className="inline-flex items-center gap-2 flex-wrap">
                        <span className="tabular-nums">
                          {w4.ssnLast4 ? `•••-••-${w4.ssnLast4}` : '—'}
                        </span>
                        {w4.hasSsnCardOnFile ? (
                          <span className="inline-flex items-center gap-1 text-xs text-success">
                            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                            Card on file
                          </span>
                        ) : (
                          <span className="text-xs text-silver">No card on file</span>
                        )}
                      </span>
                    }
                  />
                  <DataRow label="Submitted" value={fmtDate(w4.submittedAt)} />
                </>
              )}
            </SubmittedSection>
          )}

          {kinds.has('DIRECT_DEPOSIT') && (
            <SubmittedSection
              title="Direct deposit"
              link={taskDestination('DIRECT_DEPOSIT', detail.associateId)}
            >
              {depositQuery.isPending ? (
                <SectionSkeleton />
              ) : depositQuery.isError ? (
                <SectionError error={depositQuery.error} />
              ) : !deposit?.hasPayoutMethod ? (
                <NotSubmitted />
              ) : deposit.type === 'BRANCH_CARD' ? (
                <>
                  <DataRow label="Method" value="Branch pay card" />
                  <DataRow
                    label="Verified"
                    value={
                      deposit.verifiedAt ? (
                        fmtDate(deposit.verifiedAt)
                      ) : (
                        <span className="text-warning">Not verified</span>
                      )
                    }
                  />
                </>
              ) : (
                <>
                  <DataRow label="Bank" value={deposit.bankName ?? '—'} />
                  <DataRow
                    label="Account type"
                    value={
                      deposit.accountType === 'SAVINGS'
                        ? 'Savings'
                        : deposit.accountType === 'CHECKING'
                          ? 'Checking'
                          : '—'
                    }
                  />
                  <DataRow
                    label="Routing"
                    value={
                      <span className="tabular-nums">
                        {deposit.routingMasked ?? '—'}
                      </span>
                    }
                  />
                  <DataRow
                    label="Account"
                    value={
                      <span className="tabular-nums">
                        {deposit.accountLast4 ? `••••${deposit.accountLast4}` : '—'}
                      </span>
                    }
                  />
                  <DataRow
                    label="Verified"
                    value={
                      deposit.verifiedAt ? (
                        fmtDate(deposit.verifiedAt)
                      ) : (
                        <span className="text-warning">Not verified</span>
                      )
                    }
                  />
                </>
              )}
            </SubmittedSection>
          )}

          {kinds.has('POLICY_ACK') && (
            <SubmittedSection
              title="Policy acknowledgments"
              link={taskDestination('POLICY_ACK', detail.associateId)}
            >
              {policiesQuery.isPending ? (
                <SectionSkeleton />
              ) : policiesQuery.isError ? (
                <SectionError error={policiesQuery.error} />
              ) : policies.length === 0 ? (
                <div className="text-sm text-silver">No policies assigned</div>
              ) : (
                <details>
                  <summary
                    className={cn(
                      'cursor-pointer list-none text-sm tabular-nums select-none',
                      'text-white hover:text-gold transition-colors',
                      '[&::-webkit-details-marker]:hidden'
                    )}
                  >
                    {ackedCount} of {policies.length} acknowledged{' '}
                    <span className="text-xs text-silver">(show list)</span>
                  </summary>
                  <ul className="mt-2 space-y-1">
                    {policies.map((p) => (
                      <li key={p.id} className="flex items-start gap-2 text-xs">
                        {p.acknowledged ? (
                          <CheckCircle2
                            className="h-3.5 w-3.5 mt-0.5 shrink-0 text-success"
                            aria-hidden
                          />
                        ) : (
                          <Circle
                            className="h-3.5 w-3.5 mt-0.5 shrink-0 text-silver/70"
                            aria-hidden
                          />
                        )}
                        <span className="text-white min-w-0 truncate">{p.title}</span>
                        {p.acknowledgedAt && (
                          <span className="text-silver shrink-0">
                            {fmtDate(p.acknowledgedAt)}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </SubmittedSection>
          )}

          {kinds.has('PROFILE_INFO') && (
            <SubmittedSection
              title="Profile"
              link={taskDestination('PROFILE_INFO', detail.associateId)}
            >
              {profileQuery.isPending ? (
                <SectionSkeleton />
              ) : profileQuery.isError ? (
                <SectionError error={profileQuery.error} />
              ) : profileEmpty ? (
                <NotSubmitted />
              ) : (
                <>
                  <DataRow
                    label="Date of birth"
                    value={profile?.dob ? fmtDateLabel(profile.dob) : '—'}
                  />
                  <DataRow label="Phone" value={profile?.phone ?? '—'} />
                  <DataRow label="Address" value={addressLine || '—'} />
                </>
              )}
            </SubmittedSection>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function SubmittedSection({
  title,
  link,
  children,
}: {
  title: string;
  /** Deep link to the full record (small "open full record" affordance). */
  link: { to: string; label: string } | null;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="text-2xs uppercase tracking-widest text-silver">
          {title}
        </div>
        {link && (
          <Link
            to={link.to}
            className="inline-flex items-center gap-1 text-xs text-gold hover:underline shrink-0"
          >
            {link.label}
            <ExternalLink className="h-3 w-3" aria-hidden />
          </Link>
        )}
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function DataRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 text-sm">
      <div className="w-32 shrink-0 text-xs text-silver pt-0.5">{label}</div>
      <div className="flex-1 min-w-0 text-white break-words">{value}</div>
    </div>
  );
}

function SectionSkeleton() {
  return (
    <div className="space-y-2">
      <Skeleton className="h-4 w-40" />
      <Skeleton className="h-4 w-52" />
      <Skeleton className="h-4 w-32" />
    </div>
  );
}

function NotSubmitted() {
  return <div className="text-sm text-silver">Not submitted yet</div>;
}

/** 403/404 read as "nothing to show yet"; anything else is a real failure. */
function SectionError({ error }: { error: unknown }) {
  if (
    error instanceof ApiError &&
    (error.status === 404 || error.status === 403)
  ) {
    return <NotSubmitted />;
  }
  return <div className="text-sm text-alert">Couldn't load.</div>;
}

/* ===== I-9 employment verification card =================================== */

/** Parse the date part of an ISO string as local midnight (avoids the UTC
 *  off-by-one you get from `new Date('YYYY-MM-DD')`). */
function parseDateOnly(iso: string): Date {
  return new Date(`${iso.slice(0, 10)}T00:00:00`);
}

function fmtDateLabel(iso: string | Date): string {
  // Date-only strings parse at LOCAL midnight first so the label can't
  // shift a day across timezones; fmtDate keeps rendering consistent.
  const d = typeof iso === 'string' ? parseDateOnly(iso) : iso;
  return fmtDate(d);
}

/** Federal I-9 rule: Section 2 is due within 3 business days (Mon–Fri) of
 *  the start date. Holidays are not modeled — matches the server. */
function addBusinessDays(start: Date, days: number): Date {
  const d = new Date(start);
  let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) added += 1;
  }
  return d;
}

// Tones come from the shared status vocabulary (PENDING now reads amber like
// every other awaiting state). Only the wording is local: UPLOADED means
// "someone must review this", so it reads "Awaiting review".
const I9_DOC_STATUS_LABEL: Record<I9DocumentListItem['status'], string> = {
  VERIFIED: 'Verified',
  UPLOADED: 'Awaiting review',
  PENDING: 'Pending',
  REJECTED: 'Rejected',
  EXPIRED: 'Expired',
};

const I9_DOC_KIND_LABEL: Record<string, string> = {
  ID: 'Photo ID',
  SSN_CARD: 'Social Security card',
  I9_SUPPORTING: 'I-9 supporting document',
  J1_VISA: 'J-1 visa',
  J1_DS2019: 'DS-2019',
};

function I9StepIcon({ done }: { done: boolean }) {
  return done ? (
    <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0 text-success" aria-hidden />
  ) : (
    <Circle className="h-4 w-4 mt-0.5 shrink-0 text-silver/70" aria-hidden />
  );
}

function I9Card({
  applicationId,
  startDate,
  associateId,
  canVerify,
  canReject,
  returnTo,
}: {
  applicationId: string;
  startDate: string | null;
  /** Powers the "Open in Compliance" deep link to this person's I-9. */
  associateId: string;
  /** manage:onboarding — the capability the Section 2 verify endpoint
   *  (POST /onboarding/applications/:id/i9/section2) requires. */
  canVerify: boolean;
  /** manage:documents — the capability the per-document reject endpoint
   *  (POST /documents/admin/:id/reject) requires. */
  canReject: boolean;
  /** This page's path + query, for the verifier round-trip deep link. */
  returnTo: string;
}) {
  const queryClient = useQueryClient();
  // Keyed under ['application', id, …] so the parent's prefix-match
  // invalidation (after skip/approve) refreshes these too.
  const statusQuery = useQuery({
    queryKey: ['application', applicationId, 'i9', 'status'],
    queryFn: () => getI9Status(applicationId),
    retry: false,
  });
  const docsQuery = useQuery({
    queryKey: ['application', applicationId, 'i9', 'documents'],
    queryFn: async () => (await listI9Documents(applicationId)).documents,
    retry: false,
  });

  const failed = statusQuery.isError || docsQuery.isError;
  const loading = statusQuery.isPending || docsQuery.isPending;
  const status = statusQuery.data ?? null;
  const docs = docsQuery.data ?? [];

  /* Inline Section 2 verifier — same rules as the Compliance drawer's
     verifier (shared via section2Verification) so HR can finish the I-9
     without leaving the application. */
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [documentList, setDocumentList] = useState<I9DocumentList>('LIST_A');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [rejectTarget, setRejectTarget] = useState<I9DocumentListItem | null>(
    null,
  );

  // Seed the auto-detected list + pre-checked docs once per application.
  // Later refetches (e.g. after an inline reject) only prune picks whose
  // documents vanished — they must not clobber the reviewer's choices.
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    const loaded = docsQuery.data;
    if (!loaded) return;
    if (seededFor.current !== applicationId) {
      seededFor.current = applicationId;
      const auto = autoDetectSection2(loaded);
      if (auto) {
        setDocumentList(auto.documentList);
        setPicked(new Set(auto.preChecked));
      }
      return;
    }
    setPicked((prev) => {
      const available = new Set(
        loaded.filter((d) => d.fileAvailable).map((d) => d.id),
      );
      const next = new Set([...prev].filter((id) => available.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [docsQuery.data, applicationId]);

  const togglePick = (id: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Only at the "Section 1 done, Section 2 pending" stage — before Section 1
  // there's nothing to attest against, after Section 2 there's nothing to do.
  const showInlineVerifier =
    canVerify && !!status?.section1 && !status?.section2;
  const minDocs = minDocsForSection2List(documentList);
  const canSubmit = picked.size >= minDocs && !submitting;

  const handleVerify = async () => {
    if (!canSubmit) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      await submitI9Section2(applicationId, {
        documentList,
        supportingDocIds: Array.from(picked),
      });
      toast.success('I-9 Section 2 verified.');
      // Prefix-match refreshes the application detail (percentComplete,
      // task status — may light up Approve) plus this card's queries.
      await queryClient.invalidateQueries({
        queryKey: ['application', applicationId],
      });
    } catch (err) {
      setSubmitError(
        err instanceof ApiError ? err.message : 'Verification failed.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  const verifierHref = i9VerifierHref(associateId, returnTo);

  // Section 2 deadline: startDate + 3 business days. Only meaningful while
  // Section 2 is incomplete and a start date exists.
  const deadline = startDate
    ? addBusinessDays(parseDateOnly(startDate), 3)
    : null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const daysLeft = deadline
    ? Math.round((deadline.getTime() - today.getTime()) / ONE_DAY_MS)
    : null;
  const deadlineCx =
    daysLeft !== null && daysLeft < 0
      ? 'text-alert'
      : daysLeft !== null && daysLeft <= 2
        ? 'text-warning'
        : 'text-silver';

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-gold" aria-hidden />
            I-9 employment verification
          </CardTitle>
          <Link
            to={verifierHref}
            className="inline-flex items-center gap-1 text-xs text-gold hover:underline"
          >
            Open in Compliance
            <ExternalLink className="h-3 w-3" aria-hidden />
          </Link>
        </div>
      </CardHeader>
      <CardContent>
        {failed ? (
          <ErrorBanner
            action={
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  void statusQuery.refetch();
                  void docsQuery.refetch();
                }}
              >
                Retry
              </Button>
            }
          >
            Couldn't load I-9 status.
          </ErrorBanner>
        ) : loading ? (
          <div className="space-y-2">
            <Skeleton className="h-5 w-56" />
            <Skeleton className="h-5 w-72" />
            <Skeleton className="h-5 w-64" />
          </div>
        ) : (
          <div className="space-y-4 text-sm">
            {/* Section 1 — employee attestation */}
            <div className="flex items-start gap-2">
              <I9StepIcon done={!!status?.section1} />
              <div>
                <span className="text-white">Section 1 (employee)</span>{' '}
                {status?.section1 ? (
                  <span className="text-silver">
                    — completed {fmtDateLabel(status.section1.completedAt)}
                  </span>
                ) : (
                  <span className="text-silver">— pending</span>
                )}
              </div>
            </div>

            {/* Documents */}
            <div>
              <div className="flex items-start gap-2">
                <I9StepIcon done={docs.length > 0} />
                <div>
                  <span className="text-white">Documents submitted</span>{' '}
                  <span className="text-silver tabular-nums">
                    — {docs.length === 0 ? 'none yet' : docs.length}
                  </span>
                </div>
              </div>
              {docs.length > 0 && showInlineVerifier && (
                <p className="mt-1 ml-6 text-2xs text-silver">
                  Check the documents you inspected — need at least {minDocs}{' '}
                  for {documentList === 'LIST_A' ? 'List A' : 'Lists B + C'}.
                </p>
              )}
              {docs.length > 0 && (
                <I9DocumentGrid
                  docs={docs}
                  picked={showInlineVerifier ? picked : undefined}
                  onTogglePick={showInlineVerifier ? togglePick : undefined}
                  onReject={canReject ? setRejectTarget : undefined}
                />
              )}
            </div>

            {/* Section 2 — employer verification */}
            <div className="flex items-start gap-2">
              <I9StepIcon done={!!status?.section2} />
              <div className="min-w-0">
                <span className="text-white">Section 2 (employer)</span>{' '}
                {status?.section2 ? (
                  <span className="text-silver">
                    — completed {fmtDateLabel(status.section2.completedAt)}
                    {status.section2.verifierEmail
                      ? ` by ${status.section2.verifierEmail}`
                      : ''}
                  </span>
                ) : (
                  <span className="text-silver">— incomplete</span>
                )}
                {!status?.section2 && deadline && (
                  <div className={cn('mt-0.5 text-xs', deadlineCx)}>
                    Due {fmtDateLabel(deadline)} (start date + 3 business days)
                    {daysLeft !== null && daysLeft < 0 ? ' — past due' : ''}
                  </div>
                )}
                {showInlineVerifier && (
                  <div className="mt-3 space-y-3">
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="block text-xs2 uppercase tracking-wider text-silver">
                        Document list
                      </span>
                      {(['LIST_A', 'LIST_B_AND_C'] as const).map((opt) => (
                        <label
                          key={opt}
                          className="flex items-center gap-2 text-sm text-white"
                        >
                          <input
                            type="radio"
                            name={`i9-doc-list-${applicationId}`}
                            value={opt}
                            checked={documentList === opt}
                            onChange={() => setDocumentList(opt)}
                          />
                          {opt === 'LIST_A'
                            ? 'List A (identity + work auth in one doc)'
                            : 'Lists B + C (identity + work auth)'}
                        </label>
                      ))}
                    </div>
                    {submitError && <ErrorBanner>{submitError}</ErrorBanner>}
                  </div>
                )}
                {!status?.section2 && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {showInlineVerifier && (
                      <Button
                        size="sm"
                        onClick={() => void handleVerify()}
                        loading={submitting}
                        disabled={!canSubmit}
                        title={
                          canSubmit
                            ? undefined
                            : `Check at least ${minDocs} inspected document${minDocs === 1 ? '' : 's'} above`
                        }
                      >
                        <ShieldCheck className="h-4 w-4" />
                        {`Verify Section 2 (${picked.size} doc${picked.size === 1 ? '' : 's'})`}
                      </Button>
                    )}
                    <Button asChild variant="outline" size="sm">
                      {/* Same deep link the header uses — landing on bare
                          /compliance lost the tab AND the person. Kept as a
                          secondary affordance next to the inline verifier:
                          work-auth updates and manual edits live there. */}
                      <Link to={verifierHref}>Open Section 2 verifier</Link>
                    </Button>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </CardContent>
      <RejectDocumentDialog
        doc={rejectTarget}
        onClose={() => setRejectTarget(null)}
        onRejected={(docId) => {
          // A just-rejected document can't stay picked for verification.
          setPicked((prev) => {
            if (!prev.has(docId)) return prev;
            const next = new Set(prev);
            next.delete(docId);
            return next;
          });
          // Refreshes the I-9 doc list AND the application detail (the
          // reject endpoint rewinds the upload task, so percentComplete
          // and the checklist tiles change too).
          void queryClient.invalidateQueries({
            queryKey: ['application', applicationId],
          });
        }}
      />
    </Card>
  );
}

/**
 * In-place viewer for the uploaded identity documents — HR used to have
 * to leave for /compliance just to look at them. Mirrors the Section 2
 * verifier's thumbnail grid (compliance I9Tab); clicking a tile opens the
 * shared DocumentViewer overlay, so review happens without ever leaving
 * the application drawer.
 *
 * With `picked`/`onTogglePick` the grid becomes the inline Section 2
 * verifier's document picker: each tile is a checkbox (styled like the
 * I9Tab verifier's tiles) and viewing moves to a small "View" affordance.
 * `onReject` adds a per-tile reject affordance for the statuses the
 * documents vault allows rejecting (UPLOADED / VERIFIED).
 */
function I9DocumentGrid({
  docs,
  picked,
  onTogglePick,
  onReject,
}: {
  docs: I9DocumentListItem[];
  picked?: Set<string>;
  onTogglePick?: (id: string) => void;
  onReject?: (doc: I9DocumentListItem) => void;
}) {
  const [viewerAt, setViewerAt] = useState<number | null>(null);
  const pickMode = picked !== undefined && onTogglePick !== undefined;
  return (
    <>
      <ul className="mt-2 ml-6 grid grid-cols-2 sm:grid-cols-3 gap-3">
        {docs.map((d, i) => {
          const isImage = d.mimeType.startsWith('image/');
          const missing = !d.fileAvailable;
          const checked = pickMode && !missing && !!picked?.has(d.id);
          // Mirror the vault: only UPLOADED / VERIFIED docs are rejectable.
          const rejectable =
            !!onReject && (d.status === 'UPLOADED' || d.status === 'VERIFIED');
          const title =
            d.i9DocTitle ?? I9_DOC_KIND_LABEL[d.kind] ?? d.kind.replace(/_/g, ' ');
          const thumb = (
            <div className="flex aspect-[3/2] items-center justify-center bg-navy-secondary">
              {missing ? (
                <span className="px-2 text-center text-2xs leading-tight text-alert">
                  File missing on server
                </span>
              ) : isImage ? (
                <img
                  src={previewDocumentUrl(d.id)}
                  // "Evidence:" phrasing on purpose, and never the kind
                  // label — that's "Photo ID" for ID docs, and
                  // photo/image words are lint-banned in alt text.
                  alt={`Evidence: ${d.i9DocTitle ?? d.filename}`}
                  className="h-full w-full object-cover"
                />
              ) : (
                <span className="text-xs text-silver">PDF</span>
              )}
            </div>
          );
          const meta = (
            <div className="px-2 py-1.5">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="truncate text-xs text-white">{title}</span>
                <Badge size="sm" variant={statusTone(d.status)} className="shrink-0">
                  {I9_DOC_STATUS_LABEL[d.status] ?? d.status}
                </Badge>
              </div>
              <div className="mt-0.5 text-2xs text-silver truncate">
                {d.i9List ? `List ${d.i9List} · ` : ''}
                {d.side ? (d.side === 'FRONT' ? 'Front' : 'Back') : 'Document'}
                {missing && (
                  <>
                    {' '}
                    · <span className="text-alert">re-upload required</span>
                  </>
                )}
                {pickMode && !missing && (
                  <>
                    {' '}
                    ·{' '}
                    {/* preventDefault so a click here never toggles the
                        surrounding checkbox label. */}
                    <button
                      type="button"
                      className="text-gold hover:underline"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setViewerAt(i);
                      }}
                    >
                      View
                    </button>
                  </>
                )}
              </div>
              {rejectable && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onReject?.(d);
                  }}
                  className="mt-1 inline-flex items-center gap-1 text-2xs text-alert/80 transition-colors hover:text-alert"
                  title="Reject this document — the associate is asked to re-upload"
                >
                  <XCircle className="h-3 w-3" aria-hidden />
                  Reject
                </button>
              )}
            </div>
          );
          return (
            <li key={d.id}>
              {pickMode ? (
                <label
                  className={cn(
                    'block w-full overflow-hidden rounded border transition-colors',
                    missing
                      ? 'cursor-not-allowed border-alert/40 bg-alert/5'
                      : checked
                        ? 'cursor-pointer border-gold bg-gold/10'
                        : 'cursor-pointer border-navy-secondary hover:border-silver/40',
                  )}
                >
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={checked}
                    onChange={() => !missing && onTogglePick?.(d.id)}
                    disabled={missing}
                    aria-label={`${d.i9DocTitle ?? d.kind} ${d.side ?? ''}`.trim()}
                  />
                  {thumb}
                  {meta}
                </label>
              ) : (
                <div
                  className={cn(
                    'overflow-hidden rounded border transition-colors',
                    missing
                      ? 'border-alert/40 bg-alert/5'
                      : 'border-navy-secondary hover:border-gold/60',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => setViewerAt(i)}
                    disabled={missing}
                    aria-label={`View ${d.filename}`}
                    className={cn(
                      'block w-full text-left',
                      missing && 'cursor-not-allowed',
                    )}
                  >
                    {thumb}
                  </button>
                  {meta}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {viewerAt !== null && (
        <DocumentViewer
          documents={docs}
          startIndex={viewerAt}
          onClose={() => setViewerAt(null)}
        />
      )}
    </>
  );
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
// Shared relative formatter — one "time ago" dialect across the app.
const fmtAgo = (iso: string): string => fmtRelativeDate(iso);

function DeliverabilityStrip({ info }: { info: InviteDeliveryInfo }) {
  const isFailed = info.status === 'FAILED';
  const isQueued = info.status === 'QUEUED';
  const Icon = isFailed ? MailWarning : MailCheck;
  const tone = isFailed
    ? 'border-alert/40 bg-alert/[0.07] text-alert'
    : isQueued
      ? 'border-warning/40 bg-warning/[0.06] text-warning'
      : 'border-success/30 bg-success/[0.05] text-success';
  const label =
    info.category === 'onboarding.nudge' ? 'Last nudge' : 'Last invite';
  const verb = isFailed ? 'bounced' : isQueued ? 'queued' : 'delivered';
  return (
    <div
      className={cn(
        'mt-3 flex items-start gap-2 px-3 py-2 rounded-md border text-xs',
        tone
      )}
      role={isFailed ? 'alert' : undefined}
    >
      <Icon className="h-3.5 w-3.5 mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <div>
          <span className="font-medium">{label}</span>{' '}
          <span>{verb}</span>{' '}
          <span className="opacity-80">{fmtAgo(info.attemptedAt)}</span>
        </div>
        {isFailed && info.failureReason && (
          <div className="mt-0.5 opacity-90 break-words">
            Provider error: {info.failureReason}
          </div>
        )}
        {isFailed && (
          <div className="mt-0.5 opacity-80">
            Fix the email on file and click "Resend invite", or copy the magic
            link from the dev-stub response.
          </div>
        )}
      </div>
    </div>
  );
}
