import type * as React from 'react';
import { cn } from '@/lib/cn';

/**
 * One headline figure inside a section card: a micro label, the rounded
 * value (exact in its title), and a line under it. The executive pages'
 * quiet stat — the KPI cards above carry the comparisons and plans.
 */
export function FinFigure({ label, value, exact, sub, subClassName, className, testId }: { label: string; value: string; exact?: string; sub?: React.ReactNode; subClassName?: string; className?: string; testId?: string }) {
  return (
    <div className={cn('min-w-0', className)} data-testid={testId}>
      <div className="text-2xs uppercase tracking-[0.18em] text-ink-muted">{label}</div>
      <div className="mt-1 text-2xl font-medium tabular-nums leading-tight text-ink" title={exact}>
        {value}
      </div>
      {sub && <div className={cn('mt-0.5 text-xs2 text-ink-muted', subClassName)}>{sub}</div>}
    </div>
  );
}
