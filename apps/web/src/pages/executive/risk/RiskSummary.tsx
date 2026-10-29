import type { ExecRisk, ExecRiskCategory } from '@alto-people/shared';
import { Card, CardContent } from '@/components/ui/Card';
import { fmtExecAsOf } from '@/lib/executiveFormat';
import { useI18n } from '@/lib/i18n';
import '@/lib/i18n/en/execPortal';
import { CATEGORIES, SEVERITIES, countBy } from './riskMeta';
import { SeverityChip } from './SeverityChip';

/**
 * The register in one line: how many risks are open, how many at each
 * severity — a severity is coloured only when something is there — and
 * how they spread across the five areas, in plain ink. As of when the
 * register was read.
 */
export function RiskSummary({ risks, asOf, timezone, categories = CATEGORIES }: { risks: ExecRisk[]; asOf: string; timezone?: string; categories?: readonly ExecRiskCategory[] }) {
  const { t } = useI18n();
  const bySeverity = countBy(risks, (r) => r.severity, SEVERITIES);
  const byCategory = countBy(risks, (r) => r.category, categories);
  return (
    <Card data-testid="exec-risk-summary">
      <CardContent className="flex flex-col gap-4 p-4 md:flex-row md:items-center md:justify-between md:p-5">
        <div>
          <div className="font-display text-[1.75rem] leading-none tabular-nums text-ink">{risks.length.toLocaleString('en-US')}</div>
          <div className="mt-1 text-xs2 text-ink-muted">
            {t('execPortal.risk.openSub', { count: risks.length })} · {t('execPortal.asOf', { time: fmtExecAsOf(asOf, timezone) })}
          </div>
        </div>
        <dl className="flex flex-wrap items-center gap-2" aria-label={t('execPortal.risk.bySeverityAria')}>
          {SEVERITIES.map((s) => {
            const n = bySeverity[s];
            return (
              <div key={s} className="flex items-center" data-testid={`exec-risk-sev-${s}`}>
                <dt className="sr-only">{t(`execPortal.risk.sev.${s}`)}</dt>
                <dd>
                  {n > 0 ? (
                    <span data-tone="status">
                      <SeverityChip severity={s}>{t(`execPortal.risk.sevCount.${s}`, { count: n })}</SeverityChip>
                    </span>
                  ) : (
                    <span className="px-1 text-xs2 text-ink-muted" data-tone="none">
                      {t(`execPortal.risk.sevCount.${s}`, { count: n })}
                    </span>
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
        <dl className="grid grid-cols-3 gap-x-4 gap-y-1 text-xs2 sm:grid-cols-5" aria-label={t('execPortal.risk.byCategoryAria')}>
          {categories.map((c) => (
            <div key={c} className="min-w-0">
              <dt className="truncate text-ink-muted">{t(`execPortal.risk.cat.${c}`)}</dt>
              <dd className="text-base font-medium tabular-nums text-ink">{byCategory[c]}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}
