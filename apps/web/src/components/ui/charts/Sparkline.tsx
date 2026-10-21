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
  /** Soft fill under the line, down to zero (or the edge nearest zero). */
  area?: boolean;
  /** A dot on the latest point. */
  showLast?: boolean;
  /** The last point is a period still in progress (this week so far):
   *  the stretch into it is dashed and its dot hollow, so a half-counted
   *  week doesn't read as a collapse. */
  lastIsPartial?: boolean;
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
  let hi = mid + (span / 2) * 1.1;
  if (min >= 0 && lo < 0) lo = 0;
  if (max < 0 && hi > 0) hi = 0;
  return [lo, hi];
}

type Pt = { i: number; v: number };

/** Runs of consecutive real values — a missing point breaks the line instead of bridging it. */
function segmentsOf(series: SparklineProps['series']): Pt[][] {
  const out: Pt[][] = [];
  let cur: Pt[] = [];
  series.forEach((v, i) => {
    if (typeof v === 'number' && Number.isFinite(v)) cur.push({ i, v });
    else if (cur.length) {
      out.push(cur);
      cur = [];
    }
  });
  if (cur.length) out.push(cur);
  return out;
}

export function Sparkline({ series, tone = 'current', width = 88, height = 24, area = true, showLast = true, lastIsPartial = false, label, className }: SparklineProps) {
  const segments = segmentsOf(series);
  const points = segments.flat();
  if (points.length < 2) return null;
  const [lo, hi] = sparkDomain(points.map((p) => p.v));
  const pad = 2;
  const x = (i: number) => pad + (i / Math.max(series.length - 1, 1)) * (width - pad * 2);
  const y = (v: number) => height - pad - ((v - lo) / (hi - lo)) * (height - pad * 2);
  // The fill closes on zero when zero is on the scale, else on the edge nearest it.
  const base = y(lo > 0 ? lo : hi < 0 ? hi : 0);
  const fmt = (p: Pt) => `${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`;
  const last = points[points.length - 1]!;
  const partial = lastIsPartial && last.i === series.length - 1;
  // With a partial last point, the solid line stops one short and a dashed stretch reaches it.
  const solid = segments.map((seg) => (partial && seg[seg.length - 1] === last ? seg.slice(0, -1) : seg)).filter((seg) => seg.length > 0);
  const lastSeg = segments[segments.length - 1]!;
  const beforeLast = partial && lastSeg.length >= 2 ? lastSeg[lastSeg.length - 2]! : null;
  const stroke = tone === 'current' ? 'currentColor' : toneColor(tone);
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn('shrink-0 overflow-visible', tone === 'current' && 'text-gold/70', className)}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
      {area &&
        solid
          .filter((seg) => seg.length >= 2)
          .map((seg) => (
            <polygon
              key={`a${seg[0]!.i}`}
              points={`${x(seg[0]!.i).toFixed(1)},${base.toFixed(1)} ${seg.map(fmt).join(' ')} ${x(seg[seg.length - 1]!.i).toFixed(1)},${base.toFixed(1)}`}
              fill={stroke}
              opacity={0.12}
            />
          ))}
      {solid.map((seg) =>
        seg.length >= 2 ? (
          <polyline key={`l${seg[0]!.i}`} points={seg.map(fmt).join(' ')} fill="none" stroke={stroke} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />
        ) : (
          <circle key={`p${seg[0]!.i}`} cx={x(seg[0]!.i)} cy={y(seg[0]!.v)} r={1.25} fill={stroke} />
        ),
      )}
      {beforeLast && <line x1={x(beforeLast.i)} y1={y(beforeLast.v)} x2={x(last.i)} y2={y(last.v)} stroke={stroke} strokeWidth={1.5} strokeDasharray="2 2" strokeLinecap="round" />}
      {showLast &&
        (partial ? (
          <circle cx={x(last.i)} cy={y(last.v)} r={2.25} fill="none" stroke={stroke} strokeWidth={1.25} />
        ) : (
          <circle cx={x(last.i)} cy={y(last.v)} r={2.25} fill={stroke} />
        ))}
    </svg>
  );
}
