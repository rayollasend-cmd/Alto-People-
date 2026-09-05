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
import { Button } from '@/components/ui/Button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/Card';
import { Celebrate } from '@/components/ui/Celebrate';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Skeleton } from '@/components/ui/Skeleton';
import { usePublishPageTitle } from '@/lib/pageTitle';
import { useI18n, type MessageKey, type Translate } from '@/lib/i18n';
import { cn } from '@/lib/cn';

// Per-status banner copy for the associate. DRAFT is intentionally absent —
// no banner while they're still working through the checklist.
const STATUS_BANNER: Record<
  ApplicationDetail['status'],
  { icon: typeof Clock; title: MessageKey; body: MessageKey; cls: string } | undefined
> = {
  DRAFT: undefined,
  SUBMITTED: {
    icon: Clock,
    title: 'ob.check.submittedTitle',
    body: 'ob.check.submittedBody',
    cls: 'border-gold/40 bg-gold/[0.07] text-silver',
  },
  IN_REVIEW: {
    icon: Clock,
    title: 'ob.check.inReviewTitle',
    body: 'ob.check.inReviewBody',
    cls: 'border-gold/40 bg-gold/[0.07] text-silver',
  },
  APPROVED: {
    icon: Sparkles,
    title: 'ob.check.approvedTitle',
    body: 'ob.check.approvedBody',
    cls: 'border-success/40 bg-success/[0.07] text-silver',
  },
  REJECTED: {
    icon: AlertTriangle,
    title: 'ob.check.rejectedTitle',
    body: 'ob.check.rejectedBody',
    cls: 'border-alert/40 bg-alert/[0.07] text-silver',
  },
};

const TASK_LABEL_KEY: Record<string, MessageKey> = {
  PROFILE_INFO: 'ob.check.task.profileInfo',
  PROFILE_PHOTO: 'ob.check.task.profilePhoto',
  DOCUMENT_UPLOAD: 'ob.check.task.documents',
  E_SIGN: 'ob.check.task.esign',
  BACKGROUND_CHECK: 'ob.check.task.background',
  W4: 'ob.check.task.w4',
  DIRECT_DEPOSIT: 'ob.check.task.directDeposit',
  POLICY_ACK: 'ob.check.task.policies',
  J1_DOCS: 'ob.check.task.j1',
  I9_VERIFICATION: 'ob.check.task.i9',
};

function taskLabel(t: Translate, task: Pick<ChecklistTask, 'kind' | 'title'>): string {
  const key = TASK_LABEL_KEY[task.kind];
  return key ? t(key) : task.title;
}

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
  // Live headshot (camera capture).
  'PROFILE_PHOTO',
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
  t: Translate,
  tasks: ChecklistTask[],
  docs: DocumentRecord[]
): Map<string, string> {
  const out = new Map<string, string>();
  const kinds = new Set<string>(tasks.map((task) => task.kind));
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
        ? first.rejectionReason
          ? t('ob.check.rejectedOneReason', { what, reason: first.rejectionReason })
          : t('ob.check.rejectedOne', { what })
        : t('ob.check.rejectedMany', { count: String(list.length) })
    );
  }
  return out;
}

