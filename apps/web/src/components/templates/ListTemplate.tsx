import * as React from 'react';
import { cn } from '@/lib/cn';
import { PageHeader, type PageAction, type PageFact, type RelatedLink } from '@/components/ui/PageHeader';
import type { BreadcrumbSegment } from '@/components/ui/Breadcrumb';

/**
 * List — a list of records (design system §4.2): header, one filter row,
 * the grid, and the drawer the row opens. The grid is a <DataGrid> ("the
 * one way a list of records is shown"); the filter row is a <FilterBar>;
 * the record opens in a <Drawer> so the list never leaves the screen.
 *
 *   <ListTemplate title="People" subtitle="…"
 *     actions={[{ label: 'Invite', primary: true, onSelect: invite }, { label: 'Export CSV', icon: Download, onSelect: exportCsv }]}
 *     related={[{ label: 'Workforce roster', to: '/workers' }]}
 *     filters={<FilterBar>…</FilterBar>} summary={<MetricStrip … />}
 *     drawer={selected && <PersonDrawer … />}>
 *     <DataGrid … />
 *   </ListTemplate>
 *
 * The header props are PageHeader's: `actions` (one primary, two beside it,
 * the rest in "More"), `facts`, `related`, `status`. `primaryAction` /
 * `secondaryActions` nodes still work for pages not yet moved over.
 */
export interface ListTemplateProps {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  topbarTitle?: string;
  /** Leave out for the nav's trail; `[]` for none. */
  breadcrumbs?: BreadcrumbSegment[];
  /** The header's actions, as data (see PageHeader). */
  actions?: PageAction[];
  /** Legacy: the primary CTA as a node. */
  primaryAction?: React.ReactNode;
  /** Legacy: secondary actions as nodes. */
  secondaryActions?: React.ReactNode;
  /** Key facts under the title. */
  facts?: PageFact[];
  /** Sibling pages, as links. */
  related?: RelatedLink[];
  /** Status badges beside the title. */
  status?: React.ReactNode;
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

export function ListTemplate({ title, subtitle, topbarTitle, breadcrumbs, actions, primaryAction, secondaryActions, facts, related, status, filters, summary, children, drawer, className, headerClassName }: ListTemplateProps) {
  return (
    <div className={cn('space-y-[var(--d-stack)]', className)} data-template="list">
      <PageHeader
        className={headerClassName}
        title={title}
        subtitle={subtitle}
        topbarTitle={topbarTitle}
        breadcrumbs={breadcrumbs}
        actions={actions}
        primaryAction={primaryAction}
        secondaryActions={secondaryActions}
        facts={facts}
        related={related}
        status={status}
      />
      {summary}
      {filters}
      {children}
      {drawer}
    </div>
  );
}
