import { ExecPage, ExecSection } from '@/components/executive/ExecPage';
import { useTenant } from '@/lib/auth';
import { fmtTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import '@/lib/i18n/en/execPortal';
import { AttendanceCard } from './ops/AttendanceCard';
import { BatonsCard } from './ops/BatonsCard';
import { useLegacyBriefing, useLegacySummary } from './ops/execLegacyApi';
import { LiveFloorCard } from './ops/LiveFloorCard';
import { PlacementsCard } from './ops/PlacementsCard';
import { PortalEngagementCard } from './ops/PortalEngagementCard';
import { StoreOpsCard } from './ops/StoreOpsCard';
import { TodayCard } from './ops/TodayCard';

/**
 * The chairman's Operations pulse (2026-10-27): the business right now,
 * not over a period — what used to crowd the home, each in its own card.
 * Today's coverage and the six days ahead, the live floor, work waiting
 * between teams, store standards, the last thirty days' attendance, where
 * people are placed and whether the clients use their portal. Each card
 * loads on its own and opens the desk that works it. A company with no
 * clients (a hotel employing its own team) sees none of the client cards
 * and none of their words.
 */
export function ExecOperationsPage() {
  const { t } = useI18n();
  const { moduleOn } = useTenant();
  const billRates = moduleOn('billRates');
  const clientPortal = moduleOn('clientPortal');
  const briefing = useLegacyBriefing();
  const summary = useLegacySummary();
  const asOf = briefing.data?.generatedAt ?? null;
  return (
    <ExecPage title={t('execPortal.ops.title')} subtitle={t(clientPortal ? 'execPortal.ops.subtitle' : 'execPortal.ops.subtitleNoClients')} testId="exec-operations">
      <p className="-mt-3 text-xs2 text-ink-muted" aria-live="polite">
        {asOf ? t('execPortal.ops.rightNow', { time: fmtTime(asOf) }) : t('execPortal.ops.rightNowLoading')}
      </p>
      <ExecSection id="exec-ops-now" title={t('execPortal.ops.nowTitle')} description={t('execPortal.ops.nowDesc')}>
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <TodayCard billRates={billRates} />
          <LiveFloorCard showClient={clientPortal} />
        </div>
      </ExecSection>
      <ExecSection id="exec-ops-flow" title={t('execPortal.ops.flowTitle')} description={t('execPortal.ops.flowDesc')}>
        <BatonsCard clients={clientPortal} />
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <StoreOpsCard />
          <AttendanceCard summary={summary} />
        </div>
      </ExecSection>
      {clientPortal && (
        <ExecSection id="exec-ops-clients" title={t('execPortal.ops.clientsTitle')} description={t('execPortal.ops.clientsDesc')}>
          <div className="grid items-start gap-4 lg:grid-cols-2">
            <PlacementsCard summary={summary} />
            <PortalEngagementCard />
          </div>
        </ExecSection>
      )}
    </ExecPage>
  );
}
