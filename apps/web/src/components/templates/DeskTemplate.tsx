import * as React from 'react';
import { cn } from '@/lib/cn';
import { PageHeader } from '@/components/ui/PageHeader';
import type { BreadcrumbSegment } from '@/components/ui/Breadcrumb';

/**
 * Desk — a queue someone works (design system §4.5): approvals, the
 * compliance desk, the verifier's worklist, the platform support inbox,
 * agent proposals. The queue on the left, the open item on the right, the
 * action in the item, and closure (what happened, by whom) recorded where
 * the item was. On phones the queue is the page and the item opens over it.
 *
 *   <DeskTemplate title="Approvals" counts={<Badge>12 waiting</Badge>}
 *     filters={<SegmentedControl … />}
 *     queue={<QueueList … />}
 *     item={selected ? <ApprovalItem … /> : <EmptyState title="Pick an item" />} />
 */
export interface DeskTemplateProps {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  topbarTitle?: string;
  breadcrumbs?: BreadcrumbSegment[];
  /** How many wait, by state. */
  counts?: React.ReactNode;
  actions?: React.ReactNode;
  /** The one filter row for the queue. */
  filters?: React.ReactNode;
  /** The queue. */
  queue: React.ReactNode;
  /** The open item (or the empty prompt). */
  item: React.ReactNode;
  /** True when an item is open on a phone: the item takes the screen. */
  itemOpen?: boolean;
  className?: string;
}

export function DeskTemplate({ title, subtitle, topbarTitle, breadcrumbs, counts, actions, filters, queue, item, itemOpen, className }: DeskTemplateProps) {
  return (
    <div className={cn('space-y-[var(--d-stack)]', className)} data-template="desk">
      <PageHeader title={title} subtitle={subtitle} topbarTitle={topbarTitle} breadcrumbs={breadcrumbs} primaryAction={actions} secondaryActions={counts} />
      {filters}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <section aria-label="Queue" className={cn('min-w-0', itemOpen && 'hidden lg:block')}>
          {queue}
        </section>
        <section aria-label="Open item" className={cn('min-w-0', !itemOpen && 'hidden lg:block')}>
          {item}
        </section>
      </div>
    </div>
  );
}
