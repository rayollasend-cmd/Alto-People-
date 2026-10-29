import { ExecPage, ExecSection } from '@/components/executive/ExecPage';
import { QueryError } from '@/components/ui/QueryError';
import { Skeleton, SkeletonRows } from '@/components/ui/Skeleton';
import { ShieldCheck } from '@/components/ui/icons';
import { Card, CardContent } from '@/components/ui/Card';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { fmtExecAsOf } from '@/lib/executiveFormat';
import { useTenant } from '@/lib/auth';
import { useExecRisks } from '@/lib/executiveApi';
import { useI18n } from '@/lib/i18n';
import '@/lib/i18n/en/execPortal';
import { categoriesFor } from './risk/riskMeta';
import { RiskRegister } from './risk/RiskRegister';
import { RiskSummary } from './risk/RiskSummary';
import { SeasonalCapacityCard } from './risk/SeasonalCapacityCard';

/**
 * The chairman's Risk page (2026-10-27): what could hurt the business,
 * who owns it, and which way it is moving. The register as it stands
 * right now — no period to choose — counted by severity and area, then
 * the register itself, then seasonal capacity (the J-1 cliff). A clean
 * register says so in green only when the register loaded and is empty.
 */
export function ExecRiskPage() {
  const { t } = useI18n();
  const q = useExecRisks();
  const data = q.data ?? null;
  const categories = categoriesFor(useTenant().moduleOn('clientPortal'), data?.risks ?? []);
  return (
    <ExecPage title={t('execPortal.risk.title')} subtitle={t('execPortal.risk.subtitle')} testId="exec-risk">
      {q.isError && !data ? (
        <QueryError what={t('execPortal.risk.what')} query={q} />
      ) : !data ? (
        <div className="space-y-4" aria-hidden="true">
          <Skeleton className="h-24" />
          <SkeletonRows count={4} />
        </div>
      ) : data.risks.length === 0 ? (
        <Card data-testid="exec-risk-clear">
          <CardContent className="flex items-start gap-3 p-4 md:p-5">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-positive-200 bg-positive-100 text-positive-800">
              <ShieldCheck className="h-5 w-5" aria-hidden="true" />
            </span>
            <SectionTitle as="h2" title={t('execPortal.risk.clearTitle')} description={`${t('execPortal.risk.clearBody')} ${t('execPortal.asOf', { time: fmtExecAsOf(data.asOf, data.timezone) })}`} />
          </CardContent>
        </Card>
      ) : (
        <>
          <RiskSummary risks={data.risks} asOf={data.asOf} timezone={data.timezone} categories={categories} />
          <ExecSection id="exec-risk-register" title={t('execPortal.risk.registerTitle')} description={t('execPortal.risk.registerDesc')}>
            <RiskRegister risks={data.risks} categories={categories} />
          </ExecSection>
        </>
      )}
      <ExecSection id="exec-risk-capacity" title={t('execPortal.risk.capSection')} description={t('execPortal.risk.capSectionDesc')}>
        <SeasonalCapacityCard />
      </ExecSection>
    </ExecPage>
  );
}
