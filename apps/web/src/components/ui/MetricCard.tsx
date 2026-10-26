import * as React from 'react';
import { Link, useInRouterContext } from 'react-router-dom';
import type { LucideIcon } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { Card, CardContent } from './Card';
import { Sparkline as KitSparkline } from './charts/Sparkline';
import { PALETTE } from './charts/palette';

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

/**
 * What a tile's colour means. `default` is the data colour — ink, like the
 * rest of the page: gold is punctuation (docs/design-system.md), and a
 * strip of gold numbers read as links and made zeros look like news (F500
 * audit 2026-10-26). `accent` is the one hero figure a page leads with;
 * `warning` / `alert` ask for attention, `good` reports good news, and
 * `neutral` is for a fact that is neither (and for "nothing to count").
 * A ZERO never wears warning or alert: "0 overdue" in red reads as a
 * problem (Hotline's five red/amber zero tiles) — the tile drops to the
 * default colour on its own.
 */
export type MetricTone = 'default' | 'accent' | 'neutral' | 'good' | 'warning' | 'alert';

/** A change with no sparkline: "↑ 3 vs last week". */
export interface MetricDelta {
  value: number;
  label?: string;
  /** Which direction is good news (default 'up'). */
  good?: TrendGood;
  format?: (n: number) => string;
}

export interface MetricCardProps {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  /** Colour by meaning — see MetricTone. */
  tone?: MetricTone;
  /** @deprecated Use `tone="warning"`. Kept for existing callers. */
  accent?: boolean;
  /** A small icon beside the label (home focus tiles). */
  icon?: LucideIcon;
  /** Micro-sparkline + delta chip rendered under the value. */
  trend?: MetricTrend;
  /** A delta chip without a sparkline. Ignored when `trend` draws. */
  delta?: MetricDelta;
  /** A change already in words ("+4 pts", "Score 72"), toned by meaning. */
  deltaText?: { text: string; tone?: 'good' | 'bad' | 'neutral' } | null;
  /** A unit after the value, in small type ("/ 12", "hrs"). */
  unit?: string;
  /** A 0–100 meter under the value, in the series colour or a state colour. */
  meter?: { percent: number; tone?: 'primary' | 'good' | 'warn' | 'bad' } | null;
  /** Direction color is contextual: for metrics where growth is bad
   *  (pending reviews, anomalies), pass false so ↑ renders as alert. */
  deltaPositiveIsGood?: boolean;
  /** Which direction is good — colors the line and the chip. Overrides
   *  deltaPositiveIsGood; 'neutral' keeps both in the quiet tone. */
  trendGood?: TrendGood;
  /**
   * HONEST EMPTY. Set when the tile has nothing to count — its denominator
   * is zero, nothing is set up yet, no readings have come in: say so in
   * words ("No shifts today", "No positions set up", "No readings yet").
   * The sentence replaces the value and the hint, in the neutral tone,
   * and the tile never shows a 0 dressed as good news ("0 / 0 · Every
   * shift filled", "0h of 0h · all approved"). Leave it unset when a zero
   * is a real answer over a real population ("0 late of 40 shifts").
   */
  nothing?: React.ReactNode;
  /** Wraps the card in a link (React Router's Link for an in-app path). */
  href?: string;
  /** Makes the tile a button — with `selected`, a tile that IS a filter
   *  (the list under the strip shows that bucket). */
  onClick?: () => void;
  /** The tile's filter is the one applied (aria-pressed). Use with onClick. */
  selected?: boolean;
  /** Render-prop wrapper for anything else (a custom button, a tooltip). */
  wrap?: (children: React.ReactElement) => React.ReactElement;
  /** The "View details →" line on a linked tile. Off for a band of tiles
   *  that are all links, where it repeats on every one (and always off
   *  inside a MetricStrip). */
  cta?: boolean;
  /** Phone-compact: half height below `sm` (hint and sparkline hidden).
   *  On by default inside a MetricStrip. */
  compact?: boolean;
  /** Full text for the value's tooltip when `value` is not plain text. */
  valueTitle?: string;
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
    const parsed = parseNumeric(value);
    // Nothing to count up to: a zero renders as itself (it used to animate 0→0).
    return parsed && parsed.target !== 0 ? parsed : null;
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
      // A frame's timestamp can precede the effect's performance.now(): clamp,
      // or the first frame's negative progress printed "-0".
      const progress = Math.max(0, Math.min((t - startedAt) / COUNT_UP_MS, 1));
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

/** Set by MetricStrip: tiles inside a strip are compact on phones and drop the per-tile CTA. */
export const MetricStripContext = React.createContext<{ inStrip: boolean }>({ inStrip: false });

/** "0", "$0", "$0.00", "0%", "0h" — a value that counts nothing. */
const ZERO_RE = /^\s*[-+]?[$€£]?\s*0+(?:[.,]0+)?\s*(?:%|h|hrs?)?\s*$/;
export function isZeroValue(value: React.ReactNode): boolean {
  if (typeof value === 'number') return value === 0;
  return typeof value === 'string' && ZERO_RE.test(value);
}

/** The tone a tile actually wears: warning/alert never colour a zero. */
export function effectiveTone(tone: MetricTone, value: React.ReactNode): MetricTone {
  return (tone === 'warning' || tone === 'alert') && isZeroValue(value) ? 'default' : tone;
}

const VALUE_TONE: Record<MetricTone, string> = {
  default: 'text-ink',
  accent: 'text-gold',
  neutral: 'text-ink',
  good: 'text-success',
  warning: 'text-warning',
  alert: 'text-alert',
};
const ICON_TONE: Record<MetricTone, string> = {
  default: 'text-ink-muted',
  accent: 'text-ink-muted',
  neutral: 'text-ink-muted',
  good: 'text-success',
  warning: 'text-warning',
  alert: 'text-alert',
};
const BORDER_TONE: Partial<Record<MetricTone, string>> = {
  warning: 'border-warning/30',
  alert: 'border-alert/40',
};

/**
 * Money never clips: the value is sized by clamp() for the viewport, and if
 * the tile is still too narrow for it (six tiles in a side column, a long
 * dollar figure) the font steps down to fit before the ellipsis is the
 * last resort. The full value is always in the tooltip.
 */
function useFitValue(ref: React.RefObject<HTMLElement | null>, key: unknown) {
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let lastWidth = -1;
    const fit = () => {
      const width = el.clientWidth;
      if (width === lastWidth || width === 0) return;
      lastWidth = width;
      el.style.fontSize = '';
      if (el.scrollWidth <= width) return;
      const base = parseFloat(getComputedStyle(el).fontSize);
      if (!Number.isFinite(base)) return;
      el.style.fontSize = `${Math.max(14, Math.floor(base * (width / el.scrollWidth) * 0.97))}px`;
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, key]);
}

