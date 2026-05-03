import * as React from 'react';
import { cn } from '@/lib/cn';
import { Card, CardContent } from './Card';

export interface MetricCardProps {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  /** When true, value renders in warning instead of gold — for "needs attention" tiles. */
  accent?: boolean;
  /** Wraps the card in a link with hover affordance. Pair with React Router's Link via asChild patterns. */
  href?: string;
  /** Render-prop wrapper for non-anchor links (Router Link, button, etc.). */
  wrap?: (children: React.ReactElement) => React.ReactElement;
  className?: string;
}

/**
 * KPI tile used across dashboards. Encapsulates the
 *   uppercase label → big-number → optional hint
 * pattern so AnalyticsHome, VtoHome, and the per-module dashboards stop
 * inlining their own copies.
 */
export function MetricCard({
  label,
  value,
  hint,
  accent,
  href,
  wrap,
  className,
}: MetricCardProps) {
  const card = (
    <Card
      className={cn(
        (href || wrap) &&
          'transition hover:border-steel hover:bg-navy-secondary/30 cursor-pointer',
        className,
      )}
    >
      <CardContent className="pt-5">
        <div className="text-[10px] uppercase tracking-widest text-silver">
          {label}
        </div>
        <div
          className={cn(
            'font-display text-3xl mt-2 leading-none tabular-nums',
            accent ? 'text-warning' : 'text-gold',
          )}
        >
          {value}
        </div>
        {hint && <div className="text-xs text-silver/70 mt-2">{hint}</div>}
        {(href || wrap) && (
          <div className="text-[10px] text-silver/60 mt-3">View details →</div>
        )}
      </CardContent>
    </Card>
  );
  if (wrap) return wrap(card);
  if (href) return <a href={href}>{card}</a>;
  return card;
}
