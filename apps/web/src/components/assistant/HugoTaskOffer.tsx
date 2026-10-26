import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { HugoTaskOffer as Offer, HugoTaskView } from '@alto-people/shared';
import { Check } from '@/components/ui/icons';
import { Button } from '@/components/ui/Button';
import { startHugoTask } from '@/lib/hugoApi';
import { useI18n } from '@/lib/i18n';
import '@/lib/i18n/en/hugoWork';
import { TASK_ICON } from './HugoTaskCard';
import { hugoWorkError, taskDoes, taskTitle } from './hugoWorkText';

/**
 * Work the chat offers to take on: what Hugo will do, said plainly, and a
 * Start the person taps — or doesn't. Started, it says so in place and
 * points to the Tasks tab, where it runs.
 */
export function HugoTaskOfferCard({ offer, onSeeTasks }: { offer: Offer; onSeeTasks: (taskId: string) => void }) {
  const { t, lang } = useI18n();
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
  const view = { kind: offer.task.kind, subject: offer.subject };
  const title = taskTitle(view, t, lang);
  const Icon = TASK_ICON[offer.task.kind];
  return (
    <div className="mt-2 rounded-xl border border-line bg-surface p-3" role="group" aria-label={t('hugoWork.offer.aria', { title })} data-testid="hugo-offer">
      <div className="flex gap-2.5">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent-fill/15 text-accent" aria-hidden="true">
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-ink">{title}</div>
          <div className="mt-0.5 text-xs leading-relaxed text-ink-muted">{taskDoes(view, t)}</div>
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
          {start.error && (
            <p className="mt-2 text-sm text-negative" role="alert">
              {hugoWorkError(start.error, t)}
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
