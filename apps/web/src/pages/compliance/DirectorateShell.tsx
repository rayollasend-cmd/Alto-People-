import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * Shared chrome for the five compliance directorates (I-9, E-Verify,
 * Background, Drug test, J-1) — the same design language as the profile
 * document vault, so every compliance surface reads the same way:
 *
 *   <DirectorateHeader icon= title= blurb= actions=… />
 *   <KpiStrip>…<Kpi/>…</KpiStrip>
 *   <TableShell>…<Table/>…</TableShell>
 *
 * Three tabs used to hand-roll their own Kpi copies and two had no header
 * identity at all; this is the single source.
 */

export function DirectorateHeader({
  icon: Icon,
  title,
  blurb,
  actions,
}: {
  icon: LucideIcon;
  title: string;
  /** One-line purpose so the section identifies itself. */
  blurb: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-gold/10 text-gold">
          <Icon className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0">
          <h2 className="text-base font-semibold leading-tight text-white">{title}</h2>
          <p className="text-2xs text-silver/60">{blurb}</p>
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** The bordered stat band under a directorate header. */
export function KpiStrip({ children }: { children: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap gap-x-8 gap-y-3 rounded-lg border border-navy-secondary bg-navy/40 p-4">
      {children}
    </div>
  );
}

export function Kpi({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: string;
}) {
  return (
    <div>
      <div className="text-2xs uppercase tracking-wider text-silver/70">{label}</div>
      <div className={cn('font-display text-xl tabular-nums', tone ?? 'text-white')}>
        {value}
      </div>
    </div>
  );
}

/** Card shell so tables sit on a brand surface instead of floating bare. */
export function TableShell({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border border-navy-secondary bg-navy/40',
        className,
      )}
    >
      {children}
    </div>
  );
}
