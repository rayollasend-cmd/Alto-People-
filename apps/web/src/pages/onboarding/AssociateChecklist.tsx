import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type {
  ApplicationDetail,
  ChecklistTask,
} from '@alto-people/shared';
import { getApplication } from '@/lib/onboardingApi';
import { ApiError } from '@/lib/api';
import { ProgressBar } from '@/components/ProgressBar';
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

const REAL_KINDS = new Set([
  'PROFILE_INFO',
  'W4',
  'DIRECT_DEPOSIT',
  'POLICY_ACK',
  'I9_VERIFICATION',
]);

export function AssociateChecklist() {
  const { applicationId } = useParams<{ applicationId: string }>();
  const [detail, setDetail] = useState<ApplicationDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!applicationId) return;
    try {
      setDetail(await getApplication(applicationId));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load.');
    }
  }, [applicationId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (error) {
    return (
      <div className="max-w-2xl mx-auto">
        <p className="text-alert">{error}</p>
      </div>
    );
  }
  if (!detail) {
    return <p className="text-silver">Loading…</p>;
  }

  return (
    <div className="max-w-3xl mx-auto">
      <header className="mb-6">
        <h1 className="font-display text-3xl md:text-4xl text-white mb-1">
          Welcome, {detail.associateName.split(' ')[0]}
        </h1>
        <p className="text-silver text-sm">
          Onboarding for{' '}
          <span className="text-white">{detail.clientName}</span>
          {detail.position && ` · ${detail.position}`}
        </p>
      </header>

      <section className="bg-navy border border-navy-secondary rounded-lg p-5 mb-6">
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm text-silver">Your progress</div>
          <div className="text-sm text-gold">{detail.percentComplete}%</div>
        </div>
        <ProgressBar percent={detail.percentComplete} hideLabel />
      </section>

      <section className="space-y-3">
        {detail.tasks.map((t) => (
          <AssociateTaskRow key={t.id} task={t} applicationId={detail.id} />
        ))}
      </section>
    </div>
  );
}

interface AssociateTaskRowProps {
  task: ChecklistTask;
  applicationId: string;
}

function AssociateTaskRow({ task, applicationId }: AssociateTaskRowProps) {
  const isComplete = task.status === 'DONE' || task.status === 'SKIPPED';
  const isReal = REAL_KINDS.has(task.kind);
  const linkTo = `/onboarding/me/${applicationId}/tasks/${task.kind.toLowerCase()}`;

  const containerClass = cn(
    'block bg-navy border rounded-lg p-4 transition',
    isComplete
      ? 'border-gold/40'
      : isReal
      ? 'border-navy-secondary hover:border-gold/40'
      : 'border-navy-secondary opacity-80'
  );

  const inner = (
    <div className="flex items-start gap-3">
      <span
        className={cn(
          'inline-block w-3 h-3 rounded-full mt-1.5 shrink-0 border',
          isComplete
            ? 'bg-gold border-gold'
            : 'bg-transparent border-silver/50'
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
      </div>
      <div className="text-xs shrink-0">
        {isComplete ? (
          <span className="text-gold uppercase tracking-widest">
            {task.status === 'SKIPPED' ? 'Skipped' : 'Done'}
          </span>
        ) : isReal ? (
          <span className="text-gold">Start →</span>
        ) : (
          <span className="text-silver/60">Coming soon</span>
        )}
      </div>
    </div>
  );

  if (isReal && !isComplete) {
    return (
      <Link to={linkTo} className={containerClass}>
        {inner}
      </Link>
    );
  }
  return <div className={containerClass}>{inner}</div>;
}
