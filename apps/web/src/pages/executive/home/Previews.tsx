import { useTenant } from '@/lib/auth';
import { execHref, type ExecFrame } from '@/lib/executiveApi';
import { useI18n } from '@/lib/i18n';
import '@/lib/i18n/en/execPortal';
import { ClientsPreview } from './ClientsPreview';
import { FinancialsPreview } from './FinancialsPreview';
import { Preview, PreviewBody } from './PreviewParts';
import { RiskPreview } from './RiskPreview';
import { useBelowTheFold } from './util';
import { WorkforcePreview } from './WorkforcePreview';

/**
 * The four section previews under the scorecard (2026-10-27): Financials,
 * Client portfolio, Workforce, Risk — two by two on a desktop, one column
 * on a phone. They sit below the fold, so they ask for their data only
 * once the scorecard has answered (or the reader scrolls to them): the
 * first screen's one request is never queued behind four more.
 *
 * A direct employer (a hotel) bills no one, so it has no client portfolio
 * to preview: that one is the staffing company's.
 */
export function Previews({ frame, scorecardSettled }: { frame: ExecFrame; scorecardSettled: boolean }) {
  const { t } = useI18n();
  const { ref, ready } = useBelowTheFold<HTMLDivElement>(scorecardSettled);
  const bills = useTenant().moduleOn('billRates');
  return (
    <div ref={ref} className="grid gap-x-6 gap-y-7 lg:grid-cols-2" data-testid="exec-previews">
      {ready ? (
        <>
          <FinancialsPreview frame={frame} />
          {bills && <ClientsPreview frame={frame} />}
          <WorkforcePreview frame={frame} />
          <RiskPreview frame={frame} />
        </>
      ) : (
        <>
          <Waiting id="exec-home-financials" title={t('execPortal.home.fin.title')} to={execHref('/executive/financials', frame)} label={t('execPortal.home.fin.open')} height={360} />
          {bills && <Waiting id="exec-home-clients" title={t('execPortal.home.clients.title')} to={execHref('/executive/clients', frame)} label={t('execPortal.home.clients.open')} height={300} />}
          <Waiting id="exec-home-workforce" title={t('execPortal.home.people.title')} to={execHref('/executive/people', frame)} label={t('execPortal.home.people.open')} height={340} />
          <Waiting id="exec-home-risk" title={t('execPortal.home.risk.title')} to={execHref('/executive/risk', frame)} label={t('execPortal.home.risk.open')} height={280} />
        </>
      )}
    </div>
  );
}

function Waiting({ id, title, to, label, height }: { id: string; title: string; to: string; label: string; height: number }) {
  return (
    <Preview id={id} title={title} open={{ to, label }}>
      <PreviewBody height={height} />
    </Preview>
  );
}