/**
 * THE KPI tile — one for the whole app (audits found six: MetricCard,
 * StatTile, the home focus tiles, finance's FinKpi, transport's boxes,
 * the associate's numbers). Label → value → optional delta → hint:
 *
 *   - `tone` colours by meaning, and never colours a zero (see MetricTone);
 *   - `nothing` is the honest empty ("No shifts today") — never a fake 0;
 *   - `href` links to the list behind the number; `onClick` + `selected`
 *     make the tile a filter (the strip replaces a row of duplicate chips);
 *   - the value fits its tile (clamp + step-down + ellipsis + tooltip);
 *   - lay tiles out with MetricStrip, which is two-up and compact on a
 *     phone and never strands one tile alone on a row.
 *
 * Numeric values count up on first mount; pass `trend` for a
 * micro-sparkline + week-over-week delta chip, or `delta` for the chip alone.
 */
export function MetricCard({
  label,
  value,
  hint,
  tone: toneProp,
  accent,
  icon: Icon,
  trend,
  delta,
  deltaText,
  unit,
  meter,
  deltaPositiveIsGood = true,
  trendGood,
  nothing,
  href,
  onClick,
  selected,
  wrap,
  cta = true,
  compact: compactProp,
  valueTitle,
  className,
}: MetricCardProps) {
  const { inStrip } = React.useContext(MetricStripContext);
  const inRouter = useInRouterContext();
  const compact = compactProp ?? inStrip;
  const isEmpty = nothing !== undefined && nothing !== null && nothing !== false;
  const tone: MetricTone = isEmpty ? 'neutral' : effectiveTone(toneProp ?? (accent ? 'warning' : 'default'), value);
  const isInteractive = Boolean(href || wrap || onClick);
  const good: TrendGood = trendGood ?? (deltaPositiveIsGood ? 'up' : 'down');
  const showTrend = !isEmpty && trend !== undefined && trendDrawable(trend);
  const showDelta = !isEmpty && !showTrend && delta !== undefined && Number.isFinite(delta.value);
  const valueRef = React.useRef<HTMLDivElement>(null);
  useFitValue(valueRef, typeof value === 'string' || typeof value === 'number' ? value : null);
  const tip = valueTitle ?? (typeof value === 'string' || typeof value === 'number' ? String(value) : undefined);

  const card = (
    <Card
      interactive={isInteractive}
      className={cn(
        'group min-w-0',
        (inStrip || isInteractive) && 'h-full',
        BORDER_TONE[tone],
        selected && 'border-gold/70 bg-gold/[0.06] elev-2',
        className,
      )}
    >
      <CardContent
        className={cn(
          'pt-[var(--d-tile)]',
          compact && 'p-3 first:pt-3 sm:p-[var(--d-card)] sm:pt-[var(--d-tile)] sm:first:pt-[var(--d-tile)]',
          Icon && 'relative',
        )}
      >
        {/* The one canonical KPI label spec (audits found three); two lines, never cut mid-word. */}
        <div
          className={cn(
            // Tighter tracking on a phone, so a two-up tile's label fits its two lines.
            'min-w-0 font-medium uppercase tracking-[0.08em] text-silver/70 line-clamp-2 sm:tracking-[0.14em]',
            compact ? 'text-2xs sm:text-xs2' : 'text-xs2',
            Icon && 'pr-6',
          )}
          title={label}
        >
          {label}
        </div>
        {Icon && (
          <Icon
            className={cn(
              'absolute h-4 w-4',
              compact ? 'right-3 top-3 sm:right-[var(--d-card)] sm:top-[var(--d-tile)]' : 'right-[var(--d-card)] top-[var(--d-tile)]',
              ICON_TONE[tone],
            )}
            aria-hidden="true"
          />
        )}
        {isEmpty ? (
          <div className={cn('text-sm leading-snug text-ink-muted line-clamp-2', compact ? 'mt-1 sm:mt-2 sm:text-base' : 'mt-2 text-base')}>{nothing}</div>
        ) : (
          <div
            ref={valueRef}
            data-metric-value=""
            title={tip}
            className={cn(
              'overflow-hidden text-ellipsis whitespace-nowrap font-display leading-tight tabular-nums',
              'text-[length:clamp(1.25rem,0.9rem_+_1.4vw,var(--d-value))]',
              compact ? 'mt-1 sm:mt-2' : 'mt-2',
              VALUE_TONE[tone],
            )}
          >
            <CountUpValue value={value} />
            {unit && <span className="ml-1 font-sans text-sm text-silver">{unit}</span>}
          </div>
        )}
        {!isEmpty && deltaText && (
          <div
            className={cn(
              'mt-1 text-2xs font-medium tabular-nums sm:text-xs',
              deltaText.tone === 'good' ? 'text-success' : deltaText.tone === 'bad' ? 'text-alert' : 'text-silver/70',
            )}
          >
            {deltaText.text}
          </div>
        )}
        {!isEmpty && meter && <Meter percent={meter.percent} tone={meter.tone} />}
        {/* A line of nothing (all zero) or of NaN says nothing: no sparkline then (finance walk 3). */}
        {showTrend && (
          <div className={cn('mt-2 min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-silver', compact ? 'hidden sm:flex' : 'flex')}>
            <KitSparkline series={trend!.series} tone={sparkTone(trend!.delta, good)} lastIsPartial={trend!.lastIsPartial} />
            <DeltaChip delta={trend!.delta} deltaLabel={trend!.deltaLabel} good={good} format={trend!.format} />
            <span className="sr-only">{trendSummary(trend!, good)}</span>
          </div>
        )}
        {showDelta && (
          <div className={cn('min-w-0', compact ? 'mt-1 sm:mt-2' : 'mt-2')}>
            <DeltaChip delta={delta!.value} deltaLabel={delta!.label} good={delta!.good ?? good} format={delta!.format} />
          </div>
        )}
        {hint && !isEmpty && <div className={cn('mt-2 text-xs text-silver', compact && 'hidden sm:block')}>{hint}</div>}
        {isInteractive && cta && !inStrip && (
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
  const linkClass = 'block h-full min-w-0 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-gold';
  if (wrap) return wrap(card);
  if (onClick) {
    return (
      <button type="button" onClick={onClick} aria-pressed={selected ?? undefined} className={cn(linkClass, 'w-full text-left')}>
        {card}
      </button>
    );
  }
  if (href) {
    // An in-app path goes through the router: a bare <a> reloaded the whole app.
    if (inRouter && href.startsWith('/')) {
      return (
        <Link to={href} className={linkClass}>
          {card}
        </Link>
      );
    }
    return (
      <a href={href} className={linkClass}>
        {card}
      </a>
    );
  }
  return card;
}

const METER_COLOR = {
  primary: PALETTE.primary,
  good: PALETTE.good,
  warn: PALETTE.warn,
  bad: PALETTE.bad,
} as const;

/** A same-hue meter: the track is the fill colour at 18%. */
function Meter({ percent, tone = 'primary' }: { percent: number; tone?: keyof typeof METER_COLOR }) {
  const color = METER_COLOR[tone];
  return (
    <div
      className="mt-2 h-1.5 w-full overflow-hidden rounded-full"
      style={{ background: `color-mix(in srgb, ${color} 18%, transparent)` }}
      aria-hidden="true"
    >
      <div
        className="h-full rounded-full transition-[width] duration-500 ease-out"
        style={{ width: `${Math.max(0, Math.min(100, percent))}%`, background: color }}
      />
    </div>
  );
}

/** The line wears the change's meaning; a flat or neutral trend stays quiet gold. */
function sparkTone(delta: number, good: TrendGood): 'good' | 'bad' | 'current' {
  const m = trendMeaning(delta, good);
  return m === 'good' ? 'good' : m === 'bad' ? 'bad' : 'current';
}
