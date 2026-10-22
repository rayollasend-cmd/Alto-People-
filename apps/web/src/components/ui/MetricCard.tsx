import * as React from 'react';
import { cn } from '@/lib/cn';
import { Card, CardContent } from './Card';
import { Sparkline as KitSparkline } from './charts/Sparkline';

export interface MetricTrend {
  /** Weekly values, oldest first. */
  series: number[];
  /** The last bucket is the week in progress: drawn hollow and dashed,
   *  and the spoken summary ends on the last complete week. */
  lastIsPartial?: boolean;
  /** Change of the last complete week vs the one before (absolute). */
  delta: number;
  /** Appended after the delta number, e.g. "vs last wk". */
  deltaLabel?: string;
  /** Formats the delta's size ("$1.2k", "3.5h"); defaults to a plain number. */
  format?: (n: number) => string;
  /** What one point is, for the screen-reader summary ("week"). */
  unit?: string;
}

/** Which direction is good news: 'down' for lateness, cost, open issues. */
export type TrendGood = 'up' | 'down' | 'neutral';

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
  /** Which direction is good — colors the line and the chip. Overrides
   *  deltaPositiveIsGood; 'neutral' keeps both in the quiet tone. */
  trendGood?: TrendGood;
  /** Wraps the card in a link with hover affordance. Pair with React Router's Link via asChild patterns. */
  href?: string;
  /** Render-prop wrapper for non-anchor links (Router Link, button, etc.). */
  wrap?: (children: React.ReactElement) => React.ReactElement;
  /** The "View details →" line on a linked tile. Off for a band of tiles
   *  that are all links, where it repeats on every one. */
  cta?: boolean;
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
  // State, not a ref: finishing must re-render. With a target of 0 every frame
  // reads "0", React skips the identical last frame, and a value that changed
  // mid-animation (0 → 10 once data arrives) would stay hidden behind "0".
  const [done, setDone] = React.useState(initial === null);

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
        setDone(true);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // Mount-only by design — see doc comment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A changed value after the mount animation (or a non-numeric one)
  // renders as-is; mid-animation we show the animated frame.
  if (done || display === null) return <>{value}</>;
  return <>{display}</>;
}

/* ---------------------------------------------------------- sparkline */

// The micro-sparkline now lives in the chart kit (padded domain, tone by
// meaning); re-exported here so existing imports keep working.
export { Sparkline } from './charts/Sparkline';

/* --------------------------------------------------------- delta chip */

const fmtDelta = (n: number) =>
  Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 1 });

/** Good, bad or flat — the meaning of a change given which way is good. */
export function trendMeaning(delta: number, good: TrendGood): 'good' | 'bad' | 'flat' {
  if (delta === 0 || good === 'neutral') return 'flat';
  return (delta > 0) === (good === 'up') ? 'good' : 'bad';
}

/** "↑ 6 vs last wk" / "↓ 3" / "—". Zero always renders the neutral dash. */
export function DeltaChip({
  delta,
  deltaLabel,
  positiveIsGood = true,
  good,
  format,
}: {
  delta: number;
  deltaLabel?: string;
  positiveIsGood?: boolean;
  good?: TrendGood;
  format?: (n: number) => string;
}) {
  const flat = delta === 0;
  const meaning = trendMeaning(delta, good ?? (positiveIsGood ? 'up' : 'down'));
  const tone =
    meaning === 'good' ? 'bg-success/10 text-success' : meaning === 'bad' ? 'bg-alert/10 text-alert' : 'bg-silver/10 text-silver';
  const arrow = flat ? '—' : delta > 0 ? '↑' : '↓';
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1 text-xs2 tabular-nums">
      <span className={cn('inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded-full px-1.5 py-px font-medium', tone)}>
        <span aria-hidden="true">{arrow}</span>
        <span className="sr-only">{flat ? 'unchanged' : delta > 0 ? 'up' : 'down'}</span>
        {!flat && <>{format ? format(Math.abs(delta)) : fmtDelta(delta)}</>}
      </span>
      {deltaLabel && (
        <span className="min-w-0 truncate text-silver/70" title={deltaLabel}>
          {deltaLabel}
        </span>
      )}
    </span>
  );
}

