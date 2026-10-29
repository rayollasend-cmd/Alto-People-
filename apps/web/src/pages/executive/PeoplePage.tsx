import { ExecPage, ExecSection } from '@/components/executive/ExecPage';
import { KpiCard } from '@/components/executive/KpiCard';
import { QueryError } from '@/components/ui/QueryError';
import { Skeleton } from '@/components/ui/Skeleton';
import { execHref, useExecFrame, useExecPeople } from '@/lib/executiveApi';
import { useI18n } from '@/lib/i18n';
import '@/lib/i18n/en/execPortal';
import { AttendanceHeatmap } from './people/AttendanceHeatmap';
import { PeopleBand } from './people/PeopleBand';
import { TurnoverCard } from './people/TurnoverCard';
import { HeadcountTrend, HiresSeparations, OvertimeTrend, TenureBands } from './people/WorkforceCharts';
import { WorkforceCounts } from './people/WorkforceCounts';

/**
 * The chairman's Workforce page (2026-10-27): are we keeping the people
 * the business runs on? The scorecard's people measures against the
 * chosen comparison, where everyone stands in the People directory's own
 * words, thirteen weeks of working headcount, joiners and leavers,
 * turnover against its plan and what it costs, overtime's share of paid
 * hours, where attendance slips, how long people stay — and the people
 * themselves to close. One frame (period · comparison) for every figure.
 */
export function ExecPeoplePage() {
  const { t } = useI18n();
  const frame = useExecFrame();
  const q = useExecPeople(frame);
  const data = q.data ?? null;
  const compareLabel = data?.comparison.available ? data.comparison.label : t('execPortal.people.noComparison');

  return (
    <ExecPage title={t('execPortal.people.title')} subtitle={t('execPortal.people.subtitle')} frame={frame} period={data?.period} comparison={data?.comparison} testId="exec-people">
      {q.isError && !data ? (
        <QueryError what={t('execPortal.people.what')} query={q} />
      ) : !data ? (
        <div className="space-y-6" aria-hidden="true">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-40" />
            ))}
          </div>
          <Skeleton className="h-28" />
          <div className="grid gap-4 lg:grid-cols-2">
            <Skeleton className="h-72" />
            <Skeleton className="h-72" />
          </div>
        </div>
      ) : (
        <>
          {data.kpis.length > 0 && (
            <section aria-label={t('execPortal.people.kpisAria')} className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-4">
              {data.kpis.map((k) => (
                <KpiCard key={k.id} kpi={k} comparisonLabel={compareLabel} href={execHref(k.href, frame)} />
              ))}
            </section>
          )}

          <ExecSection id="exec-people-counts" title={t('execPortal.people.countsTitle')} description={t('execPortal.people.countsDesc')}>
            <WorkforceCounts counts={data.counts} />
          </ExecSection>

          <ExecSection id="exec-people-movement" title={t('execPortal.people.movementTitle')} description={t('execPortal.people.movementDesc')}>
            <div className="grid gap-4 lg:grid-cols-2">
              <HeadcountTrend weeks={data.weeks} />
              <HiresSeparations weeks={data.weeks} />
            </div>
          </ExecSection>

          <ExecSection id="exec-people-retention" title={t('execPortal.people.retentionTitle')} description={t('execPortal.people.retentionDesc')}>
            <div className="grid gap-4 lg:grid-cols-2">
              <TurnoverCard data={data} />
              <OvertimeTrend weeks={data.weeks} />
            </div>
          </ExecSection>

          <ExecSection id="exec-people-attendance" title={t('execPortal.people.reliabilityTitle')} description={t('execPortal.people.reliabilityDesc')}>
            <div className="grid gap-4 xl:grid-cols-3">
              <div className="min-w-0 xl:col-span-2">
                <AttendanceHeatmap attendance={data.attendance} />
              </div>
              <TenureBands tenure={data.tenure} />
            </div>
          </ExecSection>

          <ExecSection id="exec-people-faces" title={t('execPortal.people.facesTitle')} description={t('execPortal.people.facesDesc')}>
            <PeopleBand data={data} />
          </ExecSection>

          <p className="text-xs text-ink-muted">{t('execPortal.people.footnote')}</p>
        </>
      )}
    </ExecPage>
  );
}
