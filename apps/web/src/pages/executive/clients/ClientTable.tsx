import type { ExecClientRow } from '@alto-people/shared';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent } from '@/components/ui/Card';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Building2 } from '@/components/ui/icons';
import { Sparkline } from '@/components/ui/charts';
import { fmtExecExact } from '@/lib/executiveFormat';
import { fmtHours } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import '@/lib/i18n/en/execPortal';
import { pct1 } from '../financials/finMath';
import { HEALTH_RANK, fmtNps, healthTone } from './clientMath';

const HEALTH_BADGE = { good: 'success', watch: 'pending', bad: 'destructive', none: 'default' } as const;

/** A client's health as a chip: the clients list's word, in its scale step (Good positive, Watch caution, At risk negative). */
export function HealthChip({ client }: { client: Pick<ExecClientRow, 'health' | 'healthLabel'> }) {
  const { t } = useI18n();
  const tone = healthTone(client);
  if (tone === 'none') return <span className="text-xs2 text-ink-muted">{t('execPortal.clients.health.none')}</span>;
  return (
    <Badge size="sm" variant={HEALTH_BADGE[tone]}>
      {t(`execPortal.clients.health.${tone}`)}
    </Badge>
  );
}

/**
 * Every client, the period's figures exact: billed and margin, the rate and
 * share, the people and hours, how well shifts were filled, the latest NPS,
 * health, and eight weeks of billing as a line. Largest first; on a phone
 * a card per client.
 */
export function ClientTable({ clients }: { clients: ExecClientRow[] }) {
  const { t } = useI18n();
  const columns: GridColumn<ExecClientRow>[] = [
    { key: 'client', header: t('execPortal.clients.col.client'), accessor: (c) => c.name, primary: true, sortable: true },
    { key: 'billed', header: t('execPortal.clients.col.billed'), accessor: (c) => c.billed, csv: (c) => c.billed.toFixed(2), sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cell: (c) => fmtExecExact(c.billed, 'money') },
    { key: 'margin', header: t('execPortal.clients.col.margin'), accessor: (c) => c.margin, csv: (c) => c.margin.toFixed(2), sortable: true, searchable: false, align: 'right', className: 'tabular-nums', hideBelow: 820, cell: (c) => `${c.margin < 0 ? '−' : ''}${fmtExecExact(Math.abs(c.margin), 'money')}` },
    { key: 'marginPct', header: t('execPortal.clients.col.marginPct'), accessor: (c) => c.marginPct, sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cardMeta: true, cell: (c) => pct1(c.marginPct) },
    { key: 'share', header: t('execPortal.clients.col.share'), accessor: (c) => c.sharePct, sortable: true, searchable: false, align: 'right', className: 'tabular-nums', hideBelow: 900, cell: (c) => pct1(c.sharePct) },
    { key: 'headcount', header: t('execPortal.clients.col.headcount'), accessor: (c) => c.headcount, sortable: true, searchable: false, align: 'right', className: 'tabular-nums', hideBelow: 700 },
    { key: 'hours', header: t('execPortal.clients.col.hours'), accessor: (c) => c.hours, sortable: true, searchable: false, align: 'right', className: 'tabular-nums', hideBelow: 1100, cell: (c) => fmtHours(c.hours) },
    { key: 'fill', header: t('execPortal.clients.col.fill'), accessor: (c) => c.fillPct, sortable: true, searchable: false, align: 'right', className: 'tabular-nums', hideBelow: 960, cell: (c) => pct1(c.fillPct) },
    { key: 'nps', header: t('execPortal.clients.col.nps'), accessor: (c) => c.nps, sortable: true, searchable: false, align: 'right', className: 'tabular-nums', hideBelow: 1020, cell: (c) => fmtNps(c.nps) },
    {
      key: 'health',
      header: t('execPortal.clients.col.health'),
      // Sorts worst first ascending: at risk, watch, good, then no word.
      accessor: (c) => HEALTH_RANK[healthTone(c)],
      csv: (c) => {
        const tone = healthTone(c);
        return tone === 'none' ? '' : t(`execPortal.clients.health.${tone}`);
      },
      sortable: true,
      searchable: false,
      cell: (c) => <HealthChip client={c} />,
    },
    {
      key: 'trend',
      header: t('execPortal.clients.col.trend'),
      accessor: (c) => c.trend.reduce((s, v) => s + v, 0),
      csv: (c) => c.trend.map((v) => v.toFixed(2)).join(' '),
      searchable: false,
      hideBelow: 760,
      cell: (c) => (c.trend.filter((v) => v > 0).length >= 2 ? <Sparkline series={c.trend} tone="neutral" width={72} height={22} label={t('execPortal.clients.trendAria', { name: c.name })} /> : <span className="text-xs2 text-ink-muted">—</span>),
    },
  ];
  return (
    <Card className="min-w-0">
      <CardContent className="space-y-3 p-4 md:p-5">
        <SectionTitle wrap className="mb-0" title={t('execPortal.clients.table.title')} description={t('execPortal.clients.table.desc')} />
        <DataGrid
          id="exec-clients-table"
          caption={t('execPortal.clients.table.title')}
          rows={clients}
          columns={columns}
          rowKey={(c) => c.clientId}
          rowHref={(c) => c.href}
          noun={{ one: t('execPortal.clients.noun.one'), many: t('execPortal.clients.noun.many') }}
          defaultSort={{ key: 'billed', direction: 'desc' }}
          urlState={false}
          exportCsv={{ filename: 'client-portfolio' }}
          empty={{ icon: Building2, title: t('execPortal.clients.empty'), description: t('execPortal.clients.emptyBody') }}
        />
      </CardContent>
    </Card>
  );
}
