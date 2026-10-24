import { CalendarCheck } from '@/components/ui/icons';
import { ChartFrame } from '@/components/ui/ChartFrame';
import { lazyPlot } from '@/components/ui/charts/lazyPlot';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryError } from '@/components/ui/QueryError';
import { Skeleton } from '@/components/ui/Skeleton';
import { useI18n } from '@/lib/i18n';
import { useAttendanceTrends } from './AttendanceTrendTiles';
import { weekLabel, weekOf } from './weekLabel';
import '@/lib/i18n/en/floorUi';
import '@/lib/i18n/en/portal';

/** The drawing (recharts) loads with the first chart, not the page (lazyPlot). */
const FillRateTrendPlot = lazyPlot(() => import('./FillRateTrend.plot').then((m) => ({ default: m.FillRateTrendPlot })));

/**
 * Fill rate, week by week for eight workweeks, against the 95% line the
 * store is graded on — the last point is the week in progress. A week
 * with nothing scheduled is a gap, and only real weeks carry a dot.
 */
export function FillRateTrendCard({ siteId, className }: { siteId?: string; className?: string }) {
  const { t } = useI18n();
  const q = useAttendanceTrends({ siteId });
  if (q.isPending) return <Skeleton className={className ?? 'h-72'} />;
  if (q.isError) return <QueryError what={t('floorUi.fillTrendWhat')} query={q} />;
  const { weeks, fillTargetPct } = q.data;
  // Every week stays on the axis: a week with nothing scheduled is a gap
  // in the line, never a slope drawn across it.
  const all = weeks.map((w) => ({ week: weekLabel(w.weekStart), weekStart: w.weekStart, fill: w.fillRatePct, filled: w.filledShifts, scheduled: w.scheduledShifts, inProgress: w.inProgress ? t('floorUi.yes') : '', partial: w.inProgress }));
  const rows = all.filter((r) => r.fill !== null);
  const lowest = rows.reduce((m, r) => Math.min(m, r.fill ?? 100), 100);
  const floor = Math.max(0, Math.min(80, Math.floor((lowest - 5) / 10) * 10));
  const met = rows.filter((r) => (r.fill ?? 0) >= fillTargetPct).length;
  const latest = rows[rows.length - 1];
  const gaps = all.length - rows.length;
  const summary =
    rows.length === 0
      ? t('floorUi.fillNothingEight')
      : `${t(latest!.inProgress ? 'floorUi.fillSummaryThisWeek' : 'floorUi.fillSummaryLatest', { target: fillTargetPct, met, n: rows.length, fill: latest!.fill ?? '' })}${gaps > 0 ? ` ${t(gaps === 1 ? 'floorUi.fillGapOne' : 'floorUi.fillGapMany', { n: gaps })}` : ''}`;

  // Nothing in eight weeks: one line, not an empty chart.
  if (rows.length === 0) {
    return (
      <div className={className}>
        <p className="rounded-lg border border-line px-4 py-3 text-sm text-ink-muted">{t('floorUi.fillEmptyLine')}</p>
      </div>
    );
  }
  return (
    <div className={className}>
      <ChartFrame
        title={t('floorUi.fillTitle')}
        description={t('floorUi.fillDesc', { target: fillTargetPct })}
        summary={summary}
        columns={[
          { key: 'week', label: t('floorUi.weekOf') },
          { key: 'fill', label: t('portal.chartFillPct'), numeric: true, format: (v) => (v === null || v === undefined ? t('floorUi.nothingScheduled') : `${String(v)}%`) },
          { key: 'filled', label: t('portal.chartFilled'), numeric: true },
          { key: 'scheduled', label: t('portal.chartScheduled'), numeric: true },
          { key: 'inProgress', label: t('portal.reqInProgress') },
        ]}
        rows={rows.length === 0 ? rows : all}
        csvName="fill-rate-8-weeks"
        height={220}
        empty={<EmptyState size="sm" icon={CalendarCheck} title={t('floorUi.nothingScheduledYet')} description={t('floorUi.fillLineStarts')} />}
      >
        <FillRateTrendPlot
          data={all.map((r) => ({ ...r, noShifts: r.fill === null ? floor : null }))}
          floor={floor}
          fillTargetPct={fillTargetPct}
          fillName={t('portal.chartFillPct')}
          heading={(label) => {
            const row = all.find((r) => r.week === label);
            return row ? `${weekOf(row.weekStart)}${row.inProgress ? ` ${t('floorUi.soFar')}` : ''}` : label;
          }}
          targetLabel={t('floorUi.pctTarget', { pct: fillTargetPct })}
          noShiftsText={t('floorUi.noShiftsShort')}
        />
      </ChartFrame>
    </div>
  );
}