export function AssociateChecklist() {
  const { t } = useI18n();
  const { applicationId } = useParams<{ applicationId: string }>();
  const [detail, setDetail] = useState<ApplicationDetail | null>(null);
  const [rejectedDocs, setRejectedDocs] = useState<DocumentRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Confetti fires only when 100% is REACHED in this session — someone
  // revisiting an already-complete checklist shouldn't get the party again.
  const [celebrate, setCelebrate] = useState(false);
  const prevPercent = useRef<number | null>(null);
  // Topbar wayfinding: these 12 pages used to publish nothing, so the
  // topbar fell back to the bare wordmark for the entire onboarding flow.
  usePublishPageTitle(t('ob.check.pageTitle'));

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
      setError(err instanceof ApiError ? err.message : t('ob.check.loadFailed'));
    }
    // Rejection context is best-effort — a failed vault fetch must never
    // block the checklist itself.
    try {
      const r = await listMyDocuments();
      setRejectedDocs(r.documents.filter((d) => d.status === 'REJECTED'));
    } catch {
      // leave whatever we had
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        <Button
          onClick={() => {
            setError(null);
            void refresh();
          }}
        >
          {t('common.retry')}
        </Button>
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
    (task) => task.status !== 'DONE' && task.status !== 'SKIPPED' && REAL_KINDS.has(task.kind)
  );

  // Plain-language status banner so a non-technical hire understands where
  // their application sits in HR's pipeline. DRAFT shows nothing — the
  // checklist below is self-explanatory while they're still filling it out.
  const statusBanner = STATUS_BANNER[detail.status] ?? null;

  return (
    <div className="mx-auto">
      <header className="mb-6">
        <h1 className="font-display text-3xl md:text-4xl text-white mb-1.5 leading-tight">
          {allDone
            ? t('ob.check.allSetHeading', { name: firstName })
            : t('ob.check.welcomeHeading', { name: firstName })}
        </h1>
        <p className="text-silver text-sm">
          {t('ob.check.onboardingFor')}{' '}
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
              {t(statusBanner.title)}
            </div>
            <div className="text-xs mt-0.5">{t(statusBanner.body)}</div>
          </div>
        </div>
      )}

      <Card className="relative mb-6 overflow-hidden">
        {celebrate && <Celebrate />}
        <CardHeader className="pb-2">
          <div className="flex items-baseline justify-between gap-4">
            <CardTitle className="text-base text-silver/80 uppercase tracking-wider font-sans">
              {t('ob.check.yourProgress')}
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
              {t('ob.check.allComplete')}
            </div>
          ) : nextTask ? (
            <Button asChild className="mt-4 group">
              <Link to={`/onboarding/me/${detail.id}/tasks/${nextTask.kind.toLowerCase()}`}>
                {t('ob.check.continueWith', { task: taskLabel(t, nextTask) })}
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </Link>
            </Button>
          ) : null}
        </CardContent>
      </Card>

      <section className="space-y-2.5">
        {(() => {
          const attention = rejectionByTask(t, detail.tasks, rejectedDocs);
          return detail.tasks.map((task) => (
            <AssociateTaskRow
              key={task.id}
              task={task}
              applicationId={detail.id}
              isNext={nextTask?.id === task.id}
              attention={attention.get(task.kind)}
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
    label: MessageKey;
    labelCx: string;
  }
> = {
  DONE: {
    icon: CheckCircle2,
    iconCx: 'text-success',
    border: 'border-success/40',
    bg: 'bg-success/[0.04]',
    label: 'ob.check.status.done',
    labelCx: 'text-success',
  },
  SKIPPED: {
    icon: MinusCircle,
    iconCx: 'text-silver',
    border: 'border-silver/30',
    bg: 'bg-navy',
    label: 'ob.check.status.skipped',
    labelCx: 'text-silver',
  },
  IN_PROGRESS: {
    icon: Clock,
    iconCx: 'text-warning',
    border: 'border-warning/40',
    bg: 'bg-warning/[0.04]',
    label: 'ob.check.status.inProgress',
    labelCx: 'text-warning',
  },
  PENDING: {
    icon: Circle,
    iconCx: 'text-silver/70',
    border: 'border-navy-secondary',
    bg: 'bg-navy',
    label: 'ob.check.status.pending',
    labelCx: 'text-silver',
  },
  BLOCKED: {
    icon: Circle,
    iconCx: 'text-alert',
    border: 'border-alert/40',
    bg: 'bg-alert/[0.06]',
    label: 'ob.check.status.blocked',
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
  const { t } = useI18n();
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
          {taskLabel(t, task)}
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
              {t(tone.label)}
            </span>
            {linkable && (
              <span className="inline-flex items-center gap-1 coarse:min-h-11 text-xs text-gold group-hover:text-gold-bright whitespace-nowrap">
                {t('ob.check.reviewEdit')}
                <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
              </span>
            )}
          </>
        ) : linkable ? (
          <span
            className={cn(
              'inline-flex items-center gap-1.5 px-3 py-1.5 coarse:min-h-11 rounded-md text-sm font-semibold transition-colors whitespace-nowrap',
              isNext
                ? 'bg-gold text-navy group-hover:bg-gold-bright'
                : 'border border-gold/60 text-gold group-hover:bg-gold/10'
            )}
          >
            {isNext ? t('ob.check.startNow') : t('ob.check.start')}
            <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
          </span>
        ) : (
          <span className="text-2xs uppercase tracking-wider text-silver/70 px-1.5 py-0.5 rounded bg-silver/10">
            {t('ob.check.comingSoon')}
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
