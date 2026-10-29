import type * as React from 'react';
import type { ExecComparison, ExecCompareKey, ExecPeriod, ExecPeriodKey } from '@alto-people/shared';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
import { fmtDateOnlyRange } from '@/lib/format';
import { fmtExecAsOf } from '@/lib/executiveFormat';
import { useI18n } from '@/lib/i18n';
import '@/lib/i18n/en/execPortal';
import type { ExecFrame } from '@/lib/executiveApi';

/**
 * The frame every executive page is read in (2026-10-27): the period
 * (week · month · quarter · year), what it is compared with (plan · prior ·
 * last year), and what the numbers are as of — one row under the title, so
 * the scorecard and every drill-down say the same thing about time.
 */
export interface PeriodBarProps {
  frame: ExecFrame;
  /** The resolved period and comparison from the page's own response, once it has loaded. */
  period?: ExecPeriod | null;
  comparison?: ExecComparison | null;
  /** Right-hand actions: the board pack, "Set the plan". */
  actions?: React.ReactNode;
}

export function PeriodBar({ frame, period, comparison, actions }: PeriodBarProps) {
  const { t } = useI18n();
  const periodOptions = (['week', 'month', 'quarter', 'year'] as const).map((value) => ({ value, label: t(`execPortal.period.${value}`) }));
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between" data-testid="exec-period-bar">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <SegmentedControl<ExecPeriodKey> ariaLabel={t('execPortal.periodAria')} options={periodOptions} value={frame.period} onChange={frame.setPeriod} />
        <Select
          aria-label={t('execPortal.compareAria')}
          value={frame.compare}
          onChange={(e) => frame.setCompare(e.target.value as ExecCompareKey)}
          className="h-9 w-auto min-w-[10rem] text-sm"
        >
          <option value="prior">{t('execPortal.compare.prior')}</option>
          <option value="plan">{t('execPortal.compare.plan')}</option>
          <option value="year">{t('execPortal.compare.year')}</option>
        </Select>
        {period && (
          <span className="text-xs2 text-ink-muted">
            <span className="font-medium text-ink">{period.label}</span>
            {' · '}
            {fmtDateOnlyRange(period.start, period.end)}
            {comparison && (comparison.available ? ` · ${comparison.label}` : comparison.reason ? ` · ${comparison.reason}` : '')}
            {' · '}
            {t('execPortal.asOf', { time: fmtExecAsOf(period.asOf, period.timezone) })}
          </span>
        )}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
