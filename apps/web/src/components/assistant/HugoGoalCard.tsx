import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { HugoGoalStep, HugoTaskChoice, HugoTaskStatus, HugoTaskView } from '@alto-people/shared';
import { AlertCircle, ArrowRight, Check, ChevronDown, ChevronUp, Circle, CircleDot, Hourglass, Loader2, Target, X } from '@/components/ui/icons';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { cn } from '@/lib/cn';
import '@/lib/i18n/en/hugoWork';
import { goalEventLine, goalNowLine, goalResult } from './hugoGoalText';
import { fmtStepTime } from './hugoWorkText';

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

/** One line of the plan: done, now, next — or skipped. */
function PlanStep({ step }: { step: HugoGoalStep }) {
  const { t } = useI18n();
  const Icon = step.state === 'done' ? Check : step.state === 'doing' ? CircleDot : step.state === 'skipped' ? X : Circle;
  return (
    <li className="flex items-start gap-2 text-sm leading-snug" data-state={step.state}>
      <span
        className={cn(
          'mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full',
          step.state === 'done' ? 'bg-positive/15 text-positive' : step.state === 'doing' ? 'text-accent' : 'text-ink-muted',
        )}
        aria-hidden="true"
      >
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className={cn('min-w-0 flex-1', step.state === 'done' || step.state === 'skipped' ? 'text-ink-muted' : 'text-ink', step.state === 'skipped' && 'line-through')}>
        <span className="sr-only">{t(`hugoWork.goal.step.${step.state}` as MessageKey)}: </span>
        {step.text}
      </span>
      {step.state === 'doing' && (
        <span className="shrink-0 text-xs font-medium text-accent" aria-hidden="true">
          {t('hugoWork.goal.step.doing')}
        </span>
      )}
    </li>
  );
}

/**
 * A goal Hugo is working on: the person's words, the plan as a checklist,
 * what he'd like to do next (Approve / Not this / Stop — nothing happens
 * until they approve), how the last approved step went, right here, and
 * when he looks again. Phone first.
 */
