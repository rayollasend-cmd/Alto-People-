import { Link } from 'react-router-dom';
import type { ExecKpi } from '@alto-people/shared';
import { ArrowDownRight, ArrowUpRight, Minus } from '@/components/ui/icons';
import { Sparkline, TREND_MIN_POINTS } from '@/components/ui/charts';
import { cn } from '@/lib/cn';
import { useI18n } from '@/lib/i18n';
import '@/lib/i18n/en/execPortal';
import { deltaTone, fmtExecDelta, fmtExecExact, fmtExecValue, STATUS_DOT, STATUS_TEXT } from '@/lib/executiveFormat';
import { BulletBar } from './BulletBar';

/**
 * One scorecard measure, the way a board reads it (2026-10-27): what it is
 * and where it comes from, the value rounded, the change against the chosen
 * comparison (green or red by which way is better), the bullet against the
 * plan, the status in a word, the thirteen-week line — and the whole card
 * opens the drill-down. The exact figure and the definition ride in the
 * title, so nothing is lost by rounding.
 */
export interface KpiCardProps {
  kpi: ExecKpi;
  /** "vs prior period" — what the delta is against. */
  comparisonLabel: string;
  /** The drill-down with the frame kept (execHref); defaults to kpi.href. */
  href?: string;
  /** A tighter card for previews and the phone carousel. */
  compact?: boolean;
  className?: string;
}

const TONE_TEXT = { good: 'text-positive-800', bad: 'text-negative-800', neutral: 'text-ink-muted' } as const;

export function KpiCard({ kpi, comparisonLabel, href, compact, className }: KpiCardProps) {
  const { t } = useI18n();
  const delta = fmtExecDelta(kpi);
  const tone = deltaTone(kpi);
  const Arrow = kpi.delta === null || kpi.delta === 0 ? Minus : kpi.delta > 0 ? ArrowUpRight : ArrowDownRight;
  const series = kpi.trend.map((p) => p.value);
  // The chart kit's sparse rule: under four readings a line is a hook, not a trend.
  const hasTrend = series.filter((v) => v !== null).length >= TREND_MIN_POINTS;
  const value = fmtExecValue(kpi.value, kpi.unit);
  const title = `${kpi.label}: ${fmtExecExact(kpi.value, kpi.unit)}. ${kpi.definition}`;
  return (
    <Link
      to={href ?? kpi.href}
      title={title}
      aria-label={`${kpi.label} ${value}${delta ? `, ${delta} ${comparisonLabel}` : ''}, ${kpi.statusLabel}`}
      className={cn(
        'group flex min-w-0 flex-col rounded-lg border border-line bg-surface elev-1 transition-colors hover:border-line-strong hover:bg-surface-raised/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        compact ? 'gap-1.5 p-3' : 'gap-2 p-4',
        className,
      )}
      data-testid={`exec-kpi-${kpi.id}`}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-2xs font-semibold uppercase tracking-[0.14em] text-ink-muted">{kpi.label}</span>
        <span className="shrink-0 rounded border border-line-subtle px-1 text-3xs text-ink-muted" title={t(`execPortal.basisTitle.${kpi.basis}`)}>
          {t(`execPortal.basis.${kpi.basis}`)}
        </span>
      </div>
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <div className={cn('font-display tabular-nums leading-none text-ink', compact ? 'text-2xl' : 'text-[1.75rem]')}>{value}</div>
          {kpi.sub && <div className="mt-1 line-clamp-2 text-xs2 text-ink-muted">{kpi.sub}</div>}
        </div>
        {hasTrend && (
          <Sparkline
            series={series}
            tone={tone === 'good' ? 'good' : tone === 'bad' ? 'bad' : 'neutral'}
            width={compact ? 64 : 84}
            height={compact ? 22 : 28}
            area
            showLast
            label={`${kpi.label}, last ${series.length} weeks`}
            className="shrink-0"
          />
        )}
      </div>
      <div className={cn('flex items-center gap-1 text-xs2 tabular-nums', TONE_TEXT[tone])}>
        {delta ? (
          <>
            <Arrow className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="font-medium">{delta}</span>
            <span className="truncate text-ink-muted">{comparisonLabel}</span>
          </>
        ) : (
          <span className="text-ink-muted">{t('execPortal.noComparison')}</span>
        )}
      </div>
      <div className="mt-auto space-y-1.5 pt-1">
        {kpi.target !== null && <BulletBar value={kpi.value} target={kpi.target} status={kpi.status} label={`${value} against a plan of ${fmtExecValue(kpi.target, kpi.unit)}`} />}
        <div className="flex items-center justify-between gap-2 text-xs2">
          <span className={cn('inline-flex items-center gap-1.5 font-medium', STATUS_TEXT[kpi.status])}>
            <span className={cn('h-2 w-2 rounded-full', STATUS_DOT[kpi.status])} aria-hidden="true" />
            {kpi.statusLabel}
          </span>
          {kpi.target !== null && (
            <span className="truncate tabular-nums text-ink-muted" title={kpi.targetLabel ?? undefined}>
              {t('execPortal.plan', { value: fmtExecValue(kpi.target, kpi.unit) })}
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}
