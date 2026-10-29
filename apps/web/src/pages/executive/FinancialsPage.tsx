import type { ExecFinancials, ExecKpi } from '@alto-people/shared';
import { ExecPage, ExecSection } from '@/components/executive/ExecPage';
import { KpiCard } from '@/components/executive/KpiCard';
import { QueryError } from '@/components/ui/QueryError';
import { Skeleton } from '@/components/ui/Skeleton';
import { useTenant } from '@/lib/auth';
import { execHref, useExecFinancials, useExecFrame, type ExecFrame } from '@/lib/executiveApi';
import { fmtMoney } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import '@/lib/i18n/en/execPortal';
import { useMinWidth } from '@/lib/useViewport';
import { BoardPackLink } from './financials/BoardPackLink';
import { CashSection } from './financials/CashSection';
import { MarginWaterfall } from './financials/MarginWaterfall';
import { PayrollCost, ProfitCard } from './financials/PayrollProfit';
import { Receivables } from './financials/Receivables';
import { ThirteenWeeks } from './financials/ThirteenWeeks';

/**
 * The chairman's Financials (2026-10-27): the six money measures against the
 * frame, then where the period's billing went (the margin waterfall), the
 * thirteen-week run of billed against cost, cash and its forecast low,
 * receivables by age, what payroll costs and what the books say was made —
 * every figure rounded for reading, exact behind its table, and each with
 * its source in the footnote.
 */
export function ExecFinancialsPage() {
  const { t } = useI18n();
  const frame = useExecFrame();
  const q = useExecFinancials(frame);
  const d = q.data;
  return (
    <ExecPage
      title={t('execPortal.fin.title')}
      subtitle={t('execPortal.fin.subtitle')}
      frame={frame}
      period={d?.period}
      comparison={d?.comparison}
      actions={<BoardPackLink frame={frame} />}
      testId="exec-financials"
    >
      {!d ? q.isError ? <QueryError what={t('execPortal.fin.what')} query={q} /> : <FinancialsSkeleton /> : <FinancialsBody d={d} frame={frame} />}
    </ExecPage>
  );
}

function FinancialsSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" data-testid="exec-financials-loading">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-36 rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-80 rounded-lg" />
      <Skeleton className="h-96 rounded-lg" />
    </div>
  );
}

/** A KPI's drill-down: the executive pages keep the frame; anything else opens as it is. */
const kpiHref = (k: ExecKpi, frame: ExecFrame) => (k.href.startsWith('/executive') ? execHref(k.href, frame) : k.href);

function FinancialsBody({ d, frame }: { d: ExecFinancials; frame: ExecFrame }) {
  const { t } = useI18n();
  const wide = useMinWidth(640);
  // Receivables are client statements: a direct employer (no billing, no client portal) has none to show.
  const { moduleOn } = useTenant();
  const billsClients = moduleOn('clientPortal') && moduleOn('billRates');
  const compareLabel = d.comparison.available ? d.comparison.label : t('execPortal.fin.noComparison');
  return (
    <>
      <section aria-label={t('execPortal.fin.kpisAria')} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="exec-fin-kpis">
        {d.kpis.map((k) => (
          <KpiCard key={k.id} kpi={k} comparisonLabel={compareLabel} href={kpiHref(k, frame)} compact={!wide} />
        ))}
      </section>

      <ExecSection id="exec-fin-where" title={t('execPortal.fin.sec.where')} description={t('execPortal.fin.sec.whereDesc')}>
        <div className="grid gap-4 xl:grid-cols-2">
          <MarginWaterfall d={d} />
          <ThirteenWeeks weeks={d.weeks} />
        </div>
      </ExecSection>

      <ExecSection id="exec-fin-cash" title={t('execPortal.fin.cash.title')} description={t('execPortal.fin.cash.desc')}>
        <CashSection cash={d.cash} />
      </ExecSection>

      {billsClients && (
        <ExecSection id="exec-fin-ar" title={t('execPortal.fin.ar.title')} description={t('execPortal.fin.ar.desc')}>
          <Receivables ar={d.receivables} />
        </ExecSection>
      )}

      <ExecSection id="exec-fin-costs" title={t('execPortal.fin.sec.costs')} description={t('execPortal.fin.sec.costsDesc')}>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <PayrollCost runs={d.payrollRuns} />
          <ProfitCard profit={d.profit} />
        </div>
      </ExecSection>

      <footer className="space-y-1 border-t border-line-subtle pt-4 text-xs2 text-ink-muted" data-testid="exec-fin-footnote">
        <p>
          {t(d.rates.overheadPerHour > 0 ? 'execPortal.fin.foot.rates' : 'execPortal.fin.foot.ratesNoOverhead', {
            bill: fmtMoney(d.rates.billRate),
            pay: fmtMoney(d.rates.payRate),
            burden: `${Number(d.rates.burdenPct.toFixed(2))}%`,
            overhead: fmtMoney(d.rates.overheadPerHour),
          })}
        </p>
        <p>{t(billsClients ? 'execPortal.fin.foot.basis' : 'execPortal.fin.foot.basisNoAr')}</p>
      </footer>
    </>
  );
}
