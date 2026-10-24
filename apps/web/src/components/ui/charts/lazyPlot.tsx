import { lazy, Suspense, useEffect, useRef, useState, type ComponentProps, type ComponentType } from 'react';
import { trackChunk } from '@/lib/chunkLoading';

/**
 * A chart's drawing, fetched when the chart nears the screen instead of
 * with the page.
 *
 * recharts is 120 KB gz. Imported statically, every page with a chart —
 * often below the fold — waited for it before painting anything: on a phone
 * (slow 4G, 4× CPU) that was ~0.6 s of download plus its parse ahead of the
 * page's own text, on 13 of the 19 role pages the 2026-10-24 sweep measured
 * (lighthouse/sweep.mjs). Now only `*.plot.tsx` files import recharts
 * (lint:design enforces it), and this wrapper loads them: the chart's frame
 * — its sized box, heading, legend — renders with the page, and the
 * placeholder fills that box until the drawing lands, so nothing moves.
 *
 * A chart further down the page waits until it is within a few hundred
 * pixels of view: the transport director's trends sit under the day's board,
 * and on a phone their 120 KB was still competing with the board's own data
 * (LCP 4.4 s on /transport, the slowest page swept). Where there is no
 * IntersectionObserver (jsdom) the drawing loads at once.
 *
 * The placeholder turns aria-busy once the drawing is on its way, like every
 * Skeleton: the visual-regression settle step waits for it to clear (and
 * grows the window to the page's height first, which brings every chart in).
 *
 *   const TrendLinePlot = lazyPlot(() => import('./TrendLine.plot').then((m) => ({ default: m.TrendLinePlot })));
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the bound mirrors React.lazy's own
export function lazyPlot<C extends ComponentType<any>>(load: () => Promise<{ default: C }>) {
  const Plot = lazy(() => trackChunk(load));
  function LazyPlot(props: ComponentProps<C>) {
    const near = useNearScreen();
    const box = 'h-full w-full animate-pulse rounded-md bg-navy-secondary/40';
    if (!near.seen) return <div ref={near.ref} className={box} aria-hidden="true" />;
    return (
      <Suspense fallback={<div className={box} aria-busy="true" aria-hidden="true" />}>
        <Plot {...(props as ComponentProps<typeof Plot>)} />
      </Suspense>
    );
  }
  return LazyPlot;
}

/** Ahead of view by this much, the drawing starts loading — about half a phone screen. */
const AHEAD = '400px 0px';

/** The element that scrolls this one: the shell's <main>, a drawer's body — or the window (null). */
function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if (oy === 'auto' || oy === 'scroll') return p;
  }
  return null;
}

/** Whether the element has come within AHEAD of its scroller's view (latched: once seen, always). */
function useNearScreen() {
  const ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const el = ref.current;
    if (seen || !el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setSeen(true);
      },
      { root: scrollerOf(el), rootMargin: AHEAD },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return { ref, seen };
}