export function HugoGoalCard({
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
  const g = task.goal;
  const open = OPEN.includes(task.status);
  const lines = task.events.map((e) => ({ e, line: goalEventLine(e, t, lang) })).filter((x): x is { e: typeof x.e; line: string } => Boolean(x.line));
  const pending = task.status === 'NEEDS_YOU' ? g?.pending ?? null : null;
  const stopViaChoice = task.choices.includes('STOP');
  const stopKey = stopViaChoice ? 'STOP' : 'stop';
  const result = g?.last ? goalResult(g.last, t) : null;
  const titleId = `hugo-goal-${task.id}-title`;
  const now = goalNowLine(task, t, lang);

  useEffect(() => {
    if (!focused) return;
    setExpanded(true);
    ref.current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  }, [focused]);

  return (
    <article
      ref={ref}
      id={`hugo-task-${task.id}`}
      aria-labelledby={titleId}
      data-testid="hugo-goal"
      data-status={task.status}
      className={cn('rounded-xl border bg-surface-raised p-3 transition-colors', task.status === 'NEEDS_YOU' ? 'border-accent/60' : 'border-line', focused && 'ring-2 ring-gold-bright/70')}
    >
      <div className="flex gap-3">
        <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-lg', open ? 'bg-accent-fill/15 text-accent' : 'bg-surface-sunken text-ink-muted')} aria-hidden="true">
          <Target className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[11px] font-medium uppercase tracking-wider text-ink-muted">{t('hugoWork.goal.label')}</p>
              <p id={titleId} className="break-words text-sm font-medium leading-snug text-ink">
                {g?.text ?? ''}
              </p>
            </div>
            <span className="flex shrink-0 items-center gap-1.5">
              {!task.seen && <span className="h-2 w-2 rounded-full bg-gold-bright" aria-label={t('hugoWork.new')} role="img" />}
              <Badge variant={STATUS_VARIANT[task.status]} size="sm">
                {t(`hugoWork.status.${task.status}` as MessageKey)}
              </Badge>
            </span>
          </div>
          {now && (
            <p className="mt-1 flex items-center gap-1.5 text-xs leading-relaxed text-ink-muted" data-testid="hugo-goal-now" aria-live="polite">
              {g?.thinking && open && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
              {g?.paused && open && !g.thinking && <Hourglass className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
              <span>{now}</span>
            </p>
          )}

          {g && g.plan.length > 0 && (
            <section className="mt-2.5" aria-label={t('hugoWork.goal.plan')}>
              <ol className="space-y-1.5" data-testid="hugo-goal-plan">
                {g.plan.map((s, i) => (
                  <PlanStep key={`${i}-${s.text}`} step={s} />
                ))}
              </ol>
            </section>
          )}

          {pending && (
            <div className="mt-3 rounded-lg border border-accent/50 bg-accent-fill/10 p-3" role="group" aria-label={t('hugoWork.goal.wants')} data-testid="hugo-goal-proposal">
              <p className="text-xs font-medium text-accent">{pending.action === 'KEEP_GOING' ? t('hugoWork.goal.keepGoingTitle') : t('hugoWork.goal.wants')}</p>
              <p className="mt-1 text-sm font-medium leading-snug text-ink">{pending.title}</p>
              {pending.detail && <p className="mt-0.5 break-words text-xs leading-relaxed text-ink-muted">{pending.detail}</p>}
              {pending.why && <p className="mt-1.5 text-xs leading-relaxed text-ink">{pending.why}</p>}
              {pending.action !== 'KEEP_GOING' && <p className="mt-1.5 text-xs text-ink-muted">{t('hugoWork.goal.wantsHint')}</p>}
              <div className="mt-2.5 flex flex-wrap gap-2">
                {pending.action === 'KEEP_GOING' ? (
                  <Button size="sm" loading={busy === 'KEEP_GOING'} disabled={busy !== null && busy !== 'KEEP_GOING'} onClick={() => onRespond('KEEP_GOING')}>
                    {t('hugoWork.goal.keepGoing')}
                  </Button>
                ) : (
                  <>
                    <Button size="sm" loading={busy === 'APPROVE'} disabled={busy !== null && busy !== 'APPROVE'} onClick={() => onRespond('APPROVE')}>
                      {t('hugoWork.goal.approve')}
                    </Button>
                    <Button size="sm" variant="outline" loading={busy === 'DECLINE'} disabled={busy !== null && busy !== 'DECLINE'} onClick={() => onRespond('DECLINE')}>
                      {t('hugoWork.goal.decline')}
                    </Button>
                  </>
                )}
                <Button size="sm" variant="ghost" className="text-ink-muted" loading={busy === 'STOP'} disabled={busy !== null && busy !== 'STOP'} onClick={() => setConfirmStop(true)}>
                  {t('hugoWork.goal.stop')}
                </Button>
              </div>
            </div>
          )}

          {g?.last && result && !pending && (
            <div
              className={cn('mt-2.5 flex items-start gap-2 rounded-lg px-3 py-2 text-sm', g.last.outcome === 'refused' ? 'bg-negative/10 text-ink' : 'bg-surface-sunken text-ink')}
              role="status"
              data-testid="hugo-goal-result"
              data-outcome={g.last.outcome}
            >
              {g.last.outcome === 'done' ? (
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-positive" aria-hidden="true" />
              ) : g.last.outcome === 'pending' ? (
                <Hourglass className="mt-0.5 h-4 w-4 shrink-0 text-info" aria-hidden="true" />
              ) : (
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-negative" aria-hidden="true" />
              )}
              <div className="min-w-0 flex-1">
                <p className="font-medium">{result.word}</p>
                <p className="break-words text-xs text-ink-muted">{g.last.title}</p>
                {result.why && <p className="mt-0.5 text-xs text-ink">{result.why}</p>}
                {g.last.linkUrl && (
                  <Link to={g.last.linkUrl} onClick={onNavigate} className="mt-1 inline-flex min-h-8 items-center gap-1 text-xs font-medium text-accent underline-offset-2 hover:underline coarse:min-h-11">
                    {t('hugoWork.open')}
                    <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </Link>
                )}
              </div>
            </div>
          )}

          {g?.summary && !open && <p className="mt-1.5 text-sm leading-relaxed text-ink" data-testid="hugo-goal-summary">{g.summary}</p>}

          <div className="mt-2 flex flex-wrap items-center gap-x-1 gap-y-1">
            {lines.length > 0 && (
              <Button size="sm" variant="ghost" className="h-8 px-2" aria-expanded={expanded} onClick={() => setExpanded((x) => !x)}>
                {expanded ? <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />}
                {expanded ? t('hugoWork.trail.hide') : t('hugoWork.trail.show', { count: lines.length })}
              </Button>
            )}
            {open && !pending && (
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto h-8 px-2 text-ink-muted"
                aria-label={t('hugoWork.stopAria', { title: g?.text ?? '' })}
                loading={busy === stopKey}
                disabled={busy !== null && busy !== stopKey}
                onClick={() => setConfirmStop(true)}
              >
                {t('hugoWork.stop')}
              </Button>
            )}
          </div>

          {expanded && lines.length > 0 && (
            <ol className="mt-1 space-y-1.5 border-l border-line pl-3" aria-label={t('hugoWork.trail.label')} data-testid="hugo-goal-trail">
              {lines.map(({ e, line }) => (
                <li key={e.id} className="relative text-xs text-ink-muted">
                  <span className="absolute -left-[15px] top-1.5 h-1.5 w-1.5 rounded-full bg-line" aria-hidden="true" />
                  <span className="break-words text-ink">{line}</span>
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
        description={t('hugoWork.goal.stopConfirm')}
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
