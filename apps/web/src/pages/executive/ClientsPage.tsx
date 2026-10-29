import type { ExecClients } from '@alto-people/shared';
import { ExecPage, ExecSection } from '@/components/executive/ExecPage';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryError } from '@/components/ui/QueryError';
import { Building2 } from '@/components/ui/icons';
import { Link } from 'react-router-dom';
import { Skeleton } from '@/components/ui/Skeleton';
import { useTenant } from '@/lib/auth';
import { execHref, useExecClients, useExecFrame } from '@/lib/executiveApi';
import { useI18n } from '@/lib/i18n';
import '@/lib/i18n/en/execPortal';
import { ClientMatrix } from './clients/ClientMatrix';
import { ClientTable } from './clients/ClientTable';
import { Concentration } from './clients/Concentration';
import { Pipeline } from './clients/Pipeline';
import { StoreLeague } from './clients/StoreLeague';
import { BoardPackLink } from './financials/BoardPackLink';

/**
 * The chairman's Client portfolio (2026-10-27): who the revenue depends on
 * (concentration, with the risk line and the index in words), what each
 * client earns against its size and health (the matrix), every client's
 * figures exact (the table), what is coming (the weighted pipeline) and how
 * each store performs (the league).
 */
export function ExecClientsPage() {
  const { moduleOn } = useTenant();
  // A direct employer bills no one: the portfolio has nothing to read (and no words for it).
  if (!moduleOn('clientPortal')) return <NoPortfolio />;
  return <Portfolio />;
}

function NoPortfolio() {
  const { t } = useI18n();
  const frame = useExecFrame();
  return (
    <ExecPage title={t('execPortal.clients.off.title')} subtitle={t('execPortal.clients.off.subtitle')} testId="exec-clients-off">
      <Card>
        <CardContent className="p-4 md:p-5">
          <EmptyState
            icon={Building2}
            title={t('execPortal.clients.off.emptyTitle')}
            description={t('execPortal.clients.off.emptyBody')}
            action={
              <Button asChild size="sm" variant="secondary">
                <Link to={execHref('/executive/financials', frame)}>{t('execPortal.fin.title')}</Link>
              </Button>
            }
          />
        </CardContent>
      </Card>
    </ExecPage>
  );
}

function Portfolio() {
  const { t } = useI18n();
  const frame = useExecFrame();
  const q = useExecClients(frame);
  const d = q.data;
  return (
    <ExecPage
      title={t('execPortal.clients.title')}
      subtitle={t('execPortal.clients.subtitle')}
      frame={frame}
      period={d?.period}
      comparison={d?.comparison}
      actions={<BoardPackLink frame={frame} />}
      testId="exec-clients"
    >
      {!d ? q.isError ? <QueryError what={t('execPortal.clients.what')} query={q} /> : <ClientsSkeleton /> : <ClientsBody d={d} />}
    </ExecPage>
  );
}

function ClientsSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" data-testid="exec-clients-loading">
      <Skeleton className="h-64 rounded-lg" />
      <Skeleton className="h-96 rounded-lg" />
      <Skeleton className="h-80 rounded-lg" />
    </div>
  );
}

function ClientsBody({ d }: { d: ExecClients }) {
  const { t } = useI18n();
  return (
    <>
      <ExecSection id="exec-clients-who" title={t('execPortal.clients.sec.who')} description={t('execPortal.clients.sec.whoDesc')}>
        <div className="grid gap-4 xl:grid-cols-2">
          <Concentration d={d} />
          <ClientMatrix clients={d.clients} />
        </div>
      </ExecSection>

      <ExecSection id="exec-clients-every" title={t('execPortal.clients.sec.every')} description={t('execPortal.clients.sec.everyDesc')}>
        <ClientTable clients={d.clients} />
      </ExecSection>

      <ExecSection id="exec-clients-pipeline" title={t('execPortal.clients.pipe.title')} description={t('execPortal.clients.pipe.desc')}>
        <Pipeline pipeline={d.pipeline} />
      </ExecSection>

      <ExecSection id="exec-clients-league" title={t('execPortal.clients.league.title')} description={t('execPortal.clients.league.desc')}>
        <StoreLeague league={d.league} />
      </ExecSection>

      <footer className="border-t border-line-subtle pt-4 text-xs2 text-ink-muted" data-testid="exec-clients-footnote">
        <p>{t('execPortal.clients.foot')}</p>
      </footer>
    </>
  );
}
