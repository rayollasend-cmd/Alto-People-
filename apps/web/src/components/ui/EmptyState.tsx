import * as React from 'react';
import { type LucideIcon } from '@/components/ui/icons';
import { cn } from '@/lib/cn';

/**
 * Standard empty-state pattern: icon + title + description + optional CTA.
 * Replaces the bare "No results" text scattered through the old pages.
 *
 * Usage:
 *   <EmptyState
 *     icon={Calendar}
 *     title="No shifts scheduled"
 *     description="Create your first shift to start staffing."
 *     action={<Button onClick={openCreate}>New shift</Button>}
 *   />
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  size = 'md',
}: {
  icon?: LucideIcon;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  /**
   * md: the block a page or a card shows when it has nothing (a heading).
   * sm: one quiet line inside a section — a drawer's history, a card's
   * list — same voice, no heading, no wasted height.
   */
  size?: 'md' | 'sm';
}) {
  if (size === 'sm') {
    return (
      <div
        role="status"
        className={cn(
          'flex items-start gap-2 rounded-md border border-dashed border-line px-3 py-2.5 text-left',
          'group-data-[card]/card:border-transparent group-data-[card]/card:px-0',
          className
        )}
      >
        {Icon && <Icon className="mt-0.5 h-4 w-4 shrink-0 text-ink-muted" aria-hidden="true" />}
        <div className="min-w-0 text-sm">
          <p className="text-ink">{title}</p>
          {description && <div className="text-xs text-ink-muted">{description}</div>}
          {action && <div className="mt-2">{action}</div>}
        </div>
      </div>
    );
  }
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center py-12 px-6 rounded-lg border border-dashed border-navy-secondary bg-navy/40',
        // Inside a Card the card is the frame: no second, dashed one.
        'group-data-[card]/card:border-0 group-data-[card]/card:bg-transparent',
        className
      )}
    >
      {Icon && (
        <div className="mb-4 h-12 w-12 rounded-full bg-navy-secondary/60 grid place-items-center">
          <Icon className="h-6 w-6 text-silver" aria-hidden="true" />
        </div>
      )}
      {/* h2, not h3: EmptyState sits directly under the page's h1 in
          practice, and an h1 → h3 jump trips axe's heading-order rule.
          Skipped entirely when callers pass an empty title (e.g. the
          Expirations buckets) — an empty <h2> trips axe's empty-heading. */}
      {title && <h2 className="text-xl text-ink mb-1">{title}</h2>}
      {/* A <div>, not a <p>: a description may hold a <details> or a list
          (Reliability's "what this covers"), which a <p> can't contain. */}
      {description && (
        <div className="text-sm text-ink-muted max-w-sm">{description}</div>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
