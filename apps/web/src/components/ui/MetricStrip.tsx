import * as React from 'react';
import { cn } from '@/lib/cn';
import { MetricStripContext } from './MetricCard';

/**
 * The row of KPI tiles at the top of a page or a section — one layout for
 * every strip (G6 found 82 tiles hand-gridded on finance pages alone):
 *
 *   - two tiles a row on a phone, compact (half height, hint hidden), so
 *     the list under the strip starts on the first screen instead of
 *     1,000px down; four a row from `lg`;
 *   - never one tile stranded alone on a row: an odd tile spans the row it
 *     ends, and 3, 5 and 6 tiles get a column count that divides them;
 *   - `empty`: the list the strip summarises is empty, so four "0" tiles
 *     would say nothing. `true` hides the strip; a node replaces it with one
 *     quiet line ("No call-outs in the last 7 days · 96% covered last month").
 *
 * Pass MetricCards as direct children (null / false children are skipped).
 * Give every tile an `href` to the list behind its number, or `onClick` +
 * `selected` when the tiles are the page's filter.
 */

const COLS: Record<number, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-2',
  3: 'grid-cols-2 lg:grid-cols-3',
  4: 'grid-cols-2 lg:grid-cols-4',
  5: 'grid-cols-2 lg:grid-cols-3 xl:grid-cols-5',
  6: 'grid-cols-2 lg:grid-cols-3',
};
const DEFAULT_COLS = 'grid-cols-2 lg:grid-cols-4';

/** The last tile's span, so the last row is full: base (2 columns) then lg/xl. */
function lastSpan(n: number): string {
  if (n === 3) return 'col-span-2 lg:col-span-1';
  if (n === 5) return 'col-span-2 lg:col-span-2 xl:col-span-1';
  if (n <= 6) return '';
  const base = n % 2 === 1 ? 'col-span-2' : '';
  const lg = { 0: 'lg:col-span-1', 1: 'lg:col-span-4', 2: 'lg:col-span-3', 3: 'lg:col-span-2' }[n % 4]!;
  return cn(base, lg);
}

export interface MetricStripProps {
  children: React.ReactNode;
  /**
   * The list the strip summarises is empty. `true` hides the strip; a node
   * shows that one line instead of a row of zeros.
   */
  empty?: boolean | React.ReactNode;
  /** Accessible name for the group of tiles ("Payroll at a glance"). */
  label?: string;
  className?: string;
}

export function MetricStrip({ children, empty, label, className }: MetricStripProps) {
  const tiles = React.Children.toArray(children).filter(Boolean);
  if (empty === true || tiles.length === 0) return null;
  if (empty !== undefined && empty !== null && empty !== false) {
    return (
      <p className={cn('text-sm text-ink-muted', className)} data-metric-strip-empty="">
        {empty}
      </p>
    );
  }
  const n = tiles.length;
  const span = lastSpan(n);
  return (
    <MetricStripContext.Provider value={{ inStrip: true }}>
      <div role="group" aria-label={label} className={cn('grid gap-2 sm:gap-3', COLS[n] ?? DEFAULT_COLS, className)} data-metric-strip="">
        {tiles.map((tile, i) => (
          <div key={React.isValidElement(tile) && tile.key != null ? tile.key : i} className={cn('min-w-0', i === n - 1 && span)}>
            {tile}
          </div>
        ))}
      </div>
    </MetricStripContext.Provider>
  );
}
