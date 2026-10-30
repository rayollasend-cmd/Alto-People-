import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { HugoTaskChoice, HugoTaskKind, HugoTaskStatus, HugoTaskView } from '@alto-people/shared';
import { ArrowLeftRight, ArrowRight, ChevronDown, ChevronUp, FileText, Plane, CalendarPlus, Repeat, Target, Users, Wallet, type LucideIcon } from '@/components/ui/icons';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { ProgressBar } from '@/components/ProgressBar';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/cn';
import '@/lib/i18n/en/hugoWork';
import { eventLine, fmtStepTime, latestLine, needsLine, taskDoes, taskTitle } from './hugoWorkText';

export const TASK_ICON: Record<HugoTaskKind, LucideIcon> = {
  WATCH_TIME_OFF: Plane,
  WATCH_OPEN_SHIFTS: CalendarPlus,
  WATCH_PAYCHECK: Wallet,
  WATCH_DOCUMENT: FileText,
  FIND_COVER: ArrowLeftRight,
  CHASE_CONFIRMATIONS: Users,
  RECURRING: Repeat,
  // A goal renders as HugoGoalCard; the icon serves lists that show every kind.
  GOAL: Target,
};

const STATUS_VARIANT: Record<HugoTaskStatus, 'accent' | 'info' | 'pending' | 'success' | 'default' | 'destructive'> = {
  WORKING: 'accent',
  WAITING: 'info',
  NEEDS_YOU: 'pending',
  DONE: 'success',
  CANCELLED: 'default',
  FAILED: 'destructive',
  EXPIRED: 'default',
};

const OPEN: readonly HugoTaskStatus[] = ['WORKING', 'WAITING', 'NEEDS_YOU'];

/**
 * One task Hugo is doing (or did) for the person: what it is, where it
 * stands, the trail of what Hugo did, and — when it needs them — the
 * answers on offer. Stopping asks first; stopping a cover search says the
 * request in flight is withdrawn and they stay on the shift.
 */
