import type * as React from 'react';
import type { ExecComparison, ExecPeriod } from '@alto-people/shared';
import { PageHeader } from '@/components/ui/PageHeader';
import type { ExecFrame } from '@/lib/executiveApi';
import { PeriodBar } from './PeriodBar';

/**
 * The shell of an executive drill-down (Financials, Clients, People…): the
 * title in the nav trail's terms, the period bar, then the page's sections
 * on one rhythm. A page without a period (Risk, Board packs) leaves `frame` out.
 */
export interface ExecPageProps {
  title: string;
  subtitle: string;
  frame?: ExecFrame;
  period?: ExecPeriod | null;
  comparison?: ExecComparison | null;
  actions?: React.ReactNode;
  children: React.ReactNode;
  testId?: string;
}

export function ExecPage({ title, subtitle, frame, period, comparison, actions, children, testId }: ExecPageProps) {
  return (
    <div className="space-y-6" data-template="list" data-testid={testId}>
      <PageHeader title={title} subtitle={subtitle} secondaryActions={!frame ? actions : undefined} />
      {frame && <PeriodBar frame={frame} period={period} comparison={comparison} actions={actions} />}
      {children}
    </div>
  );
}

/** A titled band of the page: a heading, one line of what it answers, and its figures. */
export function ExecSection({ id, title, description, action, children }: { id: string; title: string; description?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 id={id} className="text-base font-medium text-ink">
            {title}
          </h2>
          {description && <p className="mt-0.5 text-sm text-ink-muted">{description}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children}
    </section>
  );
}
