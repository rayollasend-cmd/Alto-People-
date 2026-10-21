import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { PALETTE } from './palette';

const SERIES = { primary: PALETTE.primary } as const;
const STATUS = { good: PALETTE.good, warn: PALETTE.warn, bad: PALETTE.bad } as const;

/** A compact stat with an optional same-hue meter — the portal's tile. */

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
  const meterColor =
    meter?.tone === 'good'
      ? STATUS.good
      : meter?.tone === 'warn'
        ? STATUS.warn
        : meter?.tone === 'bad'
          ? STATUS.bad
          : SERIES.primary;
  return (
    <div
      className={cn(
        'rounded-lg border border-navy-secondary bg-navy-secondary/20 p-[var(--d-tile)] elev-1',
        className,
      )}
    >
      <div className="text-2xs font-medium uppercase tracking-wider text-silver/60">{label}</div>
      <div className="mt-1.5 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
        <span className="text-2xl font-bold tracking-tight text-white sm:text-[length:var(--d-value)]">{value}</span>
        {unit && <span className="text-sm text-silver">{unit}</span>}
        {delta && (
          <span
            className={cn(
              'basis-full text-2xs font-medium tabular-nums sm:ml-auto sm:basis-auto sm:text-xs',
              deltaTone === 'good' ? 'text-success' : deltaTone === 'bad' ? 'text-alert' : 'text-silver/70',
            )}
          >
            {delta}
          </span>
        )}
      </div>
      {meter && (
        <div
          className="mt-2 h-1.5 w-full overflow-hidden rounded-full"
          style={{ background: `color-mix(in srgb, ${meterColor} 18%, transparent)` }}
          aria-hidden="true"
        >
          <div
            className="h-full rounded-full transition-[width] duration-500 ease-out"
            style={{ width: `${Math.max(0, Math.min(100, meter.percent))}%`, background: meterColor }}
          />
        </div>
      )}
      {sub && <div className="mt-1.5 text-xs text-silver/70 tabular-nums">{sub}</div>}
    </div>
  );
}
