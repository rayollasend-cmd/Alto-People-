import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';

/**
 * Pull-to-refresh for pages living inside the app shell.
 *
 * The shell locks body scroll and contains overscroll (deliberately — it
 * kills iOS rubber-banding), which also disables the browser's native
 * pull-to-refresh. This hook restores the gesture on the shell's own
 * scroller (#main-content): pull down >70px from the very top, release,
 * refresh. Touch-only — desktop and jsdom no-op.
 *
 * Listeners are passive (we never preventDefault), so scrolling
 * performance is untouched; the gesture piggybacks on the scroller
 * already being at scrollTop 0.
 */

export type PullState = 'idle' | 'armed' | 'refreshing';

const PULL_THRESHOLD_PX = 70;

export function usePullToRefresh(onRefresh: () => Promise<unknown> | unknown): PullState {
  const [state, setState] = useState<PullState>('idle');
  // Ref'd so consumers can pass a fresh closure every render without
  // tearing down the listeners.
  const cbRef = useRef(onRefresh);
  cbRef.current = onRefresh;

  useEffect(() => {
    const el = document.getElementById('main-content');
    if (!el || !('ontouchstart' in window)) return;

    let startY = 0;
    let tracking = false;
    let armed = false;
    let busy = false;

    const onTouchStart = (e: TouchEvent) => {
      if (busy) return;
      tracking = el.scrollTop <= 0;
      armed = false;
      startY = e.touches[0]?.clientY ?? 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!tracking || busy) return;
      const dy = (e.touches[0]?.clientY ?? 0) - startY;
      const nowArmed = dy > PULL_THRESHOLD_PX && el.scrollTop <= 0;
      if (nowArmed !== armed) {
        armed = nowArmed;
        setState(nowArmed ? 'armed' : 'idle');
      }
    };
    const onTouchEnd = () => {
      if (armed && !busy) {
        busy = true;
        setState('refreshing');
        Promise.resolve(cbRef.current()).finally(() => {
          busy = false;
          setState('idle');
        });
      } else if (!busy) {
        setState('idle');
      }
      tracking = false;
      armed = false;
    };

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('touchcancel', onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
    };
  }, []);

  return state;
}

/** Floating chip under the topbar while the gesture is live. */
export function PullToRefreshIndicator({ state }: { state: PullState }) {
  if (state === 'idle') return null;
  return (
    <div
      role="status"
      className="md:hidden fixed left-1/2 -translate-x-1/2 z-30 top-[calc(3.75rem+env(safe-area-inset-top))] inline-flex items-center gap-2 rounded-full border border-navy-secondary bg-navy px-3 py-1.5 text-xs text-silver elev-2 animate-fade-in"
    >
      <RefreshCw
        className={['h-3.5 w-3.5 text-gold', state === 'refreshing' ? 'animate-spin' : ''].join(' ')}
        aria-hidden="true"
      />
      {state === 'refreshing' ? 'Refreshing…' : 'Release to refresh'}
    </div>
  );
}
