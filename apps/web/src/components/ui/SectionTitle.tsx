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
  as: As = 'h2',
  className,
  id,
}: SectionTitleProps) {
  return (
    <div className={cn('mb-3', className)}>
      {eyebrow && (
        <div className="text-[10px] uppercase tracking-[0.18em] text-silver/80 mb-1.5">
          {eyebrow}
        </div>
      )}
      <div className="flex items-center justify-between gap-3">
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
              'text-white leading-tight truncate',
              display ? 'font-display text-xl' : 'text-base font-medium',
            )}
          >
            {title}
          </As>
        </div>
        {trailing && <div className="shrink-0">{trailing}</div>}
      </div>
      {description && (
        <p className="text-sm text-silver mt-1">{description}</p>
      )}
    </div>
  );
}
