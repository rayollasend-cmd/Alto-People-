import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  AlertTriangle,
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
  DocumentRecord,
} from '@alto-people/shared';
import { getApplication } from '@/lib/onboardingApi';
import { listMyDocuments } from '@/lib/documentsApi';
import { ApiError } from '@/lib/api';
import { ProgressBar } from '@/components/ProgressBar';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/Card';
import { Celebrate } from '@/components/ui/Celebrate';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';

// Per-status banner copy for the associate. DRAFT is intentionally absent —
// no banner while they're still working through the checklist.
const STATUS_BANNER: Record<
  ApplicationDetail['status'],
  { icon: typeof Clock; title: string; body: string; cls: string } | undefined
> = {
  DRAFT: undefined,
  SUBMITTED: {
    icon: Clock,
    title: 'Application submitted',
    body: 'Thanks! HR will start reviewing your information shortly. Spotted a mistake? You can still open any completed step below and fix it until HR approves.',
    cls: 'border-gold/40 bg-gold/[0.07] text-silver',
  },
  IN_REVIEW: {
    icon: Clock,
    title: 'In review',
    body: 'HR is reviewing your application. You can still open any completed step below and correct it until HR approves — after that, contact HR for changes.',
    cls: 'border-gold/40 bg-gold/[0.07] text-silver',
  },
  APPROVED: {
    icon: Sparkles,
    title: "You're approved — welcome aboard!",
    body: 'Your onboarding is complete. Your manager will be in touch about next steps and your first shift.',
    cls: 'border-success/40 bg-success/[0.07] text-silver',
  },
  REJECTED: {
    icon: AlertTriangle,
    title: 'Your application needs attention',
    body: 'Please reach out to your HR contact — they can walk you through what to do next.',
    cls: 'border-alert/40 bg-alert/[0.07] text-silver',
  },
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

// Tasks that route to a real associate-facing form. Anything not in
// this set falls through to the StubTask "coming soon" placeholder.
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
  // E-sign (Alto HR Employment Agreement + any HR-drafted addenda).
  'E_SIGN',
]);

// Which checklist row a rejected document belongs to. The checklist task
// payload itself carries no rejection info, so this is derived from the
// associate's own document vault (one extra GET) — kind → task kind.
const REJECTION_TASK_FOR_KIND: Record<string, string> = {
  ID: 'DOCUMENT_UPLOAD',
  SSN_CARD: 'DOCUMENT_UPLOAD',
  I9_SUPPORTING: 'DOCUMENT_UPLOAD',
  J1_VISA: 'J1_DOCS',
  J1_DS2019: 'J1_DOCS',
};

/**
 * task.kind → the human line to show under that row when one of its
 * documents was rejected. Identity-document rejections land on the
 * Documents row (that's where the replace flow lives), falling back to the
 * I-9 row for templates that collect documents there instead.
 */
function rejectionByTask(
  tasks: ChecklistTask[],
  docs: DocumentRecord[]
): Map<string, string> {
  const out = new Map<string, string>();
  const kinds = new Set<string>(tasks.map((t) => t.kind));
  const grouped = new Map<string, DocumentRecord[]>();
  for (const d of docs) {
    if (d.status !== 'REJECTED') continue;
    let taskKind = REJECTION_TASK_FOR_KIND[d.kind];
    if (!taskKind) continue;
    if (taskKind === 'DOCUMENT_UPLOAD' && !kinds.has('DOCUMENT_UPLOAD')) {
      taskKind = 'I9_VERIFICATION';
    }
    if (!kinds.has(taskKind)) continue;
    const list = grouped.get(taskKind) ?? [];
    list.push(d);
    grouped.set(taskKind, list);
  }
  for (const [taskKind, list] of grouped) {
    const first = list[0];
    const what = first.i9DocTitle ?? first.filename;
    out.set(
      taskKind,
      list.length === 1
        ? `${what} was rejected${first.rejectionReason ? ` — ${first.rejectionReason}` : ''}. Open this step to replace it.`
        : `${list.length} documents were rejected. Open this step to replace them.`
    );
  }
  return out;
}

