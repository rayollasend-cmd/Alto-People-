import type { ExecFinanceWeek } from '@alto-people/shared';
import { ChartFrame } from '@/components/ui/ChartFrame';
import { fmtMoneyAxis } from '@/components/ui/charts/axes';
import { PALETTE, SparseReading, StackedBarChart, TREND_MIN_POINTS, TrendLineChart } from '@/components/ui/charts';
import { fmtExecMoney } from '@/lib/executiveFormat';
import { fmtDateOnly, fmtHours } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import '@/lib/i18n/en/execPortal';
import { signedExact } from './MarginWaterfall';
import { pct1, weeksTrend, weeksWithData } from './finMath';

type T = ReturnType<typeof useI18n>['t'];

/** The thirteen weeks in words: the latest week, then which way billing and the margin rate went. */
export function weeksSentence(weeks: ReadonlyArray<ExecFinanceWeek>, t: T): string {
  const withData = weeksWithData(weeks);
  const latest = withData[withData.length - 1];
  if (!latest) return t('execPortal.fin.weeks.empty');
  const parts = [t('execPortal.fin.weeks.latest', { week: fmtDateOnly(latest.start, { year: 'auto' }), billed: fmtExecMoney(latest.billed), cost: fmtExecMoney(latest.cost), pct: pct1(latest.marginPct) })];
  const tr = weeksTrend(weeks);
  if (tr) {
    const vars = { avg: fmtExecMoney(tr.recentAvg), change: tr.change === null ? '' : pct1(Math.abs(tr.change) * 100), n: tr.n };
    const key = tr.change === null || Math.abs(tr.change) < 0.01 ? 'execPortal.fin.weeks.flat' : tr.change > 0 ? 'execPortal.fin.weeks.up' : 'execPortal.fin.weeks.down';
    parts.push(t(key, vars));
    if (tr.marginFrom !== null && tr.marginTo !== null) {
      parts.push(Math.abs(tr.marginTo - tr.marginFrom) < 0.5 ? t('execPortal.fin.weeks.marginHeld', { to: pct1(tr.marginTo) }) : t('execPortal.fin.weeks.marginMove', { from: pct1(tr.marginFrom), to: pct1(tr.marginTo) }));
    }
  }
  return parts.join(' ');
}

/**
 * The last thirteen complete weeks: billed beside what the work cost, the
 * newest week at full strength and named, and the margin rate as its own
 * small line underneath — a percentage never shares an axis with dollars.
 */
export function ThirteenWeeks({ weeks }: { weeks: ExecFinanceWeek[] }) {
  const { t } = useI18n();
  const withData = weeksWithData(weeks);
  const latest = withData[withData.length - 1];
  const sparse = withData.length < TREND_MIN_POINTS;
  const summary = weeksSentence(weeks, t);
  const data = weeks.map((w) => ({ week: w.start, billed: w.billed, cost: w.cost, marginPct: w.marginPct }));
  const pctAxis = (v: number) => `${Math.round(v)}%`;
  return (
    <ChartFrame
      title={t('execPortal.fin.weeks.title')}
      description={withData.length > 0 ? summary : t('execPortal.fin.weeks.desc')}
      summary={summary}
      columns={[
        { key: 'week', label: t('execPortal.fin.weeks.week'), format: (v) => fmtDateOnly(String(v), { year: 'auto' }) },
        { key: 'billed', label: t('execPortal.fin.weeks.billed'), numeric: true, format: (v) => signedExact(Number(v)) },
        { key: 'cost', label: t('execPortal.fin.weeks.cost'), numeric: true, format: (v) => signedExact(Number(v)) },
        { key: 'margin', label: t('execPortal.fin.weeks.margin'), numeric: true, format: (v) => signedExact(Number(v)) },
        { key: 'marginPct', label: t('execPortal.fin.weeks.marginPct'), numeric: true, format: (v) => (typeof v === 'number' ? pct1(v) : '—') },
        { key: 'hours', label: t('execPortal.fin.weeks.hours'), numeric: true, format: (v) => fmtHours(Number(v)) },
        { key: 'otHours', label: t('execPortal.fin.weeks.otHours'), numeric: true, format: (v) => fmtHours(Number(v)) },
      ]}
      rows={withData.map((w) => ({ ...w, week: w.start }))}
      csvName="thirteen-weeks"
      height={sparse ? 150 : 340}
      empty={<p className="py-6 text-sm text-ink-muted">{t('execPortal.fin.weeks.empty')}</p>}
    >
      {sparse ? (
        latest && (
          <SparseReading
            figures={[
              { label: t('execPortal.fin.weeks.billed'), value: fmtExecMoney(latest.billed) },
              { label: t('execPortal.fin.weeks.cost'), value: fmtExecMoney(latest.cost) },
              { label: t('execPortal.fin.weeks.marginPct'), value: pct1(latest.marginPct) },
            ]}
            note={t('execPortal.fin.weeks.sparse', { count: withData.length, week: fmtDateOnly(latest.start, { year: 'auto' }) })}
          />
        )
      ) : (
        <div className="flex h-full flex-col gap-2">
          <div className="min-h-0 flex-1">
            <StackedBarChart
              data={data}
              x="week"
              xDates="week"
              stacked={false}
              series={[
                { key: 'billed', name: t('execPortal.fin.weeks.billed'), color: PALETTE.secondary },
                { key: 'cost', name: t('execPortal.fin.weeks.cost'), color: PALETTE.other },
              ]}
              format={fmtMoneyAxis}
              highlight={latest?.start}
            />
          </div>
          <div className="shrink-0 border-t border-line-subtle pt-2">
            <div className="text-2xs uppercase tracking-[0.18em] text-ink-muted">{t('execPortal.fin.weeks.marginPct')}</div>
            <TrendLineChart data={data} x="week" xDates="week" series={[{ key: 'marginPct', name: t('execPortal.fin.weeks.marginPct'), color: PALETTE.tertiary }]} format={pctAxis} zeroBased={false} height={84} />
          </div>
        </div>
      )}
    </ChartFrame>
  );
}
