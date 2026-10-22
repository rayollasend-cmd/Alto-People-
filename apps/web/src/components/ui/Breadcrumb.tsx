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
  /**
   * False when the segments are only the page's ANCESTORS — the page's own
   * name is the heading right under them (PageHeader), so the trail ends
   * at the parent and every segment is a way up.
   */
  current?: boolean;
  className?: string;
}

/**
 * The trail a page header draws: its ancestors, plus its own name only when
 * that name isn't the heading below (a record's drill-down crumb). Shared
 * by PageHeader and RecordTemplate.
 */
export function headerCrumbs(crumbs: BreadcrumbSegment[] | null, heading: string | null): { segments: BreadcrumbSegment[]; current: boolean } | null {
  if (!crumbs || crumbs.length === 0) return null;
  const last = crumbs[crumbs.length - 1]!;
  if (heading && last.label.trim().toLowerCase() === heading.trim().toLowerCase()) {
    const up = crumbs.slice(0, -1);
    return up.length > 0 ? { segments: up, current: false } : null;
  }
  return { segments: crumbs, current: true };
}

export function Breadcrumb({ segments, current = true, className }: BreadcrumbProps) {
  if (segments.length === 0) return null;
  return (
    <nav
      aria-label="Breadcrumb"
      className={cn('flex items-center gap-1 text-xs text-silver mb-2', className)}
    >
      {segments.map((seg, i) => {
        const isLast = current && i === segments.length - 1;
        const hasNext = i < segments.length - 1;
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
            {hasNext && (
              <ChevronRight
                className="h-3 w-3 text-silver/70 shrink-0"
                aria-hidden="true"
              />
            )}
          </React.Fragment>
        );
      })}
    </nav>
  );
}