export function AssociateChecklist() {
  const { applicationId } = useParams<{ applicationId: string }>();
  const [detail, setDetail] = useState<ApplicationDetail | null>(null);
  const [rejectedDocs, setRejectedDocs] = useState<DocumentRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Confetti fires only when 100% is REACHED in this session — someone
  // revisiting an already-complete checklist shouldn't get the party again.
  const [celebrate, setCelebrate] = useState(false);
  const prevPercent = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    if (!applicationId) return;
    try {
      const next = await getApplication(applicationId);
      if (prevPercent.current !== null && prevPercent.current < 100 && next.percentComplete === 100) {
        setCelebrate(true);
      }
      prevPercent.current = next.percentComplete;
      setDetail(next);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load.');
    }
    // Rejection context is best-effort — a failed vault fetch must never
    // block the checklist itself.
    try {
      const r = await listMyDocuments();
      setRejectedDocs(r.documents.filter((d) => d.status === 'REJECTED'));
    } catch {
      // leave whatever we had
    }
  }, [applicationId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (error) {
    // A new hire's primary surface must never dead-end: the single fetch
    // used to fail (cold backend, flaky signal) into a bare banner with
    // no way back except knowing to hard-reload the browser.
    return (
      <div className="mx-auto space-y-4">
        <ErrorBanner>{error}</ErrorBanner>
        <button
          type="button"
          className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-gold text-navy text-sm font-semibold hover:bg-gold-bright transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
          onClick={() => {
            setError(null);
            void refresh();
          }}
        >
          Try again
        </button>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="mx-auto space-y-4">
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

  // Plain-language status banner so a non-technical hire understands where
  // their application sits in HR's pipeline. DRAFT shows nothing — the
  // checklist below is self-explanatory while they're still filling it out.
  const statusBanner = STATUS_BANNER[detail.status] ?? null;

  return (
    <div className="mx-auto">
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

      {statusBanner && (
        <div
          className={cn(
            'mb-6 flex items-start gap-3 rounded-lg border p-3.5',
            statusBanner.cls,
          )}
          role="status"
        >
          <statusBanner.icon className="h-5 w-5 shrink-0 mt-0.5" />
          <div className="min-w-0">
            <div className="text-sm font-medium text-white">
              {statusBanner.title}
            </div>
            <div className="text-xs mt-0.5">{statusBanner.body}</div>
          </div>
        </div>
      )}

      <Card className="relative mb-6 overflow-hidden">
        {celebrate && <Celebrate />}
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
              className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-md bg-gold text-navy text-sm font-semibold hover:bg-gold-bright transition-colors group focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
            >
              Continue with {TASK_LABEL[nextTask.kind] ?? nextTask.title}
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
          ) : null}
        </CardContent>
      </Card>

      <section className="space-y-2.5">
        {(() => {
          const attention = rejectionByTask(detail.tasks, rejectedDocs);
          return detail.tasks.map((t) => (
            <AssociateTaskRow
              key={t.id}
              task={t}
              applicationId={detail.id}
              isNext={nextTask?.id === t.id}
              attention={attention.get(t.kind)}
              canRevisit={
                detail.status !== 'APPROVED' && detail.status !== 'REJECTED'
              }
            />
          ));
        })()}
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
    iconCx: 'text-silver/70',
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
  isNext: boolean;
  /** Alert line under the row: a rejected document needs replacing here. */
  attention?: string;
  /** True until HR approves/rejects — completed tasks re-open for edits. */
  canRevisit: boolean;
}

function AssociateTaskRow({ task, applicationId, isNext, attention, canRevisit }: AssociateTaskRowProps) {
  const isComplete = task.status === 'DONE' || task.status === 'SKIPPED';
  const isReal = REAL_KINDS.has(task.kind);
  // Completed tasks stay linkable until HR settles the application — each
  // task page hydrates what's on file, so revisiting means reviewing and
  // correcting, not retyping. The server enforces the same boundary.
  const linkable = isReal && (!isComplete || canRevisit);
  const linkTo = `/onboarding/me/${applicationId}/tasks/${task.kind.toLowerCase()}`;

  const tone = STATUS_TONE[task.status] ?? STATUS_TONE.PENDING;
  const Icon = tone.icon;

  const inner = (
    <div className="flex items-center gap-3">
      <Icon className={cn('h-5 w-5 shrink-0', tone.iconCx)} aria-hidden />
      <div className="flex-1 min-w-0">
        <div className="font-medium text-white">
          {TASK_LABEL[task.kind] ?? task.title}
        </div>
        {task.description && (
          <div className="text-xs text-silver mt-1 line-clamp-2">
            {task.description}
          </div>
        )}
        {attention && (
          <div className="flex items-start gap-1.5 text-xs text-alert mt-1">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-px" aria-hidden />
            <span>{attention}</span>
          </div>
        )}
      </div>
      <div className="shrink-0 flex items-center gap-2">
        {isComplete ? (
          <>
            <span
              className={cn(
                'text-2xs uppercase tracking-wider px-1.5 py-0.5 rounded',
                tone.bg === 'bg-navy' ? 'bg-silver/15' : 'bg-success/15',
                tone.labelCx
              )}
              data-status={task.status}
            >
              {tone.label}
            </span>
            {linkable && (
              <span className="inline-flex items-center gap-1 text-xs text-gold group-hover:text-gold-bright whitespace-nowrap">
                Review / edit
                <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
              </span>
            )}
          </>
        ) : linkable ? (
          <span
            className={cn(
              'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-semibold transition-colors whitespace-nowrap',
              isNext
                ? 'bg-gold text-navy group-hover:bg-gold-bright'
                : 'border border-gold/60 text-gold group-hover:bg-gold/10'
            )}
          >
            {isNext ? 'Start now' : 'Start'}
            <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
          </span>
        ) : (
          <span className="text-2xs uppercase tracking-wider text-silver/70 px-1.5 py-0.5 rounded bg-silver/10">
            Coming soon
          </span>
        )}
      </div>
    </div>
  );

  const baseCx = cn(
    'group block rounded-lg border p-4 transition-all',
    isNext && linkable
      ? 'bg-gold/[0.05] border-gold/50 ring-1 ring-gold/20 hover:border-gold/80 hover:ring-gold/40'
      : cn(tone.bg, tone.border, linkable && 'hover:border-gold/60'),
    // A rejected document outranks every other tone — the row must answer
    // "which step needs me?" at a glance.
    attention && 'border-alert/50 bg-alert/[0.05] ring-1 ring-alert/20',
    linkable && 'cursor-pointer',
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
