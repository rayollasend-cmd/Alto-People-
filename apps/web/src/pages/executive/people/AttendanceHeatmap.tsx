import type { ExecPeople } from '@alto-people/shared';
import { ChartFrame } from '@/components/ui/ChartFrame';
import { Heatmap } from '@/components/ui/charts';
import { fmtDateOnly } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { useMinWidth } from '@/lib/useViewport';
import '@/lib/i18n/en/execPortal';
import { attendanceGrid } from './peopleMath';

/**
 * Where attendance slips: every site down the side, the last eight weeks
 * across, each cell the unexcused late arrivals, call-outs and no-call
 * no-shows per hundred shifts — one hue, darker is worse, a blank cell a
 * week the site ran no shifts (not a clean one), a zero left unshaded.
 * The table view and the CSV carry the same figures with the raw counts.
 */
export function AttendanceHeatmap({ attendance }: { attendance: ExecPeople['attendance'] }) {
  const { t } = useI18n();
  const { values, events } = attendanceGrid(attendance);
  // A phone shows the latest five weeks so the grid fits its width; the
  // table view and the CSV keep all eight.
  const wide = useMinWidth(640);
  const keep = wide ? attendance.weeks.length : Math.min(5, attendance.weeks.length);
  const from = attendance.weeks.length - keep;
  const columns = attendance.weeks.map((w) => ({ key: w, label: t('execPortal.people.weekOf', { date: fmtDateOnly(w, { year: 'auto' }) }), short: fmtDateOnly(w, { year: false }) }));
  const rows = attendance.sites.map((s) => ({ key: s.id, label: s.name }));
  const fmt = (v: number) => v.toFixed(1);
  // The worst cell, for the sentence a screen reader hears.
  let worst: { site: string; week: string; v: number } | null = null;
  values.forEach((row, ri) =>
    row.forEach((v, ci) => {
      if (v !== null && (worst === null || v > worst.v)) worst = { site: rows[ri]!.label, week: columns[ci]!.short, v };
    }),
  );
  const w = worst as { site: string; week: string; v: number } | null;
  const summary = w && w.v > 0 ? t('execPortal.people.attendanceSummary', { site: w.site, week: w.week, value: fmt(w.v) }) : t('execPortal.people.attendanceClean');
  const tableRows = rows.map((r, ri) => ({
    site: r.label,
    ...Object.fromEntries(attendance.weeks.map((wk, ci) => [wk, values[ri]![ci]])),
  }));
  const height = rows.length * 30 + 76;
  return (
    <ChartFrame
      title={t('execPortal.people.attendanceTitle')}
      description={t('execPortal.people.attendanceDesc')}
      summary={summary}
      columns={[
        { key: 'site', label: t('execPortal.people.colSite') },
        ...columns.map((c) => ({ key: c.key, label: c.short, numeric: true, format: (v: unknown) => (v === null || v === undefined ? '—' : fmt(Number(v))) })),
      ]}
      rows={tableRows}
      csvName="attendance-per-100-shifts"
      height={height}
      zerosMeaningful
      empty={<p className="text-sm text-ink-muted">{t('execPortal.people.attendanceEmpty')}</p>}
    >
      <Heatmap
        caption={t('execPortal.people.attendanceTitle')}
        rows={rows}
        columns={columns.slice(from)}
        values={values.map((r) => r.slice(from))}
        tone="bad"
        format={fmt}
        showValues
        legend={{ low: t('execPortal.people.legendLow'), high: t('execPortal.people.legendHigh') }}
        cellLabel={(r, c, v) => {
          const ri = rows.findIndex((x) => x.key === r.key);
          const ci = columns.findIndex((x) => x.key === c.key);
          const n = events[ri]?.[ci] ?? 0;
          return v === null ? t('execPortal.people.cellNoShifts', { site: r.label, week: c.label }) : t('execPortal.people.cell', { site: r.label, week: c.label, value: fmt(v), count: n });
        }}
      />
    </ChartFrame>
  );
}
