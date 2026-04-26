import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Copy, Send } from 'lucide-react';
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
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';

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
      <div className="max-w-4xl mx-auto">
        <p className="text-alert">{error}</p>
      </div>
    );
  }
  if (!detail) {
    return <p className="text-silver">Loading…</p>;
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

  return (
    <div className="max-w-5xl mx-auto">
      <Link
        to="/onboarding"
        className="text-sm text-silver hover:text-gold inline-block mb-3"
      >
        ← All applications
      </Link>

      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl md:text-4xl text-white mb-1">
            {detail.associateName}
          </h1>
          <p className="text-silver text-sm">
            {detail.clientName}
            {detail.position && ` · ${detail.position}`} · Track:{' '}
            {detail.onboardingTrack}
          </p>
        </div>
        {canManage && (
          <Button variant="outline" size="sm" onClick={handleResend}>
            <Send className="h-4 w-4" />
            Resend invite
          </Button>
        )}
      </header>

      <section className="bg-navy border border-navy-secondary rounded-lg p-5 mb-6">
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm text-silver">Checklist progress</div>
          <div className="text-sm text-gold">{detail.percentComplete}%</div>
        </div>
        <ProgressBar percent={detail.percentComplete} hideLabel />
      </section>

      <section className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
        {detail.tasks.map((t) => (
          <TaskTile
            key={t.id}
            task={t}
            canSkip={canManage && STUB_KINDS.has(t.kind)}
            onSkip={() => handleSkip(t)}
          />
        ))}
      </section>

      {canManage && (
        <section className="bg-navy border border-navy-secondary rounded-lg p-5">
          <h2 className="font-display text-xl text-white mb-3">Activity</h2>
          <AuditTimeline entries={audit} />
        </section>
      )}
    </div>
  );
}

interface TaskTileProps {
  task: ChecklistTask;
  canSkip: boolean;
  onSkip: () => void;
}

function TaskTile({ task, canSkip, onSkip }: TaskTileProps) {
  const isComplete = task.status === 'DONE' || task.status === 'SKIPPED';
  return (
    <div
      className={cn(
        'rounded-lg border p-4 bg-navy',
        isComplete ? 'border-gold/40' : 'border-navy-secondary'
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'inline-block w-2.5 h-2.5 rounded-full mt-1.5 shrink-0',
            isComplete ? 'bg-gold' : 'bg-silver/40'
          )}
          aria-hidden="true"
        />
        <div className="flex-1 min-w-0">
          <div className="font-medium text-white">
            {TASK_LABEL[task.kind] ?? task.title}
          </div>
          {task.description && (
            <div className="text-xs text-silver mt-1">{task.description}</div>
          )}
          <div className="text-[11px] uppercase tracking-widest text-silver/70 mt-2">
            {task.status}
          </div>
        </div>
        {canSkip && !isComplete && (
          <button
            type="button"
            onClick={onSkip}
            className="text-xs text-gold hover:text-gold-bright px-2 py-1 border border-gold/30 rounded shrink-0"
          >
            Skip (demo)
          </button>
        )}
      </div>
    </div>
  );
}
