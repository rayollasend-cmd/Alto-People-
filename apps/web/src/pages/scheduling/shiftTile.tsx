import { createContext, useContext } from 'react';
import { Check, X } from 'lucide-react';
import type { ShiftStatus } from '@alto-people/shared';
import { cn } from '@/lib/cn';

/**
 * Shared visual language for shift tiles.
 *
 * Four surfaces render a shift rectangle — the compact week matrix, the
 * time-grid week, the day view, and the month grid — and before this module
 * each had its own paddings, type sizes, and status glyph. They drifted:
 * the same shift read as three different weights depending on which tab you
 * were on. Everything a tile needs to look like the others now lives here.
 *
 * Two rules this module exists to enforce:
 *
 *  1. **Status is never carried by colour alone.** The old chips rendered
 *     `status[0]`, so COMPLETED and CANCELLED — opposite outcomes — both
 *     showed "C", separated only by badge hue. That fails WCAG 1.4.1 and it
 *     fails a tired manager at 6am. Status is now a distinct *shape* plus a
 *     screen-reader label, with the tile itself carrying a second cue
 *     (dashed border for drafts, struck-through and dimmed for cancelled).
 *
 *  2. **Nothing here may use `positionColor`'s raw HSL for text.** Those
 *     values are tuned for the dark navy surface; the app also ships a light
 *     theme where `--color-navy` is white, and `text-white` / `text-silver`
 *     are remapped in CSS (index.css:163). Inline colours skip that remap.
 *     Accent bars and low-alpha tints are fine in both themes; label colours
 *     must stay on Tailwind tokens.
 */

/* ===== Density ========================================================== */

export type TileDensity = 'comfortable' | 'compact';

/**
 * The week matrix is associate-rows × day-columns, so grid height is driven
 * by how many people are on the roster, not by tile height — most cells hold
 * a single shift. That means 'comfortable' costs almost nothing vertically
 * and is the right default; 'compact' stays available for the rare roster
 * deep enough that every pixel counts.
 */
export const TILE_DENSITY: Record<
  TileDensity,
  {
    /** Vertical padding on the tile's clickable body. */
    padY: string;
    /** Horizontal padding: left clears the accent bar + drag grip. */
    padX: string;
    /** Start–end time, the secondary datum. */
    time: string;
    /** Position name, the primary datum. */
    label: string;
    /** Floor so a tile stays a comfortable hit target even with short text. */
    minH: string;
    /** Gap between tiles stacked in one cell. */
    gap: string;
  }
> = {
  comfortable: {
    padY: 'py-1.5',
    padX: 'pl-7 pr-2.5',
    time: 'text-xs2',
    label: 'text-xs',
    minH: 'min-h-[34px]',
    gap: 'gap-1.5',
  },
  compact: {
    padY: 'py-1',
    padX: 'pl-6 pr-2',
    time: 'text-2xs',
    label: 'text-xs2',
    minH: 'min-h-[26px]',
    gap: 'gap-1',
  },
};

const DensityContext = createContext<TileDensity>('comfortable');

/**
 * Wraps the scheduling views so every tile picks up the manager's density
 * preference without threading a prop through four calendar components.
 * Defaults to 'comfortable' when absent, so the associate-facing calendar
 * renders correctly with no provider.
 */
export const TileDensityProvider = DensityContext.Provider;

export function useTileDensity(): (typeof TILE_DENSITY)[TileDensity] {
  return TILE_DENSITY[useContext(DensityContext)];
}

export function useTileDensityKey(): TileDensity {
  return useContext(DensityContext);
}

/* ===== Interaction affordances ========================================== */

/**
 * WCAG 2.2 SC 2.5.8 asks for 24×24 CSS px. The old drag grip was a bare
 * 12px icon and the resize rail 6px wide — fine with a mouse, unusable on
 * the tablets these schedules get built on. The icon stays visually small;
 * the padding around it does the work.
 */
export const GRIP_HIT =
  'p-1 text-silver/60 hover:text-gold cursor-grab active:cursor-grabbing no-print';
export const GRIP_ICON = 'h-3.5 w-3.5';

/** Horizontal resize rail (week matrix) — 10px of grab, 2px of paint. */
export const RESIZE_RAIL_X =
  'absolute right-0 top-0 bottom-0 w-2.5 flex items-center justify-center cursor-ew-resize hover:bg-gold/30 group no-print';
/** Vertical resize rail (time grid / day) — same idea, other axis. */
export const RESIZE_RAIL_Y =
  'absolute left-0 right-0 bottom-0 h-2.5 flex items-center justify-center cursor-ns-resize hover:bg-gold/30 group no-print';

/* ===== Status =========================================================== */

export const SHIFT_STATUS_LABEL: Record<ShiftStatus, string> = {
  DRAFT: 'Draft',
  OPEN: 'Open',
  ASSIGNED: 'Assigned',
  COMPLETED: 'Worked',
  CANCELLED: 'Cancelled',
};

/**
 * Tile-level status treatment, layered under the mark so status survives
 * even when the mark is clipped by a very short tile.
 */
export function statusTileClass(status: ShiftStatus): string {
  switch (status) {
    case 'DRAFT':
      // Dashed = "not published yet", the same convention the templates rail
      // uses for an unapplied template.
      return 'border-dashed';
    case 'CANCELLED':
      return 'opacity-55 saturate-50';
    default:
      return '';
  }
}

/** Position-label treatment — cancelled shifts read as struck from the plan. */
export function statusLabelClass(status: ShiftStatus): string {
  return status === 'CANCELLED' ? 'line-through decoration-1' : '';
}

/**
 * Status as a shape, not a letter. Each state is distinguishable without
 * colour (filled disc / hollow ring / dashed ring / check / cross) and
 * carries its word for assistive tech.
 */
export function StatusMark({
  status,
  className,
}: {
  status: ShiftStatus;
  className?: string;
}) {
  const label = SHIFT_STATUS_LABEL[status];
  const common = 'shrink-0 inline-flex items-center justify-center';

  let shape: React.ReactNode;
  switch (status) {
    case 'ASSIGNED':
      shape = <span className="h-2 w-2 rounded-full bg-success" />;
      break;
    case 'OPEN':
      shape = <span className="h-2 w-2 rounded-full border-[1.5px] border-warning" />;
      break;
    case 'DRAFT':
      shape = (
        <span className="h-2 w-2 rounded-full border-[1.5px] border-dashed border-silver/70" />
      );
      break;
    case 'COMPLETED':
      shape = <Check className="h-3 w-3 text-success" strokeWidth={3} />;
      break;
    case 'CANCELLED':
      shape = <X className="h-3 w-3 text-alert" strokeWidth={3} />;
      break;
  }

  return (
    <span className={cn(common, 'h-3 w-3', className)} title={label}>
      {shape}
      <span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * Legend for the status marks. The shapes are learnable but not innately
 * obvious, so the calendar surfaces one row of keys above the grid — the
 * same affordance every serious scheduling tool ships.
 */
export function StatusMarkLegend({ className }: { className?: string }) {
  const order: ShiftStatus[] = [
    'ASSIGNED',
    'OPEN',
    'DRAFT',
    'COMPLETED',
    'CANCELLED',
  ];
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-silver/70',
        className,
      )}
    >
      {order.map((s) => (
        <span key={s} className="inline-flex items-center gap-1">
          <StatusMark status={s} />
          {SHIFT_STATUS_LABEL[s]}
        </span>
      ))}
    </div>
  );
}
