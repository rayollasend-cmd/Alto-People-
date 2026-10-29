import type * as React from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from '@/components/ui/icons';
import { Card } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { ExecSection } from '@/components/executive/ExecPage';
import { cn } from '@/lib/cn';

/**
 * The pieces every section preview on the chairman's home is made of
 * (2026-10-27): a titled band whose one line answers the section's
 * question, an "Open …" link into the drill-down (the frame kept), and
 * small figures — a label, a rounded value, one line under it.
 */

export function OpenLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link
      to={to}
      className="inline-flex items-center gap-1 whitespace-nowrap rounded text-sm font-medium text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent coarse:min-h-11"
    >
      {children}
      <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
    </Link>
  );
}

export function Preview({
  id,
  title,
  answer,
  open,
  children,
  testId,
}: {
  id: string;
  title: string;
  /** The one-line answer; undefined while it loads. */
  answer?: string;
  open: { to: string; label: string };
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col" data-testid={testId}>
      <ExecSection id={id} title={title} description={answer ?? ' '} action={<OpenLink to={open.to}>{open.label}</OpenLink>}>
        {children}
      </ExecSection>
    </div>
  );
}

/** A preview whose data has not been asked for yet (it is below the fold) or is on its way. */
export function PreviewBody({ height }: { height: number }) {
  return <Skeleton className="rounded-lg" style={{ height }} />;
}

/** A row of small figures in one card, divided. */
export function Figures({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <Card animate={false} className={cn('min-w-0', className)}>
      <dl className="grid auto-cols-fr grid-flow-col divide-x divide-line-subtle">{children}</dl>
    </Card>
  );
}

export function Figure({ label, value, sub, title, subClassName, testId }: { label: string; value: string; sub?: React.ReactNode; title?: string; subClassName?: string; testId?: string }) {
  return (
    <div className="min-w-0 px-3 py-3 sm:px-4" data-testid={testId}>
      <dt className="text-2xs font-semibold uppercase leading-snug tracking-[0.14em] text-ink-muted">{label}</dt>
      <dd className="mt-1 font-display text-2xl leading-none tabular-nums text-ink" title={title}>
        {value}
      </dd>
      {sub && <dd className={cn('mt-1 text-xs2 text-ink-muted', subClassName)}>{sub}</dd>}
    </div>
  );
}
