import { ExecPage, ExecSection } from '@/components/executive/ExecPage';
import { QueryError } from '@/components/ui/QueryError';
import { Skeleton } from '@/components/ui/Skeleton';
import { useTenant } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import '@/lib/i18n/en/execPortal';
import { useLegacySummary } from './ops/execLegacyApi';
import { PlanPaceCard } from './scenarios/PlanPaceCard';
import { RateModelCard } from './scenarios/RateModelCard';
import { WhatIfClientCard } from './WhatIfClientCard';

/**
 * The chairman's Scenarios page (2026-10-27): questions asked of the real
 * numbers. Where does the quarter land at this pace? What does a rate
 * change do to a year's margin? What if we lose a client, or win one? No
 * period to choose — each model says the basis it runs on.
 *
 * A company that bills no one (a hotel employing its own team) reads its
 * people and fill rate against the plan, and what a pay change costs a
 * year; it has no clients to lose or win, so that card and every client
 * word stay out.
 */
export function ExecScenariosPage() {
  const { t } = useI18n();
  const { moduleOn } = useTenant();
  const billRates = moduleOn('billRates');
  const clients = moduleOn('clientPortal');
  const withClients = billRates && clients;
  const summary = useLegacySummary();
  const s = summary.data ?? null;
  return (
    <ExecPage title={t('execPortal.scen.title')} subtitle={t(withClients ? 'execPortal.scen.subtitle' : 'execPortal.scen.subtitleNoClients')} testId="exec-scenarios">
      <ExecSection
        id="exec-scen-pace"
        title={t(billRates ? 'execPortal.scen.paceSection' : 'execPortal.scen.standSection')}
        description={t(billRates ? 'execPortal.scen.paceSectionDesc' : 'execPortal.scen.standSectionDesc')}
      >
        <PlanPaceCard billing={billRates} />
      </ExecSection>
      <ExecSection
        id="exec-scen-models"
        title={t(withClients ? 'execPortal.scen.modelsSection' : 'execPortal.scen.modelsSectionNoClients')}
        description={t(withClients ? 'execPortal.scen.modelsSectionDesc' : billRates ? 'execPortal.scen.modelsSectionDescNoClients' : 'execPortal.scen.modelsSectionDescPay')}
      >
        {summary.isError && !s ? (
          <QueryError what={t('execPortal.scen.summaryWhat')} query={summary} />
        ) : !s ? (
          <div className="grid gap-4 xl:grid-cols-5" aria-hidden="true">
            <Skeleton className="h-72 xl:col-span-2" />
            {withClients && <Skeleton className="h-72 xl:col-span-3" />}
          </div>
        ) : (
          <div className="grid items-start gap-4 xl:grid-cols-5">
            <div className="min-w-0 xl:col-span-2">
              <RateModelCard rates={s.rates} trend={s.trend} billing={billRates} />
            </div>
            {withClients && (
              <div className="min-w-0 xl:col-span-3">
                <WhatIfClientCard league={s.league} clients={s.clients} rates={s.rates} />
              </div>
            )}
          </div>
        )}
      </ExecSection>
      <p className="text-xs text-ink-muted">{t(withClients ? 'execPortal.scen.footnote' : 'execPortal.scen.footnoteNoClients')}</p>
    </ExecPage>
  );
}
