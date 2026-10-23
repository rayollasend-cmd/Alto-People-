import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { cn } from '@/lib/cn';

/**
 * The recruiting pages as one set of tabs under the title (F500
 * 2026-10-22): the pipeline, job postings, offers, interview kits,
 * referrals and analytics. Job postings — what candidates apply to — sat
 * three levels deep behind a text link called "Interviewing & offers".
 * Each is still its own URL (notifications link /recruiting/extras?tab=offers),
 * so these are links, not a tab widget.
 */
export type RecruitingHubKey = 'pipeline' | 'postings' | 'offers' | 'kits' | 'referrals' | 'analytics';

export const RECRUITING_HUB: ReadonlyArray<{ key: RecruitingHubKey; label: string; to: string }> = [
  { key: 'pipeline', label: 'Pipeline', to: '/recruiting' },
  { key: 'postings', label: 'Job postings', to: '/recruiting/extras?tab=postings' },
  { key: 'offers', label: 'Offers', to: '/recruiting/extras?tab=offers' },
  { key: 'kits', label: 'Interview kits', to: '/recruiting/extras?tab=kits' },
  { key: 'referrals', label: 'Referrals', to: '/recruiting/extras?tab=referrals' },
  { key: 'analytics', label: 'Analytics', to: '/recruiting/analytics' },
];

export function RecruitingHubNav({ current }: { current: RecruitingHubKey }) {
  const { search } = useLocation();
  // On a phone the strip scrolls sideways: fade the edge with more past it
  // and keep the page you are on in view (the same as the Tabs strip).
  const listRef = useRef<HTMLUListElement | null>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const update = () => setEdges({ left: el.scrollLeft > 2, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2 });
    const active = el.querySelector<HTMLElement>('[aria-current="page"]');
    if (active && el.scrollWidth > el.clientWidth) el.scrollLeft = Math.max(0, active.offsetLeft - (el.clientWidth - active.offsetWidth) / 2);
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro?.disconnect();
    };
  }, [current]);
  const mask =
    edges.left || edges.right
      ? `linear-gradient(to right, ${edges.left ? 'transparent, black 2rem' : 'black'}, ${edges.right ? 'black calc(100% - 2rem), transparent' : 'black'})`
      : undefined;
  return (
    <nav aria-label="Recruiting" className="-mt-2 md:-mt-4">
      <ul
        ref={listRef}
        style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
        className="flex flex-nowrap gap-1 overflow-x-auto border-b border-navy-secondary scrollbar-none"
      >
        {RECRUITING_HUB.map((item) => {
          const active = item.key === current;
          // The pipeline keeps its own filters when you come back to it.
          const to = item.key === 'pipeline' && current === 'pipeline' ? `/recruiting${search}` : item.to;
          return (
            <li key={item.key} className="shrink-0">
              <Link
                to={to}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'relative -mb-px block whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium transition-colors coarse:min-h-11 coarse:text-base',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright focus-visible:ring-offset-2 focus-visible:ring-offset-midnight',
                  active ? 'border-gold text-gold' : 'border-transparent text-silver hover:text-ink',
                )}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
