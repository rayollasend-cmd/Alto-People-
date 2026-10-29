import type { ExecPeople } from '@alto-people/shared';
import { ChartFrame } from '@/components/ui/ChartFrame';
import { QueryError } from '@/components/ui/QueryError';
import { StackedBarChart } from '@/components/ui/charts';
import { BulletBar } from '@/components/executive/BulletBar';
import { cn } from '@/lib/cn';
import { execHref, useExecPeople, type ExecFrame } from '@/lib/executiveApi';
import { deltaTone, fmtExecDelta, STATUS_TEXT } from '@/lib/executiveFormat';
import { fmtDateOnly } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import '@/lib/i18n/en/execPortal';
import { Figure, Figures, Preview, PreviewBody } from './PreviewParts';

/**
 * The workforce, in one look (2026-10-27): who joined and who left, week by
 * week for thirteen weeks; turnover against the plan as a bullet; and the
 * overtime share of paid hours — the three questions under "do we have
 * the people, and are we keeping them".
 */
export function WorkforcePreview({ frame }: { frame: ExecFrame }) {
  const { t } = useI18n();
  const q = useExecPeople(frame);
  const d = q.data;
  return (
    <Preview
      id="exec-home-workforce"
      title={t('execPortal.home.people.title')}
      answer={d ? peopleAnswer(d, t) : undefined}
      open={{ to: execHref('/executive/people', frame), label: t('execPortal.home.people.open') }}
      testId="exec-preview-workforce"
    >
      {!d ? q.isError ? <QueryError what={t('execPortal.home.people.what')} query={q} /> : <PreviewBody height={340} /> : <PeopleBody d={d} />}
    </Preview>
  );
}

type T = ReturnType<typeof useI18n>['t'];

const sum = (d: ExecPeople, k: 'hires' | 'separations') => d.weeks.reduce((n, w) => n + w[k], 0);

function peopleAnswer(d: ExecPeople, t: T): string {
  return t('execPortal.home.people.answer', {
    active: d.counts.active.toLocaleString('en-US'),
    hires: sum(d, 'hires'),
    left: sum(d, 'separations'),
    weeks: d.weeks.length,
  });
}

function PeopleBody({ d }: { d: ExecPeople }) {
  const { t } = useI18n();
  const hires = sum(d, 'hires');
  const left = sum(d, 'separations');
  const turnoverKpi = d.kpis.find((k) => k.id === 'turnover') ?? null;
  const otKpi = d.kpis.find((k) => k.id === 'overtimePct') ?? null;
  const turnover = d.turnover.annualizedPct ?? turnoverKpi?.value ?? null;
  const target = d.turnover.targetPct ?? turnoverKpi?.target ?? null;
  const tStatus = turnoverKpi?.status ?? 'none';
  const rows = d.weeks.map((w) => ({ start: w.start, hires: w.hires, separations: w.separations }));
  const otDelta = otKpi ? fmtExecDelta(otKpi) : null;
  const otTone = otKpi ? deltaTone(otKpi) : 'neutral';
  return (
    <div className="space-y-3">
      <ChartFrame
        title={t('execPortal.home.people.chartTitle', { count: d.weeks.length })}
        summary={t('execPortal.home.people.chartSummary', { hires, left, weeks: d.weeks.length })}
        columns={[
          { key: 'start', label: t('execPortal.home.people.colWeek'), format: (v) => t('execPortal.home.people.weekOf', { date: fmtDateOnly(String(v), { year: 'auto' }) }) },
          { key: 'hires', label: t('execPortal.home.people.hires'), numeric: true },
          { key: 'separations', label: t('execPortal.home.people.separations'), numeric: true },
        ]}
        rows={rows}
        csvName="hires-and-separations"
        height={160}
        empty={<p className="py-6 text-sm text-ink-muted">{t('execPortal.home.people.chartEmpty', { count: d.weeks.length })}</p>}
      >
        <StackedBarChart
          data={rows}
          x="start"
          xDates="week"
          stacked={false}
          series={[
            { key: 'hires', name: t('execPortal.home.people.hires') },
            { key: 'separations', name: t('execPortal.home.people.separations') },
          ]}
          format={(v) => String(Math.round(v))}
        />
      </ChartFrame>
      <Figures>
        <div className="min-w-0 px-3 py-3 sm:px-4" data-testid="exec-people-turnover">
          <dt className="text-2xs font-semibold uppercase leading-snug tracking-[0.14em] text-ink-muted">{t('execPortal.home.people.turnover')}</dt>
          <dd className="mt-1 font-display text-2xl leading-none tabular-nums text-ink" title={turnoverKpi?.definition}>
            {turnover === null ? '—' : `${turnover.toFixed(1)}%`}
          </dd>
          <dd className="mt-2 space-y-1">
            {target !== null && turnover !== null && (
              <BulletBar value={turnover} target={target} status={tStatus} label={t('execPortal.home.people.turnoverAria', { value: `${turnover.toFixed(1)}%`, target: `${target.toFixed(1)}%` })} />
            )}
            <div className="flex items-center justify-between gap-2 text-xs2">
              <span className={cn('font-medium', STATUS_TEXT[tStatus])}>{turnoverKpi?.statusLabel ?? (target === null ? t('execPortal.home.people.noPlan') : '')}</span>
              {target !== null && <span className="tabular-nums text-ink-muted">{t('execPortal.plan', { value: `${target.toFixed(1)}%` })}</span>}
            </div>
          </dd>
        </div>
        <Figure
          label={t('execPortal.home.people.overtime')}
          value={otKpi?.value != null ? `${otKpi.value.toFixed(1)}%` : '—'}
          title={otKpi?.definition}
          sub={
            otDelta ? (
              <>
                <span className={cn('font-medium tabular-nums', otTone === 'good' ? 'text-positive-800' : otTone === 'bad' ? 'text-negative-800' : undefined)}>{otDelta}</span> {d.comparison.label}
              </>
            ) : (
              t('execPortal.home.people.otSub')
            )
          }
          testId="exec-people-ot"
        />
      </Figures>
    </div>
  );
}
