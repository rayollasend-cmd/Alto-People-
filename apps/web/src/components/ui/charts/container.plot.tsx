import { useLayoutEffect, useRef, useState, type ComponentProps } from 'react';
import { ResponsiveContainer as RechartsContainer } from 'recharts';

type Props = ComponentProps<typeof RechartsContainer>;
type Dim = { width: number; height: number };

/**
 * recharts' ResponsiveContainer, measured before it draws.
 *
 * recharts 3 renders its container once at -1 × -1 (its `initialDimension`)
 * and only then measures in an effect, so every chart mount logged "The
 * width(-1) and height(-1) of chart should be greater than 0" — 103 page loads
 * in the 2026-10-29 crawl (CRAWL-17, MONEY-30, PEOPLE-25) — and a chart in a
 * hidden or collapsed box (a closed tab, a 0-width column) drew at nothing.
 *
 * This box measures itself in a layout effect (before paint) and mounts the
 * chart only once it has a size, handing recharts that size as its first
 * dimension; a box that is still 0 × 0 waits for its ResizeObserver. Where
 * there is no layout engine (jsdom, no ResizeObserver) the chart mounts at
 * once, as before. Same props as recharts' own; plot files import it from
 * here (design-lint rejects ResponsiveContainer straight from recharts).
 */
export function ResponsiveContainer({ width = '100%', height = '100%', children, ...rest }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const noLayout = typeof ResizeObserver === 'undefined';
  const [initial, setInitial] = useState<Dim | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (noLayout || initial || !el) return;
    const take = (w: number, h: number): boolean => {
      if (w <= 0 && h <= 0) return false;
      setInitial({ width: Math.round(w), height: Math.round(h) });
      return true;
    };
    const box = el.getBoundingClientRect();
    if (take(box.width, box.height)) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r && take(r.width, r.height)) ro.disconnect();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [noLayout, initial]);
  return (
    // minWidth 0, as recharts' own box: a flex item otherwise never shrinks below its chart.
    <div ref={ref} style={{ width, height, minWidth: 0 }} data-chart-box="">
      {noLayout ? (
        <RechartsContainer width="100%" height="100%" {...rest}>
          {children}
        </RechartsContainer>
      ) : initial ? (
        <RechartsContainer width="100%" height="100%" initialDimension={initial} {...rest}>
          {children}
        </RechartsContainer>
      ) : null}
    </div>
  );
}
