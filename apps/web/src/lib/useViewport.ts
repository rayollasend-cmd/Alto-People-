import { useEffect, useState, useSyncExternalStore } from 'react';

/**
 * Whether the window is at least `px` wide — Tailwind's `sm:` is 640.
 *
 * For the few places a phone needs a different SHAPE, not just different
 * spacing, so CSS alone can't do it. jsdom has no real matchMedia; the
 * test setup stubs min-width queries as matching, so tests see desktop
 * unless they override it.
 */
export function useMinWidth(px: number): boolean {
  const query = `(min-width: ${px}px)`;
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === 'undefined' || !window.matchMedia) return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener?.('change', onChange);
      return () => mql.removeEventListener?.('change', onChange);
    },
    () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : true),
    () => true,
  );
}

export interface VisibleViewport {
  /** Distance from the layout viewport's top to what the user can see. */
  top: number;
  /** How tall the visible part is — the screen minus the keyboard. */
  height: number;
}

function readVisible(): VisibleViewport | null {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  return vv ? { top: vv.offsetTop, height: vv.height } : null;
}

/**
 * The part of the screen the user can actually see, keyboard excluded.
 *
 * iOS Safari doesn't shrink the page when the keyboard opens — it lays the
 * keyboard over the bottom and pans what's visible, so a `100dvh` panel
 * runs on underneath the keyboard and whatever sits in its lower half is
 * out of reach. `visualViewport` is the one thing that reports the real
 * visible box on both iOS and Android. Null where there's none (jsdom),
 * and callers fall back to CSS. Only listens while `active`.
 */
export function useVisibleViewport(active: boolean): VisibleViewport | null {
  const [vp, setVp] = useState<VisibleViewport | null>(readVisible);
  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!active || !vv) return;
    const update = () => setVp(readVisible());
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, [active]);
  return vp;
}
