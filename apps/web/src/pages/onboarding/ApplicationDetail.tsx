import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
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
} from 'lucide-react';
import { toast } from 'sonner';
import { fmtDate, fmtWeekdayTz, parseYmd } from '@/lib/format';
import {
  hasCapability,
  type ApplicationDetail as ApplicationDetailType,
  type AuditLogEntry,
  type ChecklistTask,
  type InviteDeliveryInfo,
} from '@alto-people/shared';
import {
  approveApplication,
  compliancePacketUrl,
  getApplication,
  getApplicationAudit,
  rejectApplication,
  resendInvite,
  skipTask,
} from '@/lib/onboardingApi';
import {
  getI9Status,
  listI9Documents,
  type I9DocumentListItem,
} from '@/lib/i9Api';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { ProgressBar } from '@/components/ProgressBar';
import { AuditTimeline } from '@/components/AuditTimeline';
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

const STUB_KINDS = new Set([
  'DOCUMENT_UPLOAD',
  'E_SIGN',
  'BACKGROUND_CHECK',
  'I9_VERIFICATION',
  'J1_DOCS',
]);

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
  const queryClient = useQueryClient();
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [approveOpen, setApproveOpen] = useState(false);
  // Non-null once the approve endpoint answered 409 `approval_warnings`.
  // The dialog stays open, lists the gaps, and relabels its confirm button
  // "Approve anyway" (which resubmits with acknowledgeWarnings: true).
  const [approveWarnings, setApproveWarnings] = useState<string[] | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
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
        description: err instanceof Error ? err.message : String(err),
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
      // Skip the toast — open the celebration instead. The "hire is real"
      // moment is the most consequential surface in the onboarding flow
      // and deserves a ceremony, not a passing notification.
      setCelebration({ hireDate });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'approval_warnings') {
        // Not a failure toast — surface the gaps inside the dialog so the
        // admin can read them and either cancel or approve anyway.
        setApproveWarnings(extractApprovalWarnings(err.details));
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
            canSkip={canManage && STUB_KINDS.has(t.kind)}
            onSkip={() => handleSkip(t)}
            // Destinations are admin surfaces (People directory, Compliance)
            // that invite-scoped roles can't open — no dead links for them.
            destination={canManage ? taskDestination(t.kind, detail.associateId) : null}
          />
        ))}
      </section>

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
    </div>
  );
}

function DetailActions({
  detail,
  onResend,
  onApprove,
  onReject,
  compact,
}: {
  detail: ApplicationDetailType;
  onResend: () => void;
  onApprove: () => void;
  onReject: () => void;
  compact?: boolean;
}) {
  // Approve / Reject only shown while the application is still under review.
  // After APPROVED or REJECTED the buttons disappear — the API also rejects
  // re-decisions with 409, but hiding them avoids a confusing dead button.
  // Approve also requires the checklist at 100%.
  const decided = detail.status === 'APPROVED' || detail.status === 'REJECTED';
  const checklistComplete = detail.percentComplete === 100;

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
      {!decided && (
        <Button
          size="sm"
          onClick={onApprove}
          disabled={!checklistComplete}
          title={
            checklistComplete
              ? undefined
              : 'Checklist must be 100% before approving'
          }
        >
          <ThumbsUp className="h-4 w-4" />
          Approve
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
  const today = new Date().toISOString().slice(0, 10);
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
              <Button
                size="lg"
                onClick={() => {
                  onOpenChange(false);
                  navigate('/onboarding');
                }}
              >
                Back to applications
              </Button>
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
 * Where each checklist task's FULL record lives. The tiles used to be dead
 * ends — seeing the I-9 meant menu → Compliance → I-9 → find the person
 * again. Every destination is a deep link that lands with the person open.
 */
function taskDestination(
  kind: string,
  associateId: string,
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
        to: `/compliance?tab=i9&associateId=${associateId}`,
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

function TaskTile({ task, canSkip, onSkip, destination }: TaskTileProps) {
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
          <Button size="sm" variant="outline" onClick={onSkip} className="shrink-0">
            Skip
          </Button>
        )}
      </div>
    </div>
  );
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

const I9_DOC_STATUS_VARIANT: Record<
  I9DocumentListItem['status'],
  'success' | 'pending' | 'destructive' | 'default'
> = {
  VERIFIED: 'success',
  UPLOADED: 'pending',
  PENDING: 'default',
  REJECTED: 'destructive',
  EXPIRED: 'destructive',
};

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
}: {
  applicationId: string;
  startDate: string | null;
  /** Powers the "Open in Compliance" deep link to this person's I-9. */
  associateId: string;
}) {
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
            to={`/compliance?tab=i9&associateId=${associateId}`}
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
              {docs.length > 0 && (
                <ul className="mt-2 ml-6 space-y-1.5">
                  {docs.map((d) => (
                    <li
                      key={d.id}
                      className="flex items-center gap-2 flex-wrap text-xs"
                    >
                      <span className="text-white truncate max-w-[16rem]">
                        {d.filename}
                      </span>
                      <span className="text-2xs uppercase tracking-wider text-silver/70">
                        {d.i9DocTitle ?? I9_DOC_KIND_LABEL[d.kind] ?? d.kind.replace(/_/g, ' ')}
                        {d.i9List ? ` · List ${d.i9List}` : ''}
                        {d.side
                          ? ` · ${d.side === 'FRONT' ? 'Front' : 'Back'}`
                          : ''}
                      </span>
                      <Badge size="sm" variant={I9_DOC_STATUS_VARIANT[d.status]}>
                        {I9_DOC_STATUS_LABEL[d.status] ?? d.status}
                      </Badge>
                    </li>
                  ))}
                </ul>
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
                {!status?.section2 && (
                  <div className="mt-2">
                    <Button asChild variant="outline" size="sm">
                      {/* Same deep link the header uses — landing on bare
                          /compliance lost the tab AND the person. */}
                      <Link to={`/compliance?tab=i9&associateId=${associateId}`}>
                        Open Section 2 verifier
                      </Link>
                    </Button>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
function fmtAgo(iso: string): string {
  const t = new Date(iso).getTime();
  const days = Math.floor((Date.now() - t) / ONE_DAY_MS);
  if (days === 0) return 'today';
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}

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
