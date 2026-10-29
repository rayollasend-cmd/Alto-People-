import { Link } from 'react-router-dom';
import type { ExecClients } from '@alto-people/shared';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { ChartFrame } from '@/components/ui/ChartFrame';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { EmptyState } from '@/components/ui/EmptyState';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Handshake } from '@/components/ui/icons';
import { Funnel } from '@/components/ui/charts';
import { fmtExecExact, fmtExecMoney } from '@/lib/executiveFormat';
import { useI18n } from '@/lib/i18n';
import { useMinWidth } from '@/lib/useViewport';
import '@/lib/i18n/en/execPortal';
import { FinFigure } from '../financials/FinFigure';

type Pipe = ExecClients['pipeline'];
type Prospect = Pipe['prospects'][number];
type T = ReturnType<typeof useI18n>['t'];

const pctWhole = (p: number) => `${Math.round(p * 100)}%`;

/** The pipeline in a sentence: the weighted total, across how many, and the stage carrying the most. */
export function pipelineSentence(p: Pipe, t: T): string {
  const count = p.stages.reduce((s, x) => s + x.count, 0);
  const top = [...p.stages].sort((a, b) => b.weightedAnnual - a.weightedAnnual)[0];
  if (!top || count === 0) return t('execPortal.clients.pipe.emptyBody');
  return t('execPortal.clients.pipe.summary', { total: fmtExecMoney(p.weightedAnnual), count, stage: top.label, amount: fmtExecMoney(top.weightedAnnual) });
}

/**
 * New business: the weighted annual value as the headline, the stages as a
 * funnel (each bar its weighted value; the row says the count, the weekly
 * value and how often a deal at that stage closes), the prospects with how
 * long each has sat in its stage, and the close rates in a footnote.
 */
export function Pipeline({ pipeline }: { pipeline: Pipe }) {
  const { t } = useI18n();
  const wide = useMinWidth(640);
  const count = pipeline.stages.reduce((s, x) => s + x.count, 0);
  if (pipeline.stages.length === 0 || (count === 0 && pipeline.prospects.length === 0)) {
    return (
      <Card>
        <CardContent className="p-4 md:p-5">
          <EmptyState
            icon={Handshake}
            title={t('execPortal.clients.pipe.emptyTitle')}
            description={t('execPortal.clients.pipe.emptyBody')}
            action={
              <Button asChild size="sm" variant="secondary">
                <Link to="/clients/pipeline">{t('execPortal.clients.pipe.open')}</Link>
              </Button>
            }
          />
        </CardContent>
      </Card>
    );
  }
  const summary = pipelineSentence(pipeline, t);
  const stages = pipeline.stages.map((s) => ({
    key: s.stage,
    label: s.label,
    value: s.weightedAnnual,
    detail: t('execPortal.clients.pipe.count', { count: s.count }),
    figure: t('execPortal.clients.pipe.annual', { amount: fmtExecMoney(s.weightedAnnual) }),
    figureDetail: `${t('execPortal.clients.pipe.weekly', { amount: fmtExecMoney(s.weeklyValue) })} · ${t('execPortal.clients.pipe.close', { pct: pctWhole(s.probability) })}`,
  }));
  const columns: GridColumn<Prospect>[] = [
    { key: 'name', header: t('execPortal.clients.pipe.colName'), accessor: (p) => p.name, primary: true, sortable: true },
    { key: 'stage', header: t('execPortal.clients.pipe.colStage'), accessor: (p) => p.stageLabel, sortable: true, cardMeta: true },
    {
      key: 'weekly',
      header: t('execPortal.clients.pipe.colWeekly'),
      accessor: (p) => p.weeklyValue,
      csv: (p) => (p.weeklyValue === null ? '' : p.weeklyValue.toFixed(2)),
      sortable: true,
      searchable: false,
      align: 'right',
      className: 'tabular-nums',
      cell: (p) => (p.weeklyValue === null ? <span className="text-xs2 text-ink-muted">{t('execPortal.clients.pipe.noValue')}</span> : fmtExecExact(p.weeklyValue, 'money')),
    },
    { key: 'days', header: t('execPortal.clients.pipe.colDays'), accessor: (p) => p.daysInStage, sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cell: (p) => t('execPortal.clients.pipe.days', { count: p.daysInStage }) },
  ];
  const rates = pipeline.stages.map((s) => `${s.label} ${pctWhole(s.probability)}`).join(', ');
  return (
    <div className="space-y-4">
      <div className="space-y-4">
        <ChartFrame
          title={t('execPortal.clients.pipe.funnelTitle')}
          description={summary}
          summary={summary}
          columns={[
            { key: 'label', label: t('execPortal.clients.pipe.colStage') },
            { key: 'count', label: t('execPortal.clients.pipe.colCount'), numeric: true },
            { key: 'weeklyValue', label: t('execPortal.clients.pipe.colWeekly'), numeric: true, format: (v) => fmtExecExact(Number(v), 'money') },
            { key: 'probability', label: t('execPortal.clients.pipe.colProb'), numeric: true, format: (v) => pctWhole(Number(v)) },
            { key: 'weightedAnnual', label: t('execPortal.clients.pipe.colAnnual'), numeric: true, format: (v) => fmtExecExact(Number(v), 'money') },
          ]}
          rows={pipeline.stages.map((s) => ({ ...s }))}
          csvName="pipeline-by-stage"
          height={84 + stages.length * (wide ? 44 : 76)}
          zerosMeaningful
        >
          <div className="space-y-4">
            <FinFigure label={t('execPortal.clients.pipe.headlineLabel')} value={t('execPortal.clients.pipe.annual', { amount: fmtExecMoney(pipeline.weightedAnnual) })} exact={fmtExecExact(pipeline.weightedAnnual, 'money')} testId="exec-pipeline-total" />
            <Funnel stages={stages} />
          </div>
        </ChartFrame>
        <Card className="min-w-0">
          <CardContent className="space-y-3 p-4 md:p-5">
            <SectionTitle wrap className="mb-0" title={t('execPortal.clients.pipe.prospects')} description={t('execPortal.clients.pipe.prospectsDesc')} />
            <DataGrid
              id="exec-clients-prospects"
              caption={t('execPortal.clients.pipe.prospects')}
              rows={pipeline.prospects}
              columns={columns}
              rowKey={(p) => p.id}
              rowHref={() => '/clients/pipeline'}
              noun={{ one: t('execPortal.clients.pipe.nounOne'), many: t('execPortal.clients.pipe.nounMany') }}
              search={false}
              urlState={false}
              columnChooser={false}
              exportCsv={{ filename: 'prospects' }}
              empty={{ icon: Handshake, title: t('execPortal.clients.pipe.emptyTitle'), description: t('execPortal.clients.pipe.emptyBody') }}
            />
          </CardContent>
        </Card>
      </div>
      <p className="text-xs2 text-ink-muted" data-testid="exec-pipeline-footnote">
        {t('execPortal.clients.pipe.foot', { rates })}
      </p>
    </div>
  );
}
