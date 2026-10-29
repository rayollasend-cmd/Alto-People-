import { cn } from '@/lib/cn';
import { PALETTE } from './palette';

/**
 * A pipeline, stage by stage (2026-10-27): one horizontal bar per stage,
 * centred so the stages stack into a funnel, each as long as the stage's
 * value (the chairman's: weighted annual billing). Every row says itself in
 * words beside the bar — the stage and its count on the left, the headline
 * figure and its working on the right — so the drawing is never the only
 * place a number lives. A stage with nothing in it draws no bar: an empty
 * stage is a fact, not a sliver of colour.
 *
 * Plain HTML (no chart engine): it renders with the page and reflows on a
 * phone, where the bar drops under its words.
 */
export interface FunnelStage {
  key: string;
  label: string;
  /** The bar's length, against the largest stage. */
  value: number;
  /** Under the label: "3 prospects". */
  detail?: string;
  /** The right-hand headline: "$258k a year". */
  figure?: string;
  /** Under the figure: "$12.4k a week · 40% close". */
  figureDetail?: string;
}

export interface FunnelProps {
  stages: FunnelStage[];
  /** The bar's colour; one hue for one measure (default the second series colour — gold is punctuation). */
  color?: string;
  className?: string;
}

/** The smallest bar a stage with any value draws, as a share of the widest — visible, never mistaken for empty. */
export const FUNNEL_MIN_PCT = 2;

/**
 * Each stage's bar as a share of the widest stage, 0–100. Zero, negative and
 * missing values draw nothing (0); a tiny stage still shows FUNNEL_MIN_PCT.
 */
export function funnelWidths(values: ReadonlyArray<number>): number[] {
  const max = Math.max(0, ...values.filter((v) => Number.isFinite(v)));
  return values.map((v) => (max > 0 && Number.isFinite(v) && v > 0 ? Math.max(FUNNEL_MIN_PCT, (v / max) * 100) : 0));
}

export function Funnel({ stages, color = PALETTE.secondary, className }: FunnelProps) {
  const widths = funnelWidths(stages.map((s) => s.value));
  return (
    <ol className={cn('space-y-3', className)} data-testid="funnel">
      {stages.map((s, i) => {
        const w = widths[i]!;
        return (
          <li
            key={s.key}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 sm:grid-cols-[minmax(7rem,11rem)_minmax(0,1fr)_11rem]"
            data-testid={`funnel-stage-${s.key}`}
          >
            <div className="col-start-1 row-start-1 min-w-0">
              <div className="truncate text-sm font-medium text-ink">{s.label}</div>
              {s.detail && <div className="truncate text-xs2 text-ink-muted">{s.detail}</div>}
            </div>
            <div className="relative col-span-2 row-start-2 h-6 sm:col-span-1 sm:col-start-2 sm:row-start-1" aria-hidden="true">
              {w > 0 ? (
                <div className="absolute inset-y-0 rounded-md" style={{ left: `${(100 - w) / 2}%`, width: `${w}%`, background: color }} data-width={w.toFixed(1)} />
              ) : (
                <div className="absolute inset-x-0 top-1/2 h-px bg-line-subtle" />
              )}
            </div>
            {/* A fixed column, so every bar is centred on the same line. */}
            <div className="col-start-2 row-start-1 min-w-0 text-right tabular-nums sm:col-start-3">
              {s.figure && <div className="text-sm font-medium text-ink">{s.figure}</div>}
              {s.figureDetail && <div className="text-xs2 text-ink-muted">{s.figureDetail}</div>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
