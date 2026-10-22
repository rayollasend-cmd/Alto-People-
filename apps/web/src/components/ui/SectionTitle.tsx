import * as React from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * Mid-tier section header — the missing rung between the
 * `text-sm uppercase tracking-widest` micro-label and the
 * `font-display text-3xl` page hero. Use inside a Card, on a
 * sub-section, or as a group label for a stack of metric tiles.
 *
 * Anatomy:
 *   - Title in text-base font-medium text-white
 *   - Optional Lucide icon (h-4) pulled to text-silver/80 so gold stays
 *     reserved for actual data + CTAs.
 *   - Optional eyebrow rendered above (the micro-label tier) when you
 *     want both rungs visible.
 *   - Optional description in text-sm text-silver underneath.
 *   - Optional trailing slot for right-aligned controls (count badge,
 *     link, small action).
 *
 * Usage:
 *   <SectionTitle title="Team snapshot" icon={Activity} />
 *   <SectionTitle
 *     eyebrow="Today"
 *     title="Pending approvals"
 *     description="Timesheets and time-off requests waiting on you."
 *     trailing={<Link to="/team">Open team page →</Link>}
 *   />
 */

interface SectionTitleProps {
  title: React.ReactNode;
  icon?: LucideIcon;
  eyebrow?: React.ReactNode;
  description?: React.ReactNode;
  trailing?: React.ReactNode;
  /** Render the title in font-display for a touch more presence — use sparingly. */
  display?: boolean;
  /**
   * md (default): a section of a page. sm: a card's own label in a dense
   * grid of cards (the client portal's tiles) — the same rung, one step
   * smaller, so a dozen tiles don't shout over the page title.
   */
  size?: 'md' | 'sm';
  /**
   * A long title with controls beside it: the title wraps instead of
   * truncating, and the trailing slot drops under it on a narrow screen.
   */
  wrap?: boolean;
  as?: 'h2' | 'h3' | 'h4';
  className?: string;
  id?: string;
}

export function SectionTitle({
  title,
  icon: Icon,
  eyebrow,
  description,
  trailing,
  display = false,
  size = 'md',
  wrap = false,
  as: As = 'h2',
  className,
  id,
}: SectionTitleProps) {
  return (
    <div className={cn('mb-3', className)}>
      {eyebrow && (
        <div className="text-2xs uppercase tracking-[0.18em] text-silver/80 mb-1.5">
          {eyebrow}
        </div>
      )}
      <div className={cn('flex items-center justify-between gap-3', wrap && 'flex-wrap gap-y-1')}>
        <div className="flex items-center gap-2 min-w-0">
          {Icon && (
            <Icon
              className="h-4 w-4 text-silver/80 shrink-0"
              aria-hidden="true"
            />
          )}
          <As
            id={id}
            className={cn(
              'text-white leading-tight',
              !wrap && 'truncate',
              display ? 'text-xl' : size === 'sm' ? 'text-sm font-medium' : 'text-base font-medium',
            )}
          >
            {title}
          </As>
        </div>
        {trailing && <div className="shrink-0">{trailing}</div>}
      </div>
      {description &&
        (typeof description === 'string' || typeof description === 'number' ? (
          <p className="text-sm text-silver mt-1">{description}</p>
        ) : (
          // A control or block passed as the description can't sit inside a <p>.
          <div className="text-sm text-silver mt-1">{description}</div>
        ))}
    </div>
  );
}
