import { useEffect, useState } from 'react';
import { Sparkles } from '@/components/ui/icons';
import { HugoMascot, isHugo } from '@/components/hugo/HugoMascot';
import { useAssistant } from '@/lib/assistantContext';
import { HugoBadge, useHugoBadgeLabel } from './HugoBadge';
import { moodFace, useHugoMood } from './hugoMood';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/cn';
import '@/lib/i18n/en/hugoPane';

/**
 * Hugo, one thumb away on a phone: a round button above the tab bar, bottom
 * right — where a thumb rests on the floor. Phones only (the top bar has
 * the button from md up); gone while the panel is open.
 *
 * It steps out of the way while the page scrolls down (the content under it
 * is what the person is reading) and comes back on the way up — but not
 * while something of Hugo's needs them (the badge stays in reach).
 *
 * Big enough to read as him, not an icon: his face fills the button,
 * blinking, in his headphones while he works on something for them.
 */
export function HugoLauncher() {
  const { available, me, open, toggle, summary } = useAssistant();
  const { t } = useI18n();
  const [tucked, setTucked] = useState(false);
  const label = useHugoBadgeLabel(t('hugoPane.ask', { name: me?.name ?? '' }));
  const mood = useHugoMood();

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
      aria-label={label}
      data-testid="hugo-launcher"
      className={cn(
        'fixed right-4 z-30 grid h-16 w-16 place-items-center rounded-full border border-accent/50 bg-surface-raised shadow-lg shadow-black/30 md:hidden',
        'bottom-[calc(4.5rem+env(safe-area-inset-bottom))] transition-[transform,opacity] duration-200 active:scale-95',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
        tucked && !summary?.needsYou && 'pointer-events-none translate-y-6 opacity-0',
      )}
    >
      <span className="relative grid h-14 w-14 place-items-center">
        {hugo ? (
          <HugoMascot pose={moodFace(mood)} size={56} />
        ) : (
          <Sparkles className="h-6 w-6 text-accent" aria-hidden="true" />
        )}
        <HugoBadge className="-right-1.5 -top-1.5" />
      </span>
    </button>
  );
}
