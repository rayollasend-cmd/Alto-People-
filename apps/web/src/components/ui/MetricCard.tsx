import * as React from 'react';
import { cn } from '@/lib/cn';
import { Card, CardContent } from './Card';

export interface MetricTrend {
  /** Weekly values, oldest first (last bucket = in-progress week). */
  series: number[];
  /** Change of the last complete week vs the one before (absolute). */
  delta: number;
  /** Appended after the delta number, e.g. "vs last wk". */
  deltaLabel?: string;
}

export interface MetricCardProps {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  /** When true, value renders in warning instead of gold — for "needs attention" tiles. */
  accent?: boolean;
  /** Micro-sparkline + delta chip rendered under the value. */
  trend?: MetricTrend;
  /** Direction color is contextual: for metrics where growth is bad
   *  (pending reviews, anomalies), pass false so ↑ renders as alert. */
  deltaPositiveIsGood?: boolean;
  /** Wraps the card in a link with hover affordance. Pair with React Router's Link via asChild patterns. */
  href?: string;
  /** Render-prop wrapper for non-anchor links (Router Link, button, etc.). */
  wrap?: (children: React.ReactElement) => React.ReactElement;
  className?: string;
}

/* ----------------------------------------------------------- count-up */

/** Matches plain numbers and en-US grouped numeric strings ("1,234.5"). */
const NUMERIC_RE = /^-?\d{1,3}(,\d{3})*(\.\d+)?$|^-?\d+(\.\d+)?$/;

interface NumericTarget {
  target: number;
  /** Decimal places + grouping of the original, preserved per frame. */
  decimals: number;
  grouped: boolean;
}

function parseNumeric(value: React.ReactNode): NumericTarget | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { target: value, decimals: Number.isInteger(value) ? 0 : 1, grouped: false };
  }
  if (typeof value === 'string' && NUMERIC_RE.test(value.trim())) {
    const raw = value.trim();
    const target = Number(raw.replace(/,/g, ''));
    if (!Number.isFinite(target)) return null;
    const frac = raw.split('.')[1];
    return { target, decimals: frac ? frac.length : 0, grouped: raw.includes(',') };
  }
  return null;
}

function formatFrame(n: number, t: NumericTarget): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: t.decimals,
    maximumFractionDigits: t.decimals,
    useGrouping: t.grouped,
  });
}

const COUNT_UP_MS = 600;

/**
 * Animates a numeric value 0→N once per mount (~600ms, ease-out cubic).
 * Skips entirely — rendering the final value — for non-numeric values,
 * under prefers-reduced-motion, and on later value changes (a KPI that
 * refetches shouldn't re-run the intro flourish).
 */
export function CountUpValue({ value }: { value: React.ReactNode }) {
  // Parsed once on mount: only the value present at mount animates.
  const [initial] = React.useState<NumericTarget | null>(() => {
    // Defensive matchMedia probe: jsdom (unit tests) doesn't implement
    // it — treat "can't ask" like "reduce" and render the final value.
    if (
      typeof window === 'undefined' ||
      typeof window.matchMedia !== 'function' ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      return null;
    }
    return parseNumeric(value);
  });
  const [display, setDisplay] = React.useState<string | null>(
    initial ? formatFrame(0, initial) : null
  );
  const doneRef = React.useRef(initial === null);

  React.useEffect(() => {
    if (!initial) return;
    let raf = 0;
    const startedAt = performance.now();
    const tick = (t: number) => {
      const progress = Math.min((t - startedAt) / COUNT_UP_MS, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(formatFrame(initial.target * eased, initial));
      if (progress < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        doneRef.current = true;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // Mount-only by design — see doc comment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A changed value after the mount animation (or a non-numeric one)
  // renders as-is; mid-animation we show the animated frame.
  if (doneRef.current || display === null) return <>{value}</>;
  return <>{display}</>;
}

/* ---------------------------------------------------------- sparkline */

const SPARK_W = 64;
const SPARK_H = 20;

/**
 * Dependency-free micro-sparkline: a bare polyline in currentColor at low
 * opacity. Decorative only (`aria-hidden`) — the delta chip carries the
 * accessible summary of the trend.
 */
export function Sparkline({
  series,
  className,
}: {
  series: number[];
  className?: string;
}) {
  if (series.length < 2) return null;
  const min = Math.min(...series);
  const max = Math.max(...series);
  const range = max - min || 1;
  const points = series
    .map((v, i) => {
      const x = (i / (series.length - 1)) * (SPARK_W - 2) + 1;
      const y = SPARK_H - 1.5 - ((v - min) / range) * (SPARK_H - 3);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg
      width={SPARK_W}
      height={SPARK_H}
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      aria-hidden="true"
      className={cn('shrink-0 opacity-40', className)}
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* --------------------------------------------------------- delta chip */

const fmtDelta = (n: number) =>
  Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 1 });

/** "↑ 6 vs last wk" / "↓ 3" / "—". Zero always renders the neutral dash. */
export function DeltaChip({
  delta,
  deltaLabel,
  positiveIsGood = true,
}: {
  delta: number;
  deltaLabel?: string;
  positiveIsGood?: boolean;
}) {
  const flat = delta === 0;
  const good = (delta > 0) === positiveIsGood;
  const tone = flat ? 'text-silver' : good ? 'text-success' : 'text-alert';
  const arrow = flat ? '—' : delta > 0 ? '↑' : '↓';
  return (
    <span className={cn('text-[11px] tabular-nums whitespace-nowrap', tone)}>
      <span aria-hidden="true">{arrow}</span>
      <span className="sr-only">
        {flat ? 'unchanged' : delta > 0 ? 'up' : 'down'}
      </span>
      {!flat && <> {fmtDelta(delta)}</>}
      {deltaLabel && <span className="text-silver/70"> {deltaLabel}</span>}
    </span>
  );
}

/* --------------------------------------------------------- metric card */

/**
 * KPI tile used across dashboards. Encapsulates the
 *   uppercase label → big-number → optional hint
 * pattern so AnalyticsHome, VtoHome, and the per-module dashboards stop
 * inlining their own copies. Numeric values count up on first mount;
 * pass `trend` for a micro-sparkline + week-over-week delta chip.
 */
export function MetricCard({
  label,
  value,
  hint,
  accent,
  trend,
  deltaPositiveIsGood = true,
  href,
  wrap,
  className,
}: MetricCardProps) {
  const isInteractive = Boolean(href || wrap);
  const card = (
    <Card interactive={isInteractive} className={cn('group', className)}>
      <CardContent className="pt-5">
        <div className="text-[10px] uppercase tracking-widest text-silver">
          {label}
        </div>
        <div
          className={cn(
            'font-display text-3xl mt-2 leading-none tabular-nums',
            accent ? 'text-warning' : 'text-gold',
          )}
        >
          <CountUpValue value={value} />
        </div>
        {trend && (
          <div className="mt-2 flex items-center gap-2 text-silver">
            <Sparkline series={trend.series} />
            <DeltaChip
              delta={trend.delta}
              deltaLabel={trend.deltaLabel}
              positiveIsGood={deltaPositiveIsGood}
            />
          </div>
        )}
        {hint && <div className="text-xs text-silver mt-2">{hint}</div>}
        {isInteractive && (
          <div className="text-[10px] uppercase tracking-widest mt-3 text-gold/80 group-hover:text-gold-bright transition-colors inline-flex items-center gap-1">
            View details
            <span aria-hidden="true" className="transition-transform group-hover:translate-x-0.5">
              →
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
  if (wrap) return wrap(card);
  if (href) return <a href={href}>{card}</a>;
  return card;
}
