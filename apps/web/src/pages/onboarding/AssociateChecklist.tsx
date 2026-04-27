import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowRight,
  CheckCircle2,
  Circle,
  Clock,
  MinusCircle,
  Sparkles,
} from 'lucide-react';
import type {
  ApplicationDetail,
  ChecklistTask,
} from '@alto-people/shared';
import { getApplication } from '@/lib/onboardingApi';
import { ApiError } from '@/lib/api';
import { ProgressBar } from '@/components/ProgressBar';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
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

// Tasks that route to a real associate-facing form. Anything not in
// this set falls through to the StubTask "coming soon" placeholder
// (currently just E_SIGN, which is launched from the HR-side detail).
const REAL_KINDS = new Set([
  'PROFILE_INFO',
  'W4',
  'DIRECT_DEPOSIT',
  'POLICY_ACK',
  'I9_VERIFICATION',
  // Phase 63
  'DOCUMENT_UPLOAD',
  'BACKGROUND_CHECK',
  'J1_DOCS',
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
      <div className="max-w-3xl mx-auto">
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
      <div className="max-w-3xl mx-auto space-y-4">
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-24" />
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-16" />
        ))}
      </div>
    );
  }

  const firstName = detail.associateName.split(' ')[0];
  const allDone = detail.percentComplete === 100;
  const nextTask = detail.tasks.find(
    (t) => t.status !== 'DONE' && t.status !== 'SKIPPED' && REAL_KINDS.has(t.kind)
  );

  return (
    <div className="max-w-3xl mx-auto">
      <header className="mb-6">
        <h1 className="font-display text-3xl md:text-4xl text-white mb-1.5 leading-tight">
          {allDone ? `You're all set, ${firstName}` : `Welcome, ${firstName}`}
        </h1>
        <p className="text-silver text-sm">
          Onboarding for{' '}
          <span className="text-white">{detail.clientName}</span>
          {detail.position && ` · ${detail.position}`}
        </p>
      </header>

      <Card className="mb-6 overflow-hidden">
        <CardHeader className="pb-2">
          <div className="flex items-baseline justify-between gap-4">
            <CardTitle className="text-base text-silver/80 uppercase tracking-wider font-sans">
              Your progress
            </CardTitle>
            <div
              className={cn(
                'tabular-nums font-display leading-none text-3xl md:text-4xl',
                allDone ? 'text-success' : 'text-gold'
              )}
            >
              {detail.percentComplete}%
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-2">
          <ProgressBar percent={detail.percentComplete} hideLabel />
          {allDone ? (
            <div className="mt-3 inline-flex items-center gap-1.5 text-success text-sm">
              <Sparkles className="h-4 w-4" />
              All tasks complete — your team will be in touch shortly.
            </div>
          ) : nextTask ? (
            <Link
              to={`/onboarding/me/${detail.id}/tasks/${nextTask.kind.toLowerCase()}`}
              className="mt-3 inline-flex items-center gap-1.5 text-gold hover:text-gold-bright text-sm group"
            >
              Continue with{' '}
              <span className="font-medium">
                {TASK_LABEL[nextTask.kind] ?? nextTask.title}
              </span>
              <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
            </Link>
          ) : null}
        </CardContent>
      </Card>

      <section className="space-y-2.5">
        {detail.tasks.map((t) => (
          <AssociateTaskRow key={t.id} task={t} applicationId={detail.id} />
        ))}
      </section>
    </div>
  );
}

const STATUS_TONE: Record<
  string,
  {
    icon: React.ComponentType<{ className?: string }>;
    iconCx: string;
    border: string;
    bg: string;
    label: string;
    labelCx: string;
  }
> = {
  DONE: {
    icon: CheckCircle2,
    iconCx: 'text-success',
    border: 'border-success/40',
    bg: 'bg-success/[0.04]',
    label: 'Done',
    labelCx: 'text-success',
  },
  SKIPPED: {
    icon: MinusCircle,
    iconCx: 'text-silver',
    border: 'border-silver/30',
    bg: 'bg-navy',
    label: 'Skipped',
    labelCx: 'text-silver',
  },
  IN_PROGRESS: {
    icon: Clock,
    iconCx: 'text-warning',
    border: 'border-warning/40',
    bg: 'bg-warning/[0.04]',
    label: 'In progress',
    labelCx: 'text-warning',
  },
  PENDING: {
    icon: Circle,
    iconCx: 'text-silver/60',
    border: 'border-navy-secondary',
    bg: 'bg-navy',
    label: 'Pending',
    labelCx: 'text-silver',
  },
  BLOCKED: {
    icon: Circle,
    iconCx: 'text-alert',
    border: 'border-alert/40',
    bg: 'bg-alert/[0.06]',
    label: 'Blocked',
    labelCx: 'text-alert',
  },
};

interface AssociateTaskRowProps {
  task: ChecklistTask;
  applicationId: string;
}

function AssociateTaskRow({ task, applicationId }: AssociateTaskRowProps) {
  const isComplete = task.status === 'DONE' || task.status === 'SKIPPED';
  const isReal = REAL_KINDS.has(task.kind);
  const linkable = isReal && !isComplete;
  const linkTo = `/onboarding/me/${applicationId}/tasks/${task.kind.toLowerCase()}`;

  const tone = STATUS_TONE[task.status] ?? STATUS_TONE.PENDING;
  const Icon = tone.icon;

  const inner = (
    <div className="flex items-start gap-3">
      <Icon className={cn('h-5 w-5 mt-0.5 shrink-0', tone.iconCx)} aria-hidden />
      <div className="flex-1 min-w-0">
        <div className="font-medium text-white">
          {TASK_LABEL[task.kind] ?? task.title}
        </div>
        {task.description && (
          <div className="text-xs text-silver mt-1">{task.description}</div>
        )}
      </div>
      <div className="shrink-0">
        {isComplete ? (
          <span
            className={cn(
              'text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded',
              tone.bg === 'bg-navy' ? 'bg-silver/15' : 'bg-success/15',
              tone.labelCx
            )}
            data-status={task.status}
          >
            {tone.label}
          </span>
        ) : linkable ? (
          <span className="inline-flex items-center gap-1 text-gold text-sm">
            Start
            <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
          </span>
        ) : (
          <span className="text-[10px] uppercase tracking-wider text-silver/60 px-1.5 py-0.5 rounded bg-silver/10">
            Coming soon
          </span>
        )}
      </div>
    </div>
  );

  const baseCx = cn(
    'group block rounded-lg border p-4 transition-colors',
    tone.bg,
    tone.border,
    linkable && 'hover:border-gold/60 cursor-pointer',
    !linkable && !isComplete && 'opacity-80'
  );

  if (linkable) {
    return (
      <Link
        to={linkTo}
        className={cn(baseCx, 'focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright')}
      >
        {inner}
      </Link>
    );
  }
  return <div className={baseCx}>{inner}</div>;
}
