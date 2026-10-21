import { cn } from '@/lib/cn';
import { toneColor, type Tone } from './palette';

/**
 * A micro trend line — dependency-free SVG, sized for a KPI tile or a
 * table cell. The vertical scale is padded so a series that barely moved
 * (100, 101, 100) reads as the near-flat line it is, not a cliff: the
 * domain is at least ±10% around its middle, and never dips below zero
 * for a series that can't.
 *
 * Decorative by default (`aria-hidden`) — the tile's delta chip or the
 * row's numbers carry the meaning. Pass `label` when the line stands
 * alone and should be announced.
 */

export interface SparklineProps {
  series: Array<number | null | undefined>;
  /** Stroke color by meaning; 'current' inherits the text color (className). */
  tone?: Tone | 'current';
  width?: number;
  height?: number;
  /** Soft fill under the line. */
  area?: boolean;
  /** A dot on the latest point. */
  showLast?: boolean;
  /** Announced as an image when given. */
  label?: string;
  className?: string;
}

/** The padded vertical domain for a series — exported for tests and other minis. */
export function sparkDomain(values: number[]): [number, number] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const mid = (min + max) / 2;
  const span = Math.max(max - min, Math.abs(mid) * 0.2) || 1;
  let lo = mid - (span / 2) * 1.1;
  const hi = mid + (span / 2) * 1.1;
  if (min >= 0 && lo < 0) lo = 0;
  return [lo, hi];
}

export function Sparkline({ series, tone = 'current', width = 88, height = 24, area = true, showLast = true, label, className }: SparklineProps) {
  const points = series.map((v, i) => ({ i, v })).filter((p): p is { i: number; v: number } => typeof p.v === 'number' && Number.isFinite(p.v));
  if (points.length < 2) return null;
  const [lo, hi] = sparkDomain(points.map((p) => p.v));
  const pad = 2;
  const x = (i: number) => pad + (i / Math.max(series.length - 1, 1)) * (width - pad * 2);
  const y = (v: number) => height - pad - ((v - lo) / (hi - lo)) * (height - pad * 2);
  const line = points.map((p) => `${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const fill = `${x(first.i).toFixed(1)},${height - 1} ${line} ${x(last.i).toFixed(1)},${height - 1}`;
  const stroke = tone === 'current' ? 'currentColor' : toneColor(tone);
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn('shrink-0 overflow-visible', tone === 'current' && 'text-gold/70', className)}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
      {area && <polygon points={fill} fill={stroke} opacity={0.12} />}
      <polyline points={line} fill="none" stroke={stroke} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />
      {showLast && <circle cx={x(last.i)} cy={y(last.v)} r={2.25} fill={stroke} />}
    </svg>
  );
}
