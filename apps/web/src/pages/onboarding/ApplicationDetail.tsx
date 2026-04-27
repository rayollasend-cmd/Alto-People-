import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  CheckCircle2,
  Circle,
  Clock,
  Copy,
  MinusCircle,
  Send,
} from 'lucide-react';
import { toast } from 'sonner';
import type {
  ApplicationDetail as ApplicationDetailType,
  AuditLogEntry,
  ChecklistTask,
} from '@alto-people/shared';
import {
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

export function ApplicationDetail() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const [detail, setDetail] = useState<ApplicationDetailType | null>(null);
  const [audit, setAudit] = useState<AuditLogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const canManage =
    user?.role === 'HR_ADMINISTRATOR' || user?.role === 'OPERATIONS_MANAGER';

  const refresh = useCallback(async () => {
    if (!id) return;
    try {
      const [d, a] = await Promise.all([
        getApplication(id),
        canManage
          ? getApplicationAudit(id).catch(() => ({ entries: [] }))
          : Promise.resolve({ entries: [] }),
      ]);
      setDetail(d);
      setAudit(a.entries);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load.');
    }
  }, [id, canManage]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (error) {
    return (
      <div className="max-w-5xl mx-auto">
        <div
          className="p-3 rounded-md border border-alert/40 bg-alert/10 text-alert text-sm"
          role="alert"
        >
          {error}
        </div>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="max-w-5xl mx-auto space-y-6">
        <Skeleton className="h-7 w-32" />
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

  // Per-status counts for the progress card.
  const counts = detail.tasks.reduce<Record<string, number>>((acc, t) => {
    acc[t.status] = (acc[t.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="max-w-5xl mx-auto">
      <Link
        to="/onboarding"
        className="text-sm text-silver hover:text-gold inline-block mb-3"
      >
        ← All applications
      </Link>

      {/* Header — title on its own line, metadata + actions stacked below
          on narrow screens so the employment badge never orphans. */}
      <header className="mb-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <h1 className="font-display text-3xl md:text-4xl text-white mb-2 leading-tight">
              {detail.associateName}
            </h1>
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
          </div>
          {canManage && (
            <div className="flex gap-2 shrink-0">
              <Button variant="outline" size="sm" onClick={handleResend}>
                <Send className="h-4 w-4" />
                Resend invite
              </Button>
            </div>
          )}
        </div>
      </header>

      {/* Hero progress card — bigger, color-coded counts, replaces the
          previous "small text + thin gold bar" treatment. */}
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
                'text-3xl md:text-4xl'
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

      {/* Task grid — color-coded status badges, status-tinted card. HR sees
          progress and can skip stub tasks; the actual form-filling lives on
          the associate's /onboarding/me/... routes. */}
      <section className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-8">
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
