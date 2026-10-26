import { useEffect, useState } from 'react';
import { Sparkles } from '@/components/ui/icons';
import { HugoMascot, isHugo } from '@/components/hugo/HugoMascot';
import { useAssistant } from '@/lib/assistantContext';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/cn';
import '@/lib/i18n/en/hugoPane';

/**
 * Hugo, one thumb away on a phone: a round button above the tab bar, bottom
 * right — where a thumb rests on the floor. Phones only (the top bar has
 * the button from md up); gone while the panel is open.
 *
 * It steps out of the way while the page scrolls down (the content under it
 * is what the person is reading) and comes back on the way up.
 */
export function HugoLauncher() {
  const { available, me, open, toggle } = useAssistant();
  const { t } = useI18n();
  const [tucked, setTucked] = useState(false);

  useEffect(() => {
    const scroller = document.querySelector('main');
    if (!scroller) return;
    let last = scroller.scrollTop;
    const onScroll = () => {
      const y = scroller.scrollTop;
      if (Math.abs(y - last) < 8) return;
      setTucked(y > last && y > 80);
      last = y;
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, []);

  if (!available || !me || open) return null;
  const hugo = isHugo(me.name);
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={t('hugoPane.ask', { name: me.name })}
      data-testid="hugo-launcher"
      className={cn(
        'fixed right-4 z-30 grid h-14 w-14 place-items-center rounded-full border border-accent/50 bg-surface-raised shadow-lg shadow-black/30 md:hidden',
        'bottom-[calc(4.5rem+env(safe-area-inset-bottom))] transition-[transform,opacity] duration-200 active:scale-95',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
        tucked && 'pointer-events-none translate-y-6 opacity-0',
      )}
    >
      {hugo ? (
        // On a soft gold disc, like the top bar's: navy on navy needs the lift.
        <span className="grid h-12 w-12 place-items-center rounded-full bg-accent-fill/25">
          <HugoMascot pose="face" size={42} />
        </span>
      ) : (
        <Sparkles className="h-6 w-6 text-accent" aria-hidden="true" />
      )}
    </button>
  );
}
