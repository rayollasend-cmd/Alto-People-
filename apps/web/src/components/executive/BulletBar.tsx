import { cn } from '@/lib/cn';
import type { ExecStatus } from '@alto-people/shared';

/**
 * A bullet graph (Stephen Few): the actual as a bar, the plan as a tick, on
 * one quiet track — "how far along against the plan" in a sliver of height,
 * the way a board scorecard shows it instead of a gauge. The bar wears the
 * status's own scale step; with no target it is the neutral ink.
 *
 * For a measure where lower is better (days to collect, labor cost %), the
 * bar still runs from zero: past the tick reads as "over plan" either way,
 * and the status colour says which way is good.
 */
export interface BulletBarProps {
  value: number | null;
  target: number | null;
  status: ExecStatus;
  /** Announced in place of the drawing. */
  label: string;
  className?: string;
}

const BAR: Record<ExecStatus, string> = {
  good: 'bg-positive-700',
  watch: 'bg-caution-700',
  bad: 'bg-negative-700',
  none: 'bg-neutral-600',
};

export function BulletBar({ value, target, status, label, className }: BulletBarProps) {
  if (value === null || !Number.isFinite(value)) return null;
  const top = Math.max(Math.abs(value), Math.abs(target ?? 0)) * 1.15 || 1;
  const pct = (n: number) => `${Math.max(0, Math.min(100, (Math.abs(n) / top) * 100))}%`;
  return (
    <div role="img" aria-label={label} className={cn('relative h-2 w-full rounded-full bg-neutral-100', className)}>
      <div className={cn('absolute inset-y-0 left-0 rounded-full', BAR[status])} style={{ width: pct(value) }} />
      {target !== null && Number.isFinite(target) && (
        <div className="absolute -inset-y-1 w-0.5 rounded-full bg-ink" style={{ left: `calc(${pct(target)} - 1px)` }} aria-hidden="true" />
      )}
    </div>
  );
}
