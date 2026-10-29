import { Link } from 'react-router-dom';
import type { ExecRisk, ExecRiskCategory } from '@alto-people/shared';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { FilterChip } from '@/components/ui/FilterBar';
import { ArrowDownRight, ArrowUpRight, Minus, ShieldCheck, Sparkles } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { execHref, useExecFrame } from '@/lib/executiveApi';
import { useI18n } from '@/lib/i18n';
import { useUrlParam } from '@/lib/useUrlState';
import '@/lib/i18n/en/execPortal';
import { CATEGORIES, CATEGORY_FILTERS, SEVERITY_RANK, TREND_TEXT, countBy, type CategoryFilter } from './riskMeta';
import { SeverityChip } from './SeverityChip';
import { RiskDetailDrawer, isDetailHref, useOpenRisk } from './RiskDetail';

/**
 * The risk register as the board reads one: severity, the risk in a line,
 * what it means, who owns it, which way it is moving, the number behind
 * it, and the page that works it. Highest severity first; a chip per area
 * narrows it (kept in the URL, so a filtered register can be sent).
 *
 * A row opens its detail in place (RiskDetailDrawer); "Open" goes to the
 * risk's page only when every executive can read that page, keeping the
 * frame on executive pages (execHref).
 */
const TREND_ICON = { rising: ArrowUpRight, easing: ArrowDownRight, steady: Minus, new: Sparkles } as const;

export function RiskRegister({ risks, categories = CATEGORIES }: { risks: ExecRisk[]; categories?: readonly ExecRiskCategory[] }) {
  const { t } = useI18n();
  const frame = useExecFrame();
  const [, setOpenRisk] = useOpenRisk();
  const [category, setCategory] = useUrlParam<CategoryFilter>('category', 'all', CATEGORY_FILTERS);
  const counts = countBy(risks, (r) => r.category, categories);
  const rows = category === 'all' ? risks : risks.filter((r) => r.category === category);

  const columns: GridColumn<ExecRisk>[] = [
    {
      key: 'severity',
      header: t('execPortal.risk.colSeverity'),
      accessor: (r) => SEVERITY_RANK[r.severity],
      csv: (r) => t(`execPortal.risk.sev.${r.severity}`),
      cell: (r) => <SeverityChip severity={r.severity}>{t(`execPortal.risk.sev.${r.severity}`)}</SeverityChip>,
      sortable: true,
      searchable: false,
      width: '7rem',
      cardMeta: true,
    },
    {
      key: 'title',
      header: t('execPortal.risk.colRisk'),
      accessor: (r) => r.title,
      primary: true,
      sortable: true,
      cell: (r) => (
        <div className="min-w-0">
          <div className="font-medium text-ink">{r.title}</div>
          <div className="text-xs2 text-ink-muted">{t(`execPortal.risk.cat.${r.category}`)}</div>
        </div>
      ),
    },
    {
      key: 'detail',
      header: t('execPortal.risk.colDetail'),
      accessor: (r) => r.detail,
      cell: (r) => <p className="max-w-md text-sm text-ink-muted [&]:whitespace-normal">{r.detail}</p>,
      hideBelow: 880,
    },
    { key: 'owner', header: t('execPortal.risk.colOwner'), accessor: (r) => r.owner, sortable: true },
    {
      key: 'trend',
      header: t('execPortal.risk.colTrend'),
      accessor: (r) => t(`execPortal.risk.trend.${r.trend}`),
      cell: (r) => {
        const Icon = TREND_ICON[r.trend];
        return (
          <span className={cn('inline-flex items-center gap-1 whitespace-nowrap text-sm', TREND_TEXT[r.trend])}>
            <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {t(`execPortal.risk.trend.${r.trend}`)}
          </span>
        );
      },
    },
    { key: 'metric', header: t('execPortal.risk.colMetric'), accessor: (r) => r.metric ?? '—', cell: (r) => <span className="tabular-nums text-ink">{r.metric ?? '—'}</span>, hideBelow: 720 },
    {
      key: 'open',
      header: t('execPortal.risk.colOpen'),
      accessor: () => null,
      csv: (r) => r.href,
      searchable: false,
      stopRowClick: true,
      align: 'right',
      cell: (r) =>
        isDetailHref(r.href) ? (
          <button
            type="button"
            onClick={() => setOpenRisk(r.id)}
            className="inline-flex min-h-8 items-center rounded-md px-2 text-sm text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent coarse:min-h-11"
            aria-label={t('execPortal.risk.detailsAria', { title: r.title })}
            data-testid={`exec-risk-details-${r.id}`}
          >
            {t('execPortal.risk.details')}
          </button>
        ) : (
          <Link
            to={execHref(r.href, frame)}
            className="inline-flex min-h-8 items-center rounded-md px-2 text-sm text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent coarse:min-h-11"
            aria-label={t('execPortal.risk.openAria', { title: r.title })}
            data-testid={`exec-risk-open-${r.id}`}
          >
            {t('execPortal.risk.open')}
          </Link>
        ),
    },
  ];

  return (
    <>
    <DataGrid<ExecRisk>
      id="exec-risk-register"
      caption={t('execPortal.risk.caption')}
      noun={{ one: t('execPortal.risk.nounOne'), many: t('execPortal.risk.nounMany') }}
      rows={rows}
      columns={columns}
      rowKey={(r) => r.id}
      onRowClick={(r) => setOpenRisk(r.id)}
      rowActionLabel={(r) => t('execPortal.risk.detailsAria', { title: r.title })}
      defaultSort={{ key: 'severity', direction: 'desc' }}
      search={false}
      columnChooser={false}
      urlKey="risk"
      exportCsv={{ filename: 'risk-register' }}
      filterKeys={['category']}
      activeFilters={category === 'all' ? 0 : 1}
      onClearFilters={() => setCategory('all')}
      filters={
        <div className="flex flex-wrap gap-2" role="group" aria-label={t('execPortal.risk.filterAria')}>
          {(['all', ...categories] as CategoryFilter[]).map((c) => (
            <FilterChip key={c} active={category === c} count={c === 'all' ? risks.length : counts[c]} onClick={() => setCategory(c)}>
              {c === 'all' ? t('execPortal.risk.catAll') : t(`execPortal.risk.cat.${c}`)}
            </FilterChip>
          ))}
        </div>
      }
      empty={{ icon: ShieldCheck, title: t('execPortal.risk.emptyTitle'), description: t('execPortal.risk.emptyBody') }}
    />
    <RiskDetailDrawer risks={risks} />
    </>
  );
}
