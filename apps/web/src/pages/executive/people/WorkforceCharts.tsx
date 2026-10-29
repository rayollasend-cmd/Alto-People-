import type { ExecPeople } from '@alto-people/shared';
import { ChartFrame } from '@/components/ui/ChartFrame';
import { StackedBarChart, TrendLineChart, PALETTE } from '@/components/ui/charts';
import { fmtDateOnly } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import '@/lib/i18n/en/execPortal';
import { FewPoints } from './FewPoints';
import { MIN_CHART_POINTS, mean, pointsIn } from './peopleMath';

/**
 * The workforce over thirteen weeks: how many are working, who joined and
 * who left, how much of the paid time ran into overtime, and how long
 * people have stayed. Each chart answers one question; with fewer than
 * four weeks behind it a chart is the latest number and a sentence.
 */

type Weeks = ExecPeople['weeks'];
const weekLabel = (start: string) => fmtDateOnly(start, { year: 'auto' });
const count = (n: number) => Math.round(n).toLocaleString('en-US');
const pct = (n: number) => `${n.toFixed(1)}%`;

export function HeadcountTrend({ weeks }: { weeks: Weeks }) {
  const { t } = useI18n();
  const title = t('execPortal.people.headcountTitle');
  const rows = weeks.map((w) => ({ week: w.start, label: weekLabel(w.start), active: w.active }));
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (pointsIn(rows.map((r) => r.active)) < MIN_CHART_POINTS || !first || !last) {
    return <FewPoints title={title} value={last ? count(last.active) : '—'} sentence={t('execPortal.people.fewWeeks')} testId="exec-headcount-few" />;
  }
  const high = Math.max(...rows.map((r) => r.active));
  const summary = t('execPortal.people.headcountSummary', { from: count(first.active), to: count(last.active), weeks: rows.length, high: count(high) });
  return (
    <ChartFrame
      title={title}
      description={t('execPortal.people.headcountDesc')}
      summary={summary}
      columns={[
        { key: 'label', label: t('execPortal.people.colWeekOf') },
        { key: 'active', label: t('execPortal.people.colWorking'), numeric: true, format: (v) => count(Number(v)) },
      ]}
      rows={rows}
      csvName="workforce-working-by-week"
      height={220}
    >
      <TrendLineChart data={rows} x="week" xDates="week" series={[{ key: 'active', name: t('execPortal.people.colWorking'), area: true }]} format={(v) => count(v)} height={220} />
    </ChartFrame>
  );
}

export function HiresSeparations({ weeks }: { weeks: Weeks }) {
  const { t } = useI18n();
  const title = t('execPortal.people.hiresTitle');
  const rows = weeks.map((w) => ({ week: w.start, label: weekLabel(w.start), hires: w.hires, separations: w.separations }));
  const hires = rows.reduce((n, r) => n + r.hires, 0);
  const seps = rows.reduce((n, r) => n + r.separations, 0);
  const summary = t('execPortal.people.hiresSummary', { hires, separations: seps, weeks: rows.length, net: hires === seps ? '0' : `${hires > seps ? '+' : '−'}${Math.abs(hires - seps)}` });
  if (rows.length < MIN_CHART_POINTS) {
    return <FewPoints title={title} value={`${hires} / ${seps}`} sentence={summary} testId="exec-hires-few" />;
  }
  return (
    <ChartFrame
      title={title}
      description={t('execPortal.people.hiresDesc')}
      summary={summary}
      columns={[
        { key: 'label', label: t('execPortal.people.colWeekOf') },
        { key: 'hires', label: t('execPortal.people.colHires'), numeric: true },
        { key: 'separations', label: t('execPortal.people.colSeparations'), numeric: true },
      ]}
      rows={rows}
      csvName="workforce-hires-and-separations"
      height={220}
      empty={<p className="text-sm text-ink-muted">{t('execPortal.people.hiresNone', { weeks: rows.length })}</p>}
    >
      <StackedBarChart
        data={rows}
        x="week"
        xDates="week"
        stacked={false}
        series={[
          { key: 'hires', name: t('execPortal.people.colHires'), color: PALETTE.series[1] },
          { key: 'separations', name: t('execPortal.people.colSeparations'), color: PALETTE.other },
        ]}
        format={(v) => count(v)}
        height={220}
      />
    </ChartFrame>
  );
}

export function OvertimeTrend({ weeks }: { weeks: Weeks }) {
  const { t } = useI18n();
  const title = t('execPortal.people.otTitle');
  const rows = weeks.map((w) => ({ week: w.start, label: weekLabel(w.start), otPct: w.otPct, otHours: Math.round(w.otHours), hours: Math.round(w.hours) }));
  const known = rows.filter((r) => r.otPct !== null);
  const last = known[known.length - 1];
  const avg = mean(rows.map((r) => r.otPct));
  if (known.length < MIN_CHART_POINTS || !last || avg === null) {
    return <FewPoints title={title} value={last ? pct(last.otPct!) : '—'} sentence={t('execPortal.people.fewWeeks')} testId="exec-ot-few" />;
  }
  const summary = t('execPortal.people.otSummary', { last: pct(last.otPct!), avg: pct(avg), weeks: rows.length });
  return (
    <ChartFrame
      title={title}
      description={t('execPortal.people.otDesc')}
      summary={summary}
      columns={[
        { key: 'label', label: t('execPortal.people.colWeekOf') },
        { key: 'otPct', label: t('execPortal.people.colOtShare'), numeric: true, format: (v) => (v === null || v === undefined ? '—' : pct(Number(v))) },
        { key: 'otHours', label: t('execPortal.people.colOtHours'), numeric: true, format: (v) => count(Number(v)) },
        { key: 'hours', label: t('execPortal.people.colPaidHours'), numeric: true, format: (v) => count(Number(v)) },
      ]}
      rows={rows}
      csvName="workforce-overtime-share"
      height={220}
    >
      <TrendLineChart data={rows} x="week" xDates="week" series={[{ key: 'otPct', name: t('execPortal.people.colOtShare') }]} format={(v) => `${v.toFixed(1)}%`} height={220} />
    </ChartFrame>
  );
}

export function TenureBands({ tenure }: { tenure: ExecPeople['tenure'] }) {
  const { t } = useI18n();
  const total = tenure.reduce((n, b) => n + b.count, 0);
  const top = tenure.reduce<ExecPeople['tenure'][number] | null>((best, b) => (best === null || b.count > best.count ? b : best), null);
  const summary =
    total > 0 && top
      ? t('execPortal.people.tenureSummary', { band: top.band, count: top.count, pct: Math.round((top.count / total) * 100) })
      : t('execPortal.people.tenureNone');
  return (
    <ChartFrame
      title={t('execPortal.people.tenureTitle')}
      description={t('execPortal.people.tenureDesc')}
      summary={summary}
      columns={[
        { key: 'band', label: t('execPortal.people.colTenure') },
        { key: 'count', label: t('execPortal.people.colPeople'), numeric: true },
      ]}
      rows={tenure}
      csvName="workforce-tenure"
      height={Math.max(160, tenure.length * 34 + 24)}
    >
      <StackedBarChart data={tenure} x="band" layout="horizontal" series={[{ key: 'count', name: t('execPortal.people.colPeople') }]} format={(v) => count(v)} height={Math.max(160, tenure.length * 34 + 24)} />
    </ChartFrame>
  );
}
