import { BulletBar } from '@/components/executive/BulletBar';
import { Card, CardContent } from '@/components/ui/Card';
import { QueryError } from '@/components/ui/QueryError';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';
import { fmtExecExact, fmtExecMoney, STATUS_DOT, STATUS_TEXT } from '@/lib/executiveFormat';
import { useExecTargets } from '@/lib/executiveApi';
import { useI18n } from '@/lib/i18n';
import '@/lib/i18n/en/execPortal';
import { levelVsPlan, parseQuarter, planPace, type PlanPace } from './planPace';

/**
 * Plan pace: at the pace so far, where does the quarter land against the
 * plan? Revenue and gross margin to date, divided by the share of the
 * quarter gone by, on a bullet against the quarter's plan — with the gap
 * in money and a verdict in a word. With no plan set it still says where
 * the quarter is heading.
 *
 * A company that bills no one has no revenue to pace: it reads its people
 * working and its fill rate against the plan instead, as they stand now.
 */
type Unit = 'money' | 'count' | 'pct';
const fmtUnit = (v: number | null, unit: Unit) =>
  v === null ? '—' : unit === 'money' ? fmtExecMoney(v) : unit === 'pct' ? `${v.toFixed(1)}%` : Math.round(v).toLocaleString('en-US');

function PaceRow({ label, sub, valueSub, pace, unit, testId, showNoPlan }: { label: string; sub: string | null; valueSub: string; pace: PlanPace; unit: Unit; testId: string; showNoPlan: boolean }) {
  const { t } = useI18n();
  const value = fmtUnit(pace.projected, unit);
  const plan = fmtUnit(pace.target, unit);
  const gapAbs = pace.gap === null ? null : unit === 'pct' ? `${Math.abs(pace.gap).toFixed(1)} pts` : fmtUnit(Math.abs(pace.gap), unit);
  return (
    <div className="space-y-2" data-testid={testId}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="text-sm font-medium text-ink">{label}</span>
        {sub && <span className="text-xs2 tabular-nums text-ink-muted">{sub}</span>}
      </div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="font-display text-[1.75rem] leading-none tabular-nums text-ink" title={pace.projected === null || unit !== 'money' ? undefined : fmtExecExact(pace.projected, 'money')}>
            {value}
          </div>
          <div className="mt-1 text-xs2 text-ink-muted">{valueSub}</div>
        </div>
        <span className={cn('inline-flex items-center gap-1.5 text-xs2 font-medium', STATUS_TEXT[pace.status])}>
          <span className={cn('h-2 w-2 rounded-full', STATUS_DOT[pace.status])} aria-hidden="true" />
          {t(`execPortal.scen.paceStatus.${pace.status}`)}
        </span>
      </div>
      {pace.target !== null && pace.projected !== null && (
        <BulletBar value={pace.projected} target={pace.target} status={pace.status} label={t('execPortal.scen.paceBulletAria', { projected: value, plan })} />
      )}
      {pace.target !== null && pace.ratio !== null && pace.gap !== null && gapAbs !== null ? (
        <p className="text-xs2 text-ink-muted">
          {pace.gap >= 0
            ? t('execPortal.scen.paceAhead', { plan, pct: (pace.ratio * 100).toFixed(1), gap: gapAbs })
            : t('execPortal.scen.paceShort', { plan, pct: (pace.ratio * 100).toFixed(1), gap: gapAbs })}
        </p>
      ) : (
        showNoPlan && <p className="text-xs2 text-ink-muted">{t('execPortal.scen.paceNoPlan')}</p>
      )}
    </div>
  );
}

export function PlanPaceCard({ billing = true }: { billing?: boolean }) {
  const { t } = useI18n();
  const q = useExecTargets();
  const d = q.data ?? null;
  const qk = d ? parseQuarter(d.quarter) : null;
  const quarter = qk ? t('execPortal.scen.quarter', { q: qk.q, year: qk.year }) : (d?.quarter ?? '');
  const hasPlan = Boolean(d?.targets);
  return (
    <Card data-testid="exec-plan-pace">
      <CardContent className="space-y-5 p-4 md:p-5">
        <SectionTitle
          title={t(billing ? 'execPortal.scen.paceTitle' : 'execPortal.scen.standTitle')}
          description={d ? t(billing ? 'execPortal.scen.paceDesc' : 'execPortal.scen.standDesc', { quarter, pct: Math.round(d.elapsedPct) }) : t('execPortal.scen.paceDescLoading')}
        />
        {q.isError && !d ? (
          <QueryError what={t('execPortal.scen.paceWhat')} query={q} />
        ) : !d ? (
          <Skeleton className="h-32" />
        ) : billing && d.elapsedPct <= 0 ? (
          <p className="text-sm text-ink-muted">{t('execPortal.scen.paceTooEarly', { quarter })}</p>
        ) : (
          <>
            <div className="grid gap-6 md:grid-cols-2">
              {billing ? (
                <>
                  <PaceRow label={t('execPortal.scen.paceRevenue')} sub={t('execPortal.scen.paceSoFar', { value: fmtExecMoney(d.actuals.revenueQtd) })} valueSub={t('execPortal.scen.paceLands')} unit="money" pace={planPace(d.actuals.revenueQtd, d.elapsedPct, d.targets?.revenueTarget)} testId="exec-pace-revenue" showNoPlan={hasPlan} />
                  <PaceRow label={t('execPortal.scen.paceMargin')} sub={t('execPortal.scen.paceSoFar', { value: fmtExecMoney(d.actuals.marginQtd) })} valueSub={t('execPortal.scen.paceLands')} unit="money" pace={planPace(d.actuals.marginQtd, d.elapsedPct, d.targets?.marginTarget)} testId="exec-pace-margin" showNoPlan={hasPlan} />
                </>
              ) : (
                <>
                  <PaceRow label={t('execPortal.scen.standWorking')} sub={null} valueSub={t('execPortal.scen.standNow')} unit="count" pace={levelVsPlan(d.actuals.headcount, d.targets?.headcountTarget)} testId="exec-pace-headcount" showNoPlan={hasPlan} />
                  <PaceRow label={t('execPortal.scen.standFill')} sub={null} valueSub={t('execPortal.scen.standNow')} unit="pct" pace={levelVsPlan(d.actuals.fillRatePct, d.targets?.fillRatePctTarget)} testId="exec-pace-fill" showNoPlan={hasPlan} />
                </>
              )}
            </div>
            <p className="text-xs2 text-ink-muted">
              {!hasPlan ? t(billing ? 'execPortal.scen.paceFootNoPlan' : 'execPortal.scen.standFootNoPlan', { quarter }) : t(billing ? 'execPortal.scen.paceFoot' : 'execPortal.scen.standFoot')}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