export function HugoTaskCard({
  task,
  busy,
  focused = false,
  onRespond,
  onStop,
  onNavigate,
}: {
  task: HugoTaskView;
  /** Which of this card's actions is in flight. */
  busy: HugoTaskChoice | 'stop' | null;
  focused?: boolean;
  onRespond: (choice: HugoTaskChoice) => void;
  onStop: () => void;
  onNavigate?: () => void;
}) {
  const { t, lang } = useI18n();
  const [expanded, setExpanded] = useState(focused);
  const [confirmStop, setConfirmStop] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const Icon = TASK_ICON[task.kind];
  const title = taskTitle(task, t, lang);
  const open = OPEN.includes(task.status);
  const needs = needsLine(task, t, lang);
  const steps = task.events.filter((e) => e.code !== 'STARTED');
  const result = task.result;
  // A task waiting on the person stops through its own answer (the API's STOP); a running one through cancel.
  const stopViaChoice = task.choices.includes('STOP');
  const stopKey = stopViaChoice ? 'STOP' : 'stop';

  useEffect(() => {
    if (!focused) return;
    setExpanded(true);
    ref.current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  }, [focused]);

  return (
    <article
      ref={ref}
      id={`hugo-task-${task.id}`}
      aria-label={title}
      data-testid="hugo-task"
      data-status={task.status}
      className={cn(
        'rounded-xl border bg-surface-raised p-3 transition-colors',
        task.status === 'NEEDS_YOU' ? 'border-accent/60' : 'border-line',
        focused && 'ring-2 ring-gold-bright/70',
      )}
    >
      <div className="flex gap-3">
        <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-lg', open ? 'bg-accent-fill/15 text-accent' : 'bg-surface-sunken text-ink-muted')} aria-hidden="true">
          <Icon className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <p className="min-w-0 text-sm font-medium leading-snug text-ink">{title}</p>
            <span className="flex shrink-0 items-center gap-1.5">
              {!task.seen && (
                <span className="h-2 w-2 rounded-full bg-gold-bright" aria-label={t('hugoWork.new')} role="img" />
              )}
              <Badge variant={STATUS_VARIANT[task.status]} size="sm">
                {t(`hugoWork.status.${task.status}`)}
              </Badge>
            </span>
          </div>
          <p className="mt-0.5 text-xs leading-relaxed text-ink-muted" data-testid="hugo-task-latest">
            {latestLine(task, t, lang)}
          </p>

          {task.progress && task.progress.total > 0 && open && (
            <div className="mt-2">
              <ProgressBar
                percent={Math.round((task.progress.done / task.progress.total) * 100)}
                hideLabel
                label={t(`hugoWork.progress.${task.kind === 'CHASE_CONFIRMATIONS' ? 'CHASE_CONFIRMATIONS' : 'FIND_COVER'}`, { done: task.progress.done, total: task.progress.total })}
              />
              <p className="mt-1 text-xs text-ink-muted">
                {t(`hugoWork.progress.${task.kind === 'CHASE_CONFIRMATIONS' ? 'CHASE_CONFIRMATIONS' : 'FIND_COVER'}`, { done: task.progress.done, total: task.progress.total })}
              </p>
            </div>
          )}

          {needs && (
            <div className="mt-2 rounded-lg border border-accent/40 bg-accent-fill/10 px-3 py-2 text-sm text-ink" role="status">
              {needs}
            </div>
          )}
          {task.choices.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {task.choices.map((c, i) =>
                c === 'STOP' ? null : (
                  <Button key={c} size="sm" variant={i === 0 ? 'primary' : 'outline'} loading={busy === c} disabled={busy !== null && busy !== c} onClick={() => onRespond(c)}>
                    {t(`hugoWork.choice.${c}`)}
                  </Button>
                ),
              )}
            </div>
          )}

          {result?.coveredBy && task.status === 'DONE' && <p className="mt-2 text-sm text-ink">{t('hugoWork.result.coveredBy', { name: result.coveredBy })}</p>}
          {result?.passedTo && (
            <p className="mt-2 text-sm text-ink">
              {result.passedTo.who ? t('hugoWork.result.passedTo', { who: result.passedTo.who }) : t('hugoWork.result.passedToAnon')}{' '}
              {result.passedTo.url && (
                <Link to={result.passedTo.url} onClick={onNavigate} className="text-accent underline-offset-2 hover:underline">
                  {t('hugoWork.result.openThread')}
                </Link>
              )}
            </p>
          )}
          {task.status === 'WORKING' && steps.length === 0 && <p className="mt-1 text-xs text-ink-muted">{taskDoes(task, t)}</p>}

          <div className="mt-2 flex flex-wrap items-center gap-x-1 gap-y-1">
            {task.linkUrl && (
              <Button asChild size="sm" variant="ghost" className="h-8 px-2">
                <Link to={task.linkUrl} onClick={onNavigate}>
                  {t('hugoWork.open')}
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                </Link>
              </Button>
            )}
            {steps.length > 0 && (
              <Button size="sm" variant="ghost" className="h-8 px-2" aria-expanded={expanded} onClick={() => setExpanded((x) => !x)}>
                {expanded ? <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />}
                {expanded ? t('hugoWork.trail.hide') : t('hugoWork.trail.show', { count: steps.length })}
              </Button>
            )}
            {open && (
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto h-8 px-2 text-ink-muted"
                aria-label={t('hugoWork.stopAria', { title })}
                loading={busy === stopKey}
                disabled={busy !== null && busy !== stopKey}
                onClick={() => setConfirmStop(true)}
              >
                {t('hugoWork.stop')}
              </Button>
            )}
          </div>

          {expanded && steps.length > 0 && (
            <ol className="mt-1 space-y-1.5 border-l border-line pl-3" aria-label={t('hugoWork.trail.label')}>
              {task.events.map((e) => (
                <li key={e.id} className="relative text-xs text-ink-muted">
                  <span className="absolute -left-[15px] top-1.5 h-1.5 w-1.5 rounded-full bg-line" aria-hidden="true" />
                  <span className="text-ink">{eventLine(e, task.kind, t, lang)}</span>
                  <span className="ml-1.5 tabular-nums">{fmtStepTime(e.at, lang)}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={confirmStop}
        onOpenChange={setConfirmStop}
        title={t('hugoWork.stopConfirm.title')}
        description={task.kind === 'FIND_COVER' ? t('hugoWork.stopConfirm.cover') : t('hugoWork.stopConfirm.body')}
        confirmLabel={t('hugoWork.stopConfirm.yes')}
        cancelLabel={t('hugoWork.stopConfirm.no')}
        onConfirm={() => {
          setConfirmStop(false);
          if (stopViaChoice) onRespond('STOP');
          else onStop();
        }}
      />
    </article>
  );
}
