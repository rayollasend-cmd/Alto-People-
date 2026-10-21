import { useState } from 'react';
import { cn } from '@/lib/cn';
import { toneColor, type Tone } from './palette';

/**
 * Rows × columns, one cell per pair, shaded in a single hue — more is
 * darker (sequential: one hue, light → dark, never a rainbow). Built as a
 * real table, so a screen reader walks it by row and column header; every
 * cell has a label and a native tooltip, and a tapped cell reads its
 * figure out under the grid (hover never fires on a phone).
 *
 * Empty (null) cells stay blank — "no data" is not "zero".
 */

export interface HeatmapAxisItem {
  key: string;
  label: string;
  /** Shorter header for narrow columns ("6a"). Defaults to label. */
  short?: string;
}

export interface HeatmapProps {
  /** Names the table for assistive tech. */
  caption: string;
  rows: HeatmapAxisItem[];
  columns: HeatmapAxisItem[];
  /** values[row][column]; null = no data. */
  values: Array<Array<number | null>>;
  /** Hue of the ramp. 'bad' for lateness, call-outs and other counts that should stand out. */
  tone?: Tone;
  /** Top of the scale; defaults to the largest value. */
  max?: number;
  format?: (v: number) => string;
  /** The spoken/tooltip text for one cell. */
  cellLabel?: (row: HeatmapAxisItem, column: HeatmapAxisItem, value: number | null) => string;
  /** Print the figure in each cell (best for ≤ 12 columns). */
  showValues?: boolean;
  /** Only every nth column header is printed (the label stays on the cell). */
  headerEvery?: number;
  onCellClick?: (row: HeatmapAxisItem, column: HeatmapAxisItem, value: number | null) => void;
  /** Scale ends for the key under the grid. */
  legend?: { low: string; high: string };
  /** Highlights one row header (today). */
  currentRow?: string;
  className?: string;
}

export function Heatmap({
  caption,
  rows,
  columns,
  values,
  tone = 'primary',
  max,
  format = (v) => v.toLocaleString(),
  cellLabel,
  showValues = false,
  headerEvery = 1,
  onCellClick,
  legend,
  currentRow,
  className,
}: HeatmapProps) {
  const color = toneColor(tone);
  const top = max ?? Math.max(0, ...values.flat().filter((v): v is number => typeof v === 'number'));
  const [picked, setPicked] = useState<string | null>(null);
  const label = (r: HeatmapAxisItem, c: HeatmapAxisItem, v: number | null) =>
    cellLabel ? cellLabel(r, c, v) : `${r.label}, ${c.label}: ${v === null ? 'no data' : format(v)}`;

  return (
    <div className={className}>
      <div className="overflow-x-auto">
        <table className="w-full border-separate" style={{ borderSpacing: 2 }}>
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              <td />
              {columns.map((c, ci) => (
                <th key={c.key} scope="col" className="px-0.5 pb-1 text-center text-2xs font-normal text-ink-muted">
                  <span aria-hidden={ci % headerEvery !== 0 ? true : undefined}>{ci % headerEvery === 0 ? (c.short ?? c.label) : ''}</span>
                  {ci % headerEvery !== 0 && <span className="sr-only">{c.label}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={r.key}>
                <th scope="row" className={cn('whitespace-nowrap pr-2 text-left text-2xs font-normal', currentRow === r.key ? 'font-medium text-gold' : 'text-ink-muted')}>
                  {r.label}
                </th>
                {columns.map((c, ci) => {
                  const v = values[ri]?.[ci] ?? null;
                  const intensity = v === null || top <= 0 ? 0 : Math.max(0, Math.min(1, v / top));
                  const text = label(r, c, v);
                  const strong = intensity > 0.6;
                  const body = (
                    <>
                      {v !== null && v !== 0 && <span aria-hidden="true" className="absolute inset-0 rounded-sm" style={{ background: color, opacity: 0.12 + intensity * 0.8 }} />}
                      {showValues && v !== null && (
                        <span aria-hidden="true" className={cn('relative text-2xs tabular-nums', strong ? 'font-medium text-on-solid' : 'text-ink')}>
                          {format(v)}
                        </span>
                      )}
                    </>
                  );
                  const cellClass = cn(
                    'relative grid h-7 min-w-6 w-full place-items-center rounded-sm',
                    v === null ? 'bg-transparent outline-dashed outline-1 -outline-offset-1 outline-line' : 'bg-surface-raised/40',
                  );
                  return (
                    <td key={c.key} className="p-0" title={text}>
                      <button
                        type="button"
                        aria-label={text}
                        className={cn(cellClass, 'focus:outline-none focus-visible:ring-1 focus-visible:ring-gold', onCellClick && 'cursor-pointer hover:ring-1 hover:ring-gold/60')}
                        onClick={() => {
                          setPicked((cur) => (cur === text ? null : text));
                          onCellClick?.(r, c, v);
                        }}
                      >
                        {body}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={cn('mt-1 min-h-5 text-xs transition-opacity', picked ? 'text-ink opacity-100' : 'opacity-0')} aria-live="polite">
        {picked ?? ''}
      </div>
      {legend && (
        <div className="flex items-center gap-1.5 text-2xs text-ink-muted">
          {legend.low}
          <span className="flex gap-px" aria-hidden="true">
            {[0.12, 0.3, 0.5, 0.72, 0.92].map((o) => (
              <span key={o} className="h-2.5 w-3 rounded-sm" style={{ background: color, opacity: o }} />
            ))}
          </span>
          {legend.high}
        </div>
      )}
    </div>
  );
}