/** Worth drawing: at least two real points, not all zero, and a real change. */
export function trendDrawable(trend: MetricTrend): boolean {
  const pts = trend.series.filter((v) => typeof v === 'number' && Number.isFinite(v));
  return pts.length >= 2 && pts.some((v) => v !== 0) && Number.isFinite(trend.delta);
}

/** One sentence for a screen reader: where the line started, where it is, and the change. */
export function trendSummary(trend: MetricTrend, good: TrendGood): string {
  const all = trend.series.filter((v) => Number.isFinite(v));
  // A week still in progress isn't where the line "ended" — say it separately.
  const partial = trend.lastIsPartial && all.length >= 3 ? all[all.length - 1]! : null;
  const pts = partial === null ? all : all.slice(0, -1);
  if (pts.length < 2) return '';
  const f = (n: number) => (trend.format ? trend.format(n) : n.toLocaleString('en-US', { maximumFractionDigits: 1 }));
  const unit = trend.unit ?? 'week';
  const meaning = trendMeaning(trend.delta, good);
  const change =
    trend.delta === 0 ? 'unchanged' : `${trend.delta > 0 ? 'up' : 'down'} ${f(Math.abs(trend.delta))}${trend.deltaLabel ? ` ${trend.deltaLabel}` : ''}`;
  const soFar = partial === null ? '' : ` This ${unit} so far: ${f(partial)}.`;
  return `Over the last ${pts.length} complete ${unit}s: from ${f(pts[0]!)} to ${f(pts[pts.length - 1]!)}, ${change}${meaning === 'flat' ? '' : meaning === 'good' ? ' (better)' : ' (worse)'}.${soFar}`;
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
  trendGood,
  href,
  wrap,
  cta = true,
  className,
}: MetricCardProps) {
  const isInteractive = Boolean(href || wrap);
  const good: TrendGood = trendGood ?? (deltaPositiveIsGood ? 'up' : 'down');
  const card = (
    <Card interactive={isInteractive} className={cn('group', className)}>
      <CardContent className="pt-[var(--d-tile)]">
        {/* The one canonical KPI label spec (audits found three). */}
        <div className="text-xs2 font-medium uppercase tracking-[0.14em] text-silver/70">
          {label}
        </div>
        <div
          className={cn(
            'font-display text-[length:var(--d-value)] mt-2 leading-none tabular-nums',
            accent ? 'text-warning' : 'text-gold',
          )}
        >
          <CountUpValue value={value} />
        </div>
        {/* A line of nothing (all zero) or of NaN says nothing: no sparkline then (finance walk 3). */}
        {trend && trendDrawable(trend) && (
          <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-silver">
            <KitSparkline series={trend.series} tone={sparkTone(trend.delta, good)} lastIsPartial={trend.lastIsPartial} />
            <DeltaChip delta={trend.delta} deltaLabel={trend.deltaLabel} good={good} format={trend.format} />
            <span className="sr-only">{trendSummary(trend, good)}</span>
          </div>
        )}
        {hint && <div className="text-xs text-silver mt-2">{hint}</div>}
        {isInteractive && cta && (
          <div className="text-2xs uppercase tracking-widest mt-3 text-gold/80 group-hover:text-gold-bright transition-colors inline-flex items-center gap-1">
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

/** The line wears the change's meaning; a flat or neutral trend stays quiet gold. */
function sparkTone(delta: number, good: TrendGood): 'good' | 'bad' | 'current' {
  const m = trendMeaning(delta, good);
  return m === 'good' ? 'good' : m === 'bad' ? 'bad' : 'current';
}
