import * as React from 'react';
import { cn } from '@/lib/cn';
import { PageHeader } from '@/components/ui/PageHeader';
import type { BreadcrumbSegment } from '@/components/ui/Breadcrumb';

/**
 * List — a list of records (design system §4.2): header, one filter row,
 * the grid, and the drawer the row opens. The grid is a <DataGrid> ("the
 * one way a list of records is shown"); the filter row is a <FilterBar>;
 * the record opens in a <Drawer> so the list never leaves the screen.
 *
 *   <ListTemplate title="People" subtitle="…" primaryAction={<Button>Add</Button>}
 *     filters={<FilterBar>…</FilterBar>} summary={<KpiStrip />}
 *     drawer={selected && <PersonDrawer … />}>
 *     <DataGrid … />
 *   </ListTemplate>
 */
export interface ListTemplateProps {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  topbarTitle?: string;
  breadcrumbs?: BreadcrumbSegment[];
  primaryAction?: React.ReactNode;
  secondaryActions?: React.ReactNode;
  /** The one filter row. */
  filters?: React.ReactNode;
  /** Optional numbers above the grid (a KPI strip, counts by status). */
  summary?: React.ReactNode;
  /** The grid. */
  children: React.ReactNode;
  /** The open record, if any. */
  drawer?: React.ReactNode;
  className?: string;
  /** For the header alone (a page with its own print-only header passes `no-print`). */
  headerClassName?: string;
}

export function ListTemplate({ title, subtitle, topbarTitle, breadcrumbs, primaryAction, secondaryActions, filters, summary, children, drawer, className, headerClassName }: ListTemplateProps) {
  return (
    <div className={cn('space-y-[var(--d-stack)]', className)} data-template="list">
      <PageHeader className={headerClassName} title={title} subtitle={subtitle} topbarTitle={topbarTitle} breadcrumbs={breadcrumbs} primaryAction={primaryAction} secondaryActions={secondaryActions} />
      {summary}
      {filters}
      {children}
      {drawer}
    </div>
  );
}
