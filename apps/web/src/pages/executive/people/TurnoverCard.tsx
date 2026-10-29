import { Link } from 'react-router-dom';
import type { ExecPeople } from '@alto-people/shared';
import { BulletBar } from '@/components/executive/BulletBar';
import { Card, CardContent } from '@/components/ui/Card';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { cn } from '@/lib/cn';
import { fmtExecExact, fmtExecMoney, STATUS_DOT, STATUS_TEXT } from '@/lib/executiveFormat';
import { useI18n } from '@/lib/i18n';
import '@/lib/i18n/en/execPortal';
import { turnoverKpi, turnoverStatus } from './peopleMath';

/**
 * Turnover against the plan, the way a board asks it: the annualized rate,
 * the plan as a ceiling on one bullet, the verdict in a word and a
 * sentence — and what the leavers of the last ninety days cost to replace,
 * an estimate that says so.
 */
export function TurnoverCard({ data }: { data: Pick<ExecPeople, 'turnover' | 'kpis'> }) {
  const { t } = useI18n();
  const { annualizedPct, targetPct, separations90d, estCost90d } = data.turnover;
  const kpi = turnoverKpi(data);
  const status = kpi && kpi.status !== 'none' ? kpi.status : turnoverStatus(annualizedPct, targetPct);
  const value = annualizedPct === null ? null : `${annualizedPct.toFixed(1)}%`;
  const target = targetPct === null ? null : `${targetPct.toFixed(1)}%`;
  const sentence =
    annualizedPct === null
      ? t('execPortal.people.turnoverNoRate')
      : targetPct === null
        ? t('execPortal.people.turnoverNoPlan', { value: value! })
        : t(`execPortal.people.turnoverVs.${status === 'none' ? 'good' : status}`, { value: value!, target: target! });
  return (
    <Card className="min-w-0" data-testid="exec-turnover">
      <CardContent className="space-y-4 p-4 md:p-5">
        <SectionTitle title={t('execPortal.people.turnoverTitle')} description={t('execPortal.people.turnoverDesc')} />
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="font-display text-[1.75rem] leading-none tabular-nums text-ink" title={annualizedPct === null ? undefined : fmtExecExact(annualizedPct, 'pct')}>
              {value ?? '—'}
            </div>
            <div className="mt-1 text-xs2 text-ink-muted">{t('execPortal.people.turnoverUnit')}</div>
          </div>
          <span className={cn('inline-flex items-center gap-1.5 text-xs2 font-medium', STATUS_TEXT[status])}>
            <span className={cn('h-2 w-2 rounded-full', STATUS_DOT[status])} aria-hidden="true" />
            {t(`execPortal.people.turnoverStatus.${status}`)}
          </span>
        </div>
        {annualizedPct !== null && targetPct !== null && (
          <div className="space-y-1">
            <BulletBar value={annualizedPct} target={targetPct} status={status} label={t('execPortal.people.turnoverBulletAria', { value: value!, target: target! })} />
            <div className="flex justify-between text-2xs tabular-nums text-ink-muted">
              <span>0%</span>
              <span>{t('execPortal.people.turnoverPlan', { target: target! })}</span>
            </div>
          </div>
        )}
        <p className="text-sm text-ink">{sentence}</p>
        <div className="border-t border-line-subtle pt-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-sm text-ink-muted">{t('execPortal.people.turnoverCostLabel')}</span>
            <span className="text-lg font-medium tabular-nums text-ink" title={fmtExecExact(estCost90d, 'money')}>
              {fmtExecMoney(estCost90d)} <span className="rounded border border-line-subtle px-1 align-middle text-3xs font-normal text-ink-muted">{t('execPortal.basis.estimate')}</span>
            </span>
          </div>
          <p className="mt-1 text-xs2 text-ink-muted">
            {t('execPortal.people.turnoverCostSub', { count: separations90d })}{' '}
            <Link to="/reports/people" className="text-accent hover:underline">
              {t('execPortal.people.turnoverOpen')}
            </Link>
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
