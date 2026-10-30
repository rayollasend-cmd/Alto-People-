import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { HugoRemembered } from '@alto-people/shared';
import { Bookmark, Check } from '@/components/ui/icons';
import { ApiError } from '@/lib/api';
import { removeHugoMemory } from '@/lib/hugoApi';
import { useI18n } from '@/lib/i18n';
import '@/lib/i18n/en/hugoPane';
import { cn } from '@/lib/cn';

/**
 * Under an answer that kept something (or forgot something): "Saved to
 * what Hugo knows · Undo". The words open What Hugo knows; Undo removes
 * what this answer kept — at once, no second question — and says so.
 */
export function HugoMemoryChip({ name, remembered, forgot, onOpen }: { name: string; remembered?: HugoRemembered[]; forgot?: number; onOpen: () => void }) {
  const { t } = useI18n();
  const [undone, setUndone] = useState(false);
  const undo = useMutation({
    mutationFn: async (items: HugoRemembered[]) => {
      // Already gone (removed in the list meanwhile) is still undone.
      for (const r of items) {
        try {
          await removeHugoMemory(r.id, 'undo');
        } catch (err) {
          if (!(err instanceof ApiError && err.status === 404)) throw err;
        }
      }
    },
    onSuccess: () => setUndone(true),
  });
  const kept = remembered ?? [];
  const link = 'inline-flex min-h-8 items-center rounded px-1 hover:text-ink hover:underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright coarse:min-h-11';

  if (undone) {
    return (
      <p role="status" className="mt-1 flex items-center gap-1 pl-1 text-xs text-ink-muted" data-testid="hugo-memory-chip">
        <Check className="h-3.5 w-3.5 text-positive" aria-hidden="true" />
        {t('hugoPane.memory.undone')}
      </p>
    );
  }
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-0.5 pl-1 text-xs text-ink-muted" data-testid="hugo-memory-chip">
      <Bookmark className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
      <button type="button" className={link} onClick={onOpen}>
        {kept.length ? t('hugoPane.memory.saved', { name }) : forgot ? t('hugoPane.memory.forgotChip', { name }) : null}
      </button>
      {kept.length > 0 && (
        <>
          <span aria-hidden="true">·</span>
          <button type="button" className={cn(link, 'font-medium text-ink')} onClick={() => undo.mutate(kept)} disabled={undo.isPending} aria-busy={undo.isPending || undefined}>
            {t('hugoPane.memory.undo')}
          </button>
        </>
      )}
      {undo.isError && (
        <span role="alert" className="basis-full pl-5 text-negative">
          {t('hugoPane.memory.failed')}
        </span>
      )}
    </div>
  );
}
