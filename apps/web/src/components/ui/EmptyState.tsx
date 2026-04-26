import * as React from 'react';
import { type LucideIcon } from 'lucide-react';
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
}: {
  icon?: LucideIcon;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center py-12 px-6 rounded-lg border border-dashed border-navy-secondary bg-navy/40',
        className
      )}
    >
      {Icon && (
        <div className="mb-4 h-12 w-12 rounded-full bg-navy-secondary/60 grid place-items-center">
          <Icon className="h-6 w-6 text-silver" aria-hidden="true" />
        </div>
      )}
      <h3 className="font-display text-xl text-white mb-1">{title}</h3>
      {description && (
        <p className="text-sm text-silver max-w-sm">{description}</p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
