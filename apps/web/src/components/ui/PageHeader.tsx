import * as React from 'react';
import { cn } from '@/lib/cn';
import { usePublishPageTitle } from '@/lib/pageTitle';
import { Breadcrumb, type BreadcrumbSegment } from './Breadcrumb';

/**
 * The F500 / Rippling page header pattern: optional breadcrumb on top,
 * then a stripe with title + subtitle on the left and primary/secondary
 * actions stacked on the right. Every page in the app uses this so the
 * "shape" is consistent.
 *
 * Usage:
 *   <PageHeader
 *     title="Recruiting"
 *     subtitle="Manage candidates from application through hire."
 *     breadcrumbs={[{ label: 'Home', to: '/' }, { label: 'Recruiting' }]}
 *     primaryAction={<Button>+ New candidate</Button>}
 *     secondaryActions={<Button variant="outline">Import</Button>}
 *   />
 */

interface PageHeaderProps {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  breadcrumbs?: BreadcrumbSegment[];
  /** Primary CTA — typically a single Button. Right-aligned, gold by default. */
  primaryAction?: React.ReactNode;
  /** Secondary actions — outlined / ghost buttons rendered to the left of the primary. */
  secondaryActions?: React.ReactNode;
  /** Optional content rendered below the stripe (e.g., a tab bar). */
  children?: React.ReactNode;
  className?: string;
}

export function PageHeader({
  title,
  subtitle,
  breadcrumbs,
  primaryAction,
  secondaryActions,
  children,
  className,
}: PageHeaderProps) {
  // Publish the title + breadcrumbs to the topbar context so chrome can
  // show "you are here" wayfinding after the user scrolls past this header.
  // Only string titles can roundtrip; richer ReactNodes just fall back.
  usePublishPageTitle(typeof title === 'string' ? title : null, breadcrumbs ?? null);

  return (
    <header className={cn('mb-7', className)}>
      {breadcrumbs && breadcrumbs.length > 0 && (
        <Breadcrumb segments={breadcrumbs} />
      )}
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          {/* Editorial serif at hero scale. text-4xl on desktop (was 3xl)
              + the relaxed leading lets Cormorant Garamond's descenders
              breathe; tracking-tight + the brand serif together carry
              the F500 "this is a real product" cue better than the
              previous compressed type. mt-2 (was mt-1) on the subtitle
              opens the title block so it doesn't read as a one-liner.
              max-w on subtitle keeps line length scannable on wide
              monitors. */}
          <h1 className="font-display text-[2rem] md:text-[2.5rem] leading-[1.1] tracking-tight text-white">
            {title}
          </h1>
          {subtitle && (
            <p className="text-silver mt-2 text-sm md:text-base max-w-3xl leading-relaxed">
              {subtitle}
            </p>
          )}
        </div>
        {(primaryAction || secondaryActions) && (
          <div className="flex flex-wrap gap-2 items-center shrink-0">
            {secondaryActions}
            {primaryAction}
          </div>
        )}
      </div>
      {children && <div className="mt-5">{children}</div>}
    </header>
  );
}
