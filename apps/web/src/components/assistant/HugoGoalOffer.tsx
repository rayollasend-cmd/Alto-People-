import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { HugoTaskOffer as Offer, HugoTaskView } from '@alto-people/shared';
import { Check, Target } from '@/components/ui/icons';
import { Button } from '@/components/ui/Button';
import { startHugoTask } from '@/lib/hugoApi';
import { useI18n } from '@/lib/i18n';
import '@/lib/i18n/en/hugoWork';
import { goalStartError } from './hugoGoalText';
import { hugoWorkError } from './hugoWorkText';

/**
 * A goal the chat offers to take on: the outcome in the person's words, what
 * Hugo will do about it, and Start — or nothing. Started, it says so in
 * place and points to the Tasks tab, where he plans it.
 */
export function HugoGoalOfferCard({ offer, onSeeTasks }: { offer: Offer; onSeeTasks: (taskId: string) => void }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [started, setStarted] = useState<{ task: HugoTaskView; existing: boolean } | null>(null);
  const start = useMutation({
    mutationFn: () => startHugoTask(offer.task, 'chat'),
    onSuccess: (r) => {
      setStarted(r);
      void queryClient.invalidateQueries({ queryKey: ['hugo', 'tasks'] });
      void queryClient.invalidateQueries({ queryKey: ['hugo', 'summary'] });
    },
  });
  const goal = offer.subject.goal ?? (offer.task.kind === 'GOAL' ? offer.task.goal : '');
  const failed = start.error ? (goalStartError(start.error) ? t(goalStartError(start.error)!) : hugoWorkError(start.error, t)) : null;
  return (
    <div className="mt-2 rounded-xl border border-line bg-surface p-3" role="group" aria-label={t('hugoWork.offer.aria', { title: goal })} data-testid="hugo-goal-offer">
      <div className="flex gap-2.5">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent-fill/15 text-accent" aria-hidden="true">
          <Target className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium uppercase tracking-wider text-ink-muted">{t('hugoWork.goal.label')}</div>
          <div className="break-words text-sm font-medium text-ink">{goal}</div>
          <div className="mt-0.5 text-xs leading-relaxed text-ink-muted">{t('hugoWork.goal.hint')}</div>
        </div>
      </div>
      {started ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-2 text-sm text-ink-muted" role="status">
          <Check className="h-4 w-4 text-positive" aria-hidden="true" />
          <span>{started.existing ? t('hugoWork.offer.existing') : t('hugoWork.offer.started')}</span>
          <Button size="sm" variant="link" className="h-auto px-0" onClick={() => onSeeTasks(started.task.id)}>
            {t('hugoWork.offer.see')}
          </Button>
        </div>
      ) : (
        <>
          {failed && (
            <p className="mt-2 text-sm text-negative" role="alert">
              {failed}
            </p>
          )}
          <div className="mt-2.5">
            <Button size="sm" onClick={() => start.mutate()} loading={start.isPending}>
              {t('hugoWork.offer.start')}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
