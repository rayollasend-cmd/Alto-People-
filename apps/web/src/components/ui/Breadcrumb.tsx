import * as React from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * Compact breadcrumb trail. Renders nothing when given an empty list, so
 * pages can pass through whatever they have without conditionals.
 *
 * Usage:
 *   <Breadcrumb segments={[
 *     { label: 'Onboarding', to: '/onboarding' },
 *     { label: candidateName },
 *   ]} />
 */

export interface BreadcrumbSegment {
  label: string;
  /** When omitted, the segment renders as plain text (the current page). */
  to?: string;
}

interface BreadcrumbProps {
  segments: BreadcrumbSegment[];
  className?: string;
}

export function Breadcrumb({ segments, className }: BreadcrumbProps) {
  if (segments.length === 0) return null;
  return (
    <nav
      aria-label="Breadcrumb"
      className={cn('flex items-center gap-1 text-xs text-silver mb-2', className)}
    >
      {segments.map((seg, i) => {
        const isLast = i === segments.length - 1;
        return (
          <React.Fragment key={`${seg.label}-${i}`}>
            {seg.to && !isLast ? (
              <Link
                to={seg.to}
                className="hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright rounded"
              >
                {seg.label}
              </Link>
            ) : (
              <span aria-current={isLast ? 'page' : undefined} className={isLast ? 'text-silver/80' : undefined}>
                {seg.label}
              </span>
            )}
            {!isLast && (
              <ChevronRight
                className="h-3 w-3 text-silver/50 shrink-0"
                aria-hidden="true"
              />
            )}
          </React.Fragment>
        );
      })}
    </nav>
  );
}
