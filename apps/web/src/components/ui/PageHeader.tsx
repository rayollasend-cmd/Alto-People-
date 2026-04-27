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
  // Publish the title to the topbar context so chrome can show it after scroll.
  // Only string titles can roundtrip; anything richer just falls back.
  usePublishPageTitle(typeof title === 'string' ? title : null);

  return (
    <header className={cn('mb-6', className)}>
      {breadcrumbs && breadcrumbs.length > 0 && (
        <Breadcrumb segments={breadcrumbs} />
      )}
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-3xl md:text-4xl text-white leading-tight">
            {title}
          </h1>
          {subtitle && (
            <p className="text-silver mt-1 text-sm md:text-base">{subtitle}</p>
          )}
        </div>
        {(primaryAction || secondaryActions) && (
          <div className="flex flex-wrap gap-2 items-center shrink-0">
            {secondaryActions}
            {primaryAction}
          </div>
        )}
      </div>
      {children && <div className="mt-4">{children}</div>}
    </header>
  );
}
