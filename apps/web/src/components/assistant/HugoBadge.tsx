import { hugoBadgeCount } from '@alto-people/shared';
import { useAssistant } from '@/lib/assistantContext';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/cn';
import '@/lib/i18n/en/hugoWork';

/**
 * What Hugo has for the person, on every way in to him: a count of what
 * needs them, finished unseen, or was noticed for them; and a soft ring
 * while he works in the background. Sits in a `relative` parent; it is
 * drawn only — the button it sits on says the count in its own name
 * (useHugoBadgeLabel), since a labelled button's content is not read.
 */
export function HugoBadge({ className }: { className?: string }) {
  const { summary } = useAssistant();
  const count = hugoBadgeCount(summary);
  const working = (summary?.working ?? 0) > 0;
  if (!count && !working) return null;
  return (
    <>
      {working && <span className="hugo-working-ring pointer-events-none absolute inset-0 rounded-full" aria-hidden="true" />}
      {count > 0 && (
        <span
          className={cn(
            'pointer-events-none absolute -right-1 -top-1 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-accent-fill px-1 text-[11px] font-semibold leading-none text-on-accent shadow-sm',
            className,
          )}
          data-testid="hugo-badge"
          aria-hidden="true"
        >
          {count > 9 ? '9+' : count}
        </span>
      )}
    </>
  );
}

/** A button's name with the badge in it: "Ask Hugo, 3 new from Hugo". */
export function useHugoBadgeLabel(base: string): string {
  const { summary, me } = useAssistant();
  const { t } = useI18n();
  const count = hugoBadgeCount(summary);
  return count ? `${base}, ${t('hugoWork.badge', { count, name: me?.name ?? '' })}` : base;
}
