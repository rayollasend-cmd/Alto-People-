import { useId } from 'react';
import type { TransportKpi } from '@alto-people/shared';
import { ArrowDownRight, ArrowUpRight, Minus } from '@/components/ui/icons';
import { Sparkline, TREND_MIN_POINTS } from '@/components/ui/charts';
import { cn } from '@/lib/cn';
import { fmtMoney, fmtMoneyWhole } from '@/lib/format';
import { STATUS_DOT, STATUS_TEXT } from '@/lib/executiveFormat';
import '@/lib/i18n/en/fleetOps';
import { useFleetT } from './fleetT';

/**
 * One transport measure in the executive card's visual language
 * (components/executive/KpiCard): the label, the value rounded, the
 * eight-week line, the change against the 7 days before (green or red by
 * which way is better — never on a zero), the status in a word with its
 * dot. The exact figure and the definition ride in the title and, for a
 * screen reader, in the card's description.
 */

const MINUS = '−';

/** 94% · 94.3% · $14.20 · $126 — rounded for a card. */
export function fmtKpiValue(value: number | null, unit: TransportKpi['unit']): string {
  if (value === null || !Number.isFinite(value)) return '—';
  if (unit === 'pct') return `${Number(value.toFixed(1))}%`;
  return Math.abs(value) >= 100 ? fmtMoneyWhole(value) : fmtMoney(value);
}

/** The exact figure, for the title: 94.27% · $14.2031. */
export function fmtKpiExact(value: number | null, unit: TransportKpi['unit']): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return unit === 'pct' ? `${value.toFixed(2)}%` : fmtMoney(value);
}

/** +2.1 pts · −$0.40 · null without a comparison. */
export function fmtKpiDelta(delta: number | null, unit: TransportKpi['unit']): string | null {
  if (delta === null || !Number.isFinite(delta)) return null;
  const sign = delta > 0 ? '+' : delta < 0 ? MINUS : '±';
  const abs = Math.abs(delta);
  return unit === 'pct' ? `${sign}${Number(abs.toFixed(1))} pts` : `${sign}${fmtMoney(abs)}`;
}

/** Good news, bad news, or none — a zero change is never coloured. */
export function kpiDeltaTone(kpi: Pick<TransportKpi, 'delta' | 'betterWhen' | 'unit'>): 'good' | 'bad' | 'neutral' {
  if (kpi.delta === null || !Number.isFinite(kpi.delta)) return 'neutral';
  // What rounds to zero on the card reads as no change.
  const shown = kpi.unit === 'pct' ? Number(kpi.delta.toFixed(1)) : Math.round(kpi.delta * 100) / 100;
  if (shown === 0) return 'neutral';
  return shown > 0 === (kpi.betterWhen === 'up') ? 'good' : 'bad';
}

const TONE_TEXT = { good: 'text-positive-800', bad: 'text-negative-800', neutral: 'text-ink-muted' } as const;

export function TransportKpiCard({ kpi, className }: { kpi: TransportKpi; className?: string }) {
  const t = useFleetT();
  const labelId = useId();
  const descId = useId();
  const tone = kpiDeltaTone(kpi);
  const delta = fmtKpiDelta(kpi.delta, kpi.unit);
  const Arrow = tone === 'neutral' ? Minus : (kpi.delta ?? 0) > 0 ? ArrowUpRight : ArrowDownRight;
  const series = kpi.trend;
  const hasTrend = series.filter((v) => v !== null).length >= TREND_MIN_POINTS;
  const value = fmtKpiValue(kpi.value, kpi.unit);
  return (
    <article
      aria-labelledby={labelId}
      aria-describedby={descId}
      title={`${kpi.label}: ${fmtKpiExact(kpi.value, kpi.unit)}. ${kpi.definition}`}
      className={cn('flex min-w-0 flex-col gap-2 rounded-lg border border-line bg-surface p-4 elev-1', className)}
      data-testid={`transport-kpi-${kpi.id}`}
    >
      <h3 id={labelId} className="text-2xs font-semibold uppercase tracking-[0.14em] text-ink-muted">
        {kpi.label}
      </h3>
      <p id={descId} className="sr-only">
        {kpi.definition}
      </p>
      <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 font-display text-[1.75rem] leading-none tabular-nums text-ink">{value}</div>
        {hasTrend && (
          <Sparkline
            series={series}
            tone={tone === 'good' ? 'good' : tone === 'bad' ? 'bad' : 'neutral'}
            width={84}
            height={28}
            area
            showLast
            label={t('fleetOps.kpi.trend', { label: kpi.label, n: series.length })}
            className="shrink-0"
          />
        )}
      </div>
      <div className={cn('flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 text-xs2 tabular-nums', TONE_TEXT[tone])}>
        {delta === null ? (
          <span className="text-ink-muted">{t('fleetOps.kpi.noCompare')}</span>
        ) : tone === 'neutral' ? (
          <span className="text-ink-muted">{t('fleetOps.kpi.noChange')}</span>
        ) : (
          <>
            <span className="inline-flex items-center gap-1 whitespace-nowrap font-medium">
              <Arrow className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {delta}
            </span>
            <span className="text-ink-muted">{t('fleetOps.kpi.vsBefore')}</span>
          </>
        )}
      </div>
      <div className="mt-auto pt-1 text-xs2">
        <span className={cn('inline-flex items-center gap-1.5 font-medium', STATUS_TEXT[kpi.status])}>
          <span className={cn('h-2 w-2 shrink-0 rounded-full', STATUS_DOT[kpi.status])} aria-hidden="true" />
          {kpi.statusLabel}
        </span>
      </div>
    </article>
  );
}
