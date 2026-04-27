import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  CheckCircle2,
  Circle,
  Clock,
  Copy,
  FileDown,
  MailCheck,
  MailWarning,
  MinusCircle,
  Send,
} from 'lucide-react';
import { toast } from 'sonner';
import type {
  ApplicationDetail as ApplicationDetailType,
  AuditLogEntry,
  ChecklistTask,
  InviteDeliveryInfo,
} from '@alto-people/shared';
import {
  compliancePacketUrl,
  getApplication,
  getApplicationAudit,
  resendInvite,
  skipTask,
} from '@/lib/onboardingApi';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { ProgressBar } from '@/components/ProgressBar';
import { AuditTimeline } from '@/components/AuditTimeline';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { EsignSection } from './EsignSection';
import { cn } from '@/lib/cn';

const EMPLOYMENT_LABEL: Record<string, string> = {
  W2_EMPLOYEE: 'W-2',
  CONTRACTOR_1099_INDIVIDUAL: '1099 (Individual)',
  CONTRACTOR_1099_BUSINESS: '1099 (Business)',
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
    <div className="max-w-5xl mx-auto">
      <Link
        to="/onboarding"
        className="text-sm text-silver hover:text-gold inline-block mb-3"
      >
        ← All applications
      </Link>
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
  const [detail, setDetail] = useState<ApplicationDetailType | null>(null);
  const [audit, setAudit] = useState<AuditLogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const canManage =
    user?.role === 'HR_ADMINISTRATOR' || user?.role === 'OPERATIONS_MANAGER';

  const refresh = useCallback(async () => {
    if (!applicationId) return;
    try {
      const [d, a] = await Promise.all([
        getApplication(applicationId),
        canManage
          ? getApplicationAudit(applicationId).catch(() => ({ entries: [] }))
          : Promise.resolve({ entries: [] }),
      ]);
      setDetail(d);
      setAudit(a.entries);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load.');
    }
  }, [applicationId, canManage]);

  useEffect(() => {
    setDetail(null);
    setAudit([]);
    setError(null);
    refresh();
  }, [refresh]);

  if (error) {
    return (
      <div
        className="p-3 rounded-md border border-alert/40 bg-alert/10 text-alert text-sm"
        role="alert"
      >
        {error}
      </div>
    );
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
        toast.success('Fresh invite link copied', {
          description: 'Email is stubbed — paste the link in Slack / a manual email.',
          icon: <Copy className="h-4 w-4" />,
        });
      } else {
        toast.success('Fresh invite emailed');
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === 'user_already_active') {
        toast.message('Already accepted', {
          description: 'This associate has already set their password.',
        });
        return;
      }
      toast.error('Could not resend', {
        description: err instanceof Error ? err.message : String(err),
      });
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
                {detail.associateName}
              </h1>
              <DetailMeta detail={detail} />
            </div>
            {canManage && (
              <DetailActions detail={detail} onResend={handleResend} />
            )}
          </div>
        )}
        {mode === 'drawer' && (
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <DetailMeta detail={detail} />
            {canManage && (
              <DetailActions detail={detail} onResend={handleResend} compact />
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
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[11px]">
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
          />
        ))}
      </section>

      <section className="mb-6">
        <EsignSection
          applicationId={detail.id}
          canManage={canManage}
          esignTasks={detail.tasks.filter((t) => t.kind === 'E_SIGN')}
        />
      </section>

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
    </>
  );
}

function DetailMeta({ detail }: { detail: ApplicationDetailType }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-silver text-sm">
      <span className="text-white">{detail.clientName}</span>
      {detail.position && (
        <>
          <span className="text-silver/40">·</span>
          <span>{detail.position}</span>
        </>
      )}
      <Badge variant="outline" className="text-[10px]">
        {detail.onboardingTrack} TRACK
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
  compact,
}: {
  detail: ApplicationDetailType;
  onResend: () => void;
  compact?: boolean;
}) {
  return (
    <div className="flex gap-2 shrink-0">
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
        {compact ? 'Packet' : 'Compliance packet'}
      </a>
      <Button variant="outline" size="sm" onClick={onResend}>
        <Send className="h-4 w-4" />
        Resend invite
      </Button>
    </div>
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
    iconCx: 'text-silver/60',
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

function TaskTile({ task, canSkip, onSkip }: TaskTileProps) {
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
                'text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0',
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
