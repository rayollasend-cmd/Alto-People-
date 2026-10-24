import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { Skeleton } from '../../Skeleton';
import { useChartHeight } from '../frame';
import { resolveChartColors, type EChartColors } from './colors';
import { loadEcharts, type EChartsCoreOption, type EChartsType } from './engine';

export interface EChartProps {
  /**
   * The figure, built from the resolved palette. Called again when the
   * theme flips — keep it stable (useCallback on the data) or every render
   * redraws.
   */
  build: (colors: EChartColors) => EChartsCoreOption;
  /** Fixed height in px; inside a ChartFrame the plot box decides. */
  height?: number;
  /** A click on a node, cell or link. */
  onClick?: (params: { name?: string; data?: unknown; dataType?: string }) => void;
  className?: string;
}

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * One ECharts figure. The engine loads on first use (./engine); until then
 * the plot box shows a skeleton. Colours follow the theme: the figure is
 * rebuilt when <html data-theme> changes — watched directly, because the
 * theme provider applies the attribute in its own effect, after this
 * component's effects have run.
 *
 * The drawing is aria-hidden: ChartFrame carries the figure for assistive
 * tech (its one-sentence summary and the always-present data table).
 */
export function EChart({ build, height, onClick, className }: EChartProps) {
  const h = useChartHeight(height, 280);
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<EChartsType | null>(null);
  const [ready, setReady] = useState(false);
  const [themeTick, setThemeTick] = useState(0);
  const clickRef = useRef(onClick);
  clickRef.current = onClick;

  useEffect(() => {
    let cancelled = false;
    let ro: ResizeObserver | undefined;
    // eslint-disable-next-line no-restricted-syntax -- a code-split module, not data: nothing for a query cache to hold
    void loadEcharts().then((echarts) => {
      if (cancelled || !el.current) return;
      const c = echarts.init(el.current, undefined, { renderer: 'svg' });
      chart.current = c;
      c.on('click', (p) => clickRef.current?.(p as { name?: string; data?: unknown; dataType?: string }));
      if (typeof ResizeObserver !== 'undefined') {
        ro = new ResizeObserver(() => c.resize());
        ro.observe(el.current);
      }
      setReady(true);
    });
    return () => {
      cancelled = true;
      ro?.disconnect();
      chart.current?.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return;
    const mo = new MutationObserver(() => setThemeTick((t) => t + 1));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);

  useEffect(() => {
    const c = chart.current;
    if (!ready || !c) return;
    const option = build(resolveChartColors());
    c.setOption({ animation: !prefersReducedMotion(), ...option }, { notMerge: true });
  }, [ready, build, themeTick]);

  return (
    <div className={cn('relative w-full', className)} style={{ height: h }}>
      <div ref={el} className="absolute inset-0" aria-hidden="true" />
      {!ready && <Skeleton className="absolute inset-0 rounded-md" />}
    </div>
  );
}
