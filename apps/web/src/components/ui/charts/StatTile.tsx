import type { ReactNode } from 'react';
import { MetricCard } from '../MetricCard';

/**
 * A compact stat with an optional same-hue meter — the portal's tile.
 *
 * It is the app's one KPI tile now (MetricCard) under the portal's older
 * prop names, so a store manager's tiles read like every other desk's:
 * same label spec, value size, hint and link affordance. Kept so the
 * portal, region, supervisor and scheduling callers don't change.
 */
export function StatTile({
  label,
  value,
  unit,
  delta,
  deltaTone = 'neutral',
  sub,
  meter,
  className,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  delta?: string | null;
  deltaTone?: 'good' | 'bad' | 'neutral';
  sub?: ReactNode;
  /** 0–100 fill for a same-hue meter under the value. */
  meter?: { percent: number; tone?: 'primary' | 'good' | 'warn' | 'bad' } | null;
  className?: string;
}) {
  return (
    <MetricCard
      label={label}
      value={value}
      unit={unit}
      deltaText={delta ? { text: delta, tone: deltaTone } : null}
      meter={meter}
      hint={sub}
      className={className}
    />
  );
}
