import { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock, Thermometer } from 'lucide-react';
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { cn } from '@/lib/cn';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { FilterChip } from '@/components/ui/FilterBar';
import { Skeleton } from '@/components/ui/Skeleton';
import type { getOpsScorecard } from '@/lib/opsApi';
import { fmtShortDayKey } from './opsTime';

type Scorecard = Awaited<ReturnType<typeof getOpsScorecard>>;
type Row = Scorecard['rows'][number];

/**
 * Standards — the four-week record, as a scorecard rather than a strip of
 * numbers.
 *
 * The old header read "7 shifts · 8 temp checks · 2/60 handovers carried",
 * which was wrong in three ways at once: it counted the CLIENT where the
 * store belongs, it put a raw "2 of 60" beside the word "carried" so a
 * healthy disposition read as a 3% pass rate, and it offered no way to see
 * which store or shift the number came from.
 *
 * What replaces it: four figures with their own meaning, the handover
 * disposition drawn as what it is (four outcomes, one of which is a
 * failure), and a table that can be read by store or by shift.
 */

const PERIOD_LABEL: Record<string, string> = {
  MORNING: 'Morning',
  EVENING: 'Evening',
  CLOSING: 'Closing',
  OVERNIGHT: 'Overnight',
};

const band = (pct: number | null) =>
  pct == null ? 'none' : pct >= 95 ? 'good' : pct >= 85 ? 'warn' : 'bad';
const BAND_BAR: Record<string, string> = {
  good: 'bg-success',
  warn: 'bg-warning',
  bad: 'bg-alert',
  none: 'bg-navy-secondary',
};
const BAND_TEXT: Record<string, string> = {
  good: 'text-success',
  warn: 'text-warning',
  bad: 'text-alert',
  none: 'text-silver/50',
};

/** One number, its label, and the one clause that says what it means. */
function Figure({
  label,
  value,
  sub,
  tone,
  icon: Icon,
}: {
  label: string;
  value: string;
  sub: string;
  tone?: string;
  icon: typeof Clock;
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 text-2xs uppercase tracking-wider text-silver/60">
        <Icon className="h-3 w-3 shrink-0 text-gold" aria-hidden="true" />
        <span className="truncate">{label}</span>
      </div>
      <div className={cn('mt-1 text-2xl font-semibold tabular-nums leading-none', tone ?? 'text-white')}>
        {value}
      </div>
      <div className="mt-1 text-2xs text-silver/60">{sub}</div>
    </div>
  );
}

/** The handover disposition: four outcomes, one of which is a failure. */
function HandoverBar({ totals }: { totals: Scorecard['totals'] }) {
  // The validated chart token for the neutral "it moved forward" outcome,
  // and the reserved status tokens for the two that are judgements.
  const segs = [
    { key: 'Carried', value: totals.handoverCarried, color: 'rgb(var(--color-chart-1))' },
    { key: 'Reviewed', value: totals.handoverReviewed, color: 'rgb(var(--color-success))' },
    { key: 'Dismissed', value: totals.handoverDismissed, color: 'rgb(var(--color-steel))' },
    { key: 'Undecided', value: totals.handoverPending, color: 'rgb(var(--color-alert))' },
  ].filter((s) => s.value > 0);
  const total = totals.handoverCreated;
  if (total === 0) {
    return (
      <p className="text-xs text-silver/60">
        No handover items were raised in this window — nothing was passed between shifts.
      </p>
    );
  }
  return (
    <div>
      <div
        className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full"
        role="img"
        aria-label={segs.map((s) => `${s.key} ${s.value}`).join(', ')}
      >
        {segs.map((s) => (
          <div
            key={s.key}
            className="h-full first:rounded-l-full last:rounded-r-full"
            style={{ width: `${(s.value / total) * 100}%`, background: s.color }}
          />
        ))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {segs.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5 text-2xs text-silver/80">
            <span
              className="h-2 w-2 shrink-0 rounded-sm"
              style={{ background: s.color }}
              aria-hidden="true"
            />
            {s.key} <span className="tabular-nums text-white">{s.value}</span>
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-2xs text-silver/50">
        {totals.handoverPending > 0
          ? `${totals.handoverPending} item${totals.handoverPending === 1 ? '' : 's'} left one shift and ${
              totals.handoverPending === 1 ? 'was' : 'were'
            } never decided by the next.`
          : 'Every item raised was decided by the shift that received it.'}
      </p>
    </div>
  );
}

/**
 * Store × shift, as a grid. The question this board exists to answer —
 * "last week's overnight at Destin" — is a cell, so draw the cells.
 */
function CompletionGrid({ rows, onPick }: { rows: Row[]; onPick: (r: Row) => void }) {
  const periods = ['MORNING', 'EVENING', 'CLOSING', 'OVERNIGHT'] as const;
  const stores = useMemo(() => [...new Set(rows.map((r) => r.storeName))].sort(), [rows]);
  // One cell per store and period: the weighted completion of every
  // department that ran it.
  const cell = (store: string, period: string) => {
    const hit = rows.filter((r) => r.storeName === store && r.period === period);
    if (hit.length === 0) return null;
    const shifts = hit.reduce((n, r) => n + r.shifts, 0);
    const weighted = hit.reduce((n, r) => n + (r.sopPct ?? 0) * r.shifts, 0);
    return {
      pct: shifts > 0 ? Math.round(weighted / shifts) : null,
      shifts,
      alerts: hit.reduce((n, r) => n + r.tempAlerts, 0),
      incomplete: hit.reduce((n, r) => n + r.incomplete, 0),
      row: hit[0],
    };
  };
  if (stores.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[420px] border-separate border-spacing-1 text-left">
        <caption className="sr-only">
          SOP completion by store and shift over the scorecard window
        </caption>
        <thead>
          <tr>
            <th scope="col" className="w-40 pb-1 text-2xs uppercase tracking-wider text-silver/60">
              Store
            </th>
            {periods.map((p) => (
              <th
                key={p}
                scope="col"
                className="pb-1 text-center text-2xs uppercase tracking-wider text-silver/60"
              >
                {PERIOD_LABEL[p]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {stores.map((store) => (
            <tr key={store}>
              <th
                scope="row"
                className="max-w-[10rem] truncate pr-2 text-xs font-normal text-white"
                title={store}
              >
                {store}
              </th>
              {periods.map((p) => {
                const c = cell(store, p);
                if (!c) {
                  return (
                    <td key={p} className="p-0">
                      <div className="grid h-9 place-items-center rounded border border-dashed border-navy-secondary/60 text-2xs text-silver/30">
                        —
                      </div>
                    </td>
                  );
                }
                const b = band(c.pct);
                return (
                  <td key={p} className="p-0">
                    <button
                      type="button"
                      onClick={() => onPick(c.row)}
                      // The cell reads "72%", which on its own tells a
                      // screen reader nothing about which cell it is.
                      aria-label={`${store} · ${PERIOD_LABEL[p]} — ${
                        c.pct == null ? 'no measured items' : `${c.pct}% complete`
                      } over ${c.shifts} shift${c.shifts === 1 ? '' : 's'}${
                        c.alerts ? `, ${c.alerts} temp alerts` : ''
                      }${c.incomplete ? `, ${c.incomplete} submitted incomplete` : ''}`}
                      title={`${store} · ${PERIOD_LABEL[p]} — ${c.pct ?? '—'}% over ${c.shifts} shifts${
                        c.alerts ? `, ${c.alerts} temp alerts` : ''
                      }${c.incomplete ? `, ${c.incomplete} incomplete` : ''}`}
                      className={cn(
                        'relative grid h-9 w-full place-items-center rounded text-xs font-medium tabular-nums transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
                        b === 'good' && 'bg-success/25 text-success hover:bg-success/35',
                        b === 'warn' && 'bg-warning/25 text-warning hover:bg-warning/35',
                        b === 'bad' && 'bg-alert/25 text-alert hover:bg-alert/35',
                        b === 'none' && 'bg-navy-secondary/50 text-silver/60',
                      )}
                    >
                      {c.pct == null ? '—' : `${c.pct}%`}
                      {(c.alerts > 0 || c.incomplete > 0) && (
                        <span
                          className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-alert"
                          aria-hidden="true"
                        />
                      )}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-2xs text-silver/50">
        Each cell is the weighted SOP completion for that store and shift. A red dot means the cell
        carried a temperature alert or an incomplete submission. Empty cells never ran.
      </p>
    </div>
  );
}

/**
 * Week by week: the standard, and the exceptions underneath it.
 *
 * One line for completion against the 95% bar, and one column per week
 * for the exceptions that produced it. On the same axis they answer the
 * question a single four-week average cannot: is this store getting
 * better or worse?
 */
function WeeklyStandards({ weekly }: { weekly: Scorecard['weekly'] }) {
  const data = weekly.map((w) => ({
    ...w,
    label: fmtShortDayKey(w.weekKey),
    exceptions: w.incomplete + w.tempAlerts,
  }));
  if (data.every((d) => d.shifts === 0)) return null;
  return (
    <div>
      <div className="mb-1 flex flex-wrap items-center gap-x-4 gap-y-1">
        <h3 className="text-2xs uppercase tracking-wider text-silver/60">Week by week</h3>
        {/* Two series, so a legend is not optional. */}
        <span className="flex items-center gap-1.5 text-2xs text-silver/70">
          <span
            className="h-0.5 w-4 rounded"
            style={{ background: 'rgb(var(--color-chart-1))' }}
            aria-hidden="true"
          />
          SOP completion
        </span>
        <span className="flex items-center gap-1.5 text-2xs text-silver/70">
          <span className="h-2 w-2 rounded-sm bg-alert" aria-hidden="true" />
          Exceptions
        </span>
      </div>
      <div className="h-40">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -22 }}>
            <CartesianGrid
              stroke="rgb(var(--color-navy-secondary))"
              vertical={false}
              strokeDasharray="0"
            />
            <XAxis
              dataKey="label"
              tick={{ fill: 'rgb(var(--color-silver) / 0.6)', fontSize: 10 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              yAxisId="pct"
              domain={[0, 100]}
              ticks={[0, 50, 100]}
              tick={{ fill: 'rgb(var(--color-silver) / 0.6)', fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              width={38}
              unit="%"
            />
            {/* Exceptions ride the same axis as a count scaled to it, so
                this stays one scale and not a dual-axis chart. */}
            <ReferenceLine
              yAxisId="pct"
              y={95}
              stroke="rgb(var(--color-silver) / 0.5)"
              strokeDasharray="4 4"
            />
            <ChartTooltip
              cursor={{ fill: 'rgb(var(--color-navy-secondary) / 0.4)' }}
              contentStyle={{
                background: 'rgb(var(--color-navy))',
                border: '1px solid rgb(var(--color-navy-secondary))',
                borderRadius: 8,
                fontSize: 11,
              }}
              labelFormatter={(v) => `Week of ${String(v)}`}
              formatter={(value, name) =>
                name === 'sopPct'
                  ? [`${String(value)}%`, 'SOP completion']
                  : [String(value), 'Exceptions (incomplete + temp alerts)']
              }
            />
            <Bar yAxisId="pct" dataKey="exceptions" maxBarSize={22} radius={[4, 4, 0, 0]}>
              {data.map((d) => (
                <Cell
                  key={d.weekKey}
                  fill={
                    d.exceptions > 0
                      ? 'rgb(var(--color-alert) / 0.55)'
                      : 'rgb(var(--color-navy-secondary))'
                  }
                />
              ))}
            </Bar>
            <Line
              yAxisId="pct"
              type="monotone"
              dataKey="sopPct"
              stroke="rgb(var(--color-chart-1))"
              strokeWidth={2}
              dot={{ r: 3, strokeWidth: 0, fill: 'rgb(var(--color-chart-1))' }}
              connectNulls
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-1 text-2xs text-silver/50">
        The dashed line is the 95% standard. Columns count exceptions — shifts submitted
        incomplete plus temperature alerts — on the same 0&ndash;100 scale.
      </p>
    </div>
  );
}

export function OpsStandards({
  scorecard,
  onPickStore,
}: {
  scorecard: Scorecard | null;
  /** Clicking a grid cell narrows the board to that store and shift. */
  onPickStore: (locationId: string | null, period: string) => void;
}) {
  const [view, setView] = useState<'grid' | 'rows'>('grid');

  if (!scorecard) return <Skeleton className="h-64" />;
  const t = scorecard.totals;
  if (t.shifts === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Standards — last {scorecard.weeks} weeks</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-silver">
            No shifts were submitted in this window under the current filters.
          </p>
        </CardContent>
      </Card>
    );
  }

  const sopDone = scorecard.rows.reduce((n, r) => n + (r.sopPct ?? 0) * r.shifts, 0);
  const sopShifts = scorecard.rows.reduce((n, r) => n + r.shifts, 0);
  const overall = sopShifts > 0 ? Math.round(sopDone / sopShifts) : null;
  const inRangePct =
    t.tempChecks > 0 ? Math.round(((t.tempChecks - t.tempOutOfRange) / t.tempChecks) * 100) : null;
  const incomplete = scorecard.rows.reduce((n, r) => n + r.incomplete, 0);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <CardTitle className="text-base">
            Standards
            <span className="ml-2 text-xs font-normal text-silver/60">
              last {scorecard.weeks} weeks
            </span>
          </CardTitle>
          <div className="flex gap-1" role="group" aria-label="How to read the scorecard">
            <FilterChip active={view === 'grid'} onClick={() => setView('grid')}>
              By store &amp; shift
            </FilterChip>
            <FilterChip active={view === 'rows'} onClick={() => setView('rows')}>
              Worst first
            </FilterChip>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Four figures, each meaning one thing. */}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Figure
            icon={CheckCircle2}
            label="SOP completion"
            value={overall == null ? '—' : `${overall}%`}
            sub={`across ${t.shifts.toLocaleString('en-US')} submitted shifts`}
            tone={BAND_TEXT[band(overall)]}
          />
          <Figure
            icon={Thermometer}
            label="Temps in range"
            value={inRangePct == null ? '—' : `${inRangePct}%`}
            sub={
              t.tempOutOfRange > 0
                ? `${t.tempOutOfRange} of ${t.tempChecks.toLocaleString('en-US')} out of band`
                : `${t.tempChecks.toLocaleString('en-US')} checks, all in band`
            }
            tone={t.tempOutOfRange > 0 ? 'text-alert' : 'text-success'}
          />
          <Figure
            icon={AlertTriangle}
            label="Closed incomplete"
            value={incomplete.toLocaleString('en-US')}
            sub={incomplete === 0 ? 'every shift finished its list' : 'each with a written reason'}
            tone={incomplete > 0 ? 'text-warning' : 'text-success'}
          />
          <Figure
            icon={Clock}
            label="Submitted on time"
            value={
              t.onTimeOf > 0 ? `${Math.round((t.onTime / t.onTimeOf) * 100)}%` : '—'
            }
            sub={
              t.onTimeOf > 0
                ? `${t.onTime} of ${t.onTimeOf} closed before the window ended`
                : 'no shifts carried a due time'
            }
            tone={
              t.onTimeOf === 0
                ? undefined
                : t.onTime === t.onTimeOf
                  ? 'text-success'
                  : 'text-warning'
            }
          />
        </div>

        <div className="border-t border-navy-secondary/60 pt-4">
          <WeeklyStandards weekly={scorecard.weekly} />
        </div>

        <div className="border-t border-navy-secondary/60 pt-4">
          <h3 className="mb-2 text-2xs uppercase tracking-wider text-silver/60">
            What one shift told the next
          </h3>
          <HandoverBar totals={t} />
        </div>

        <div className="border-t border-navy-secondary/60 pt-4">
          {view === 'grid' ? (
            <CompletionGrid
              rows={scorecard.rows}
              onPick={(r) => onPickStore(r.locationId, r.period)}
            />
          ) : (
            <ul className="space-y-2">
              {scorecard.rows.map((r) => {
                const b = band(r.sopPct);
                return (
                  <li key={`${r.locationId ?? r.clientName}|${r.period}|${r.department}`}>
                    <button
                      type="button"
                      onClick={() => onPickStore(r.locationId, r.period)}
                      className="flex w-full items-center gap-3 rounded px-1 py-1 text-left transition-colors hover:bg-navy-secondary/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
                    >
                      <span className="w-52 min-w-0 shrink-0">
                        {/* The building, not the chain. This row printed the
                            client's name, so four stores read as one. */}
                        <span className="block truncate text-sm text-white">{r.storeName}</span>
                        <span className="block truncate text-2xs text-silver/60">
                          {PERIOD_LABEL[r.period] ?? r.period} · {r.department}
                        </span>
                      </span>
                      <span className="h-2 flex-1 overflow-hidden rounded-full bg-navy-secondary">
                        <span
                          className={cn('block h-full rounded-full transition-all duration-700', BAND_BAR[b])}
                          style={{ width: `${r.sopPct ?? 0}%` }}
                        />
                      </span>
                      <span
                        className={cn(
                          'w-12 shrink-0 text-right text-sm tabular-nums',
                          BAND_TEXT[b],
                        )}
                      >
                        {r.sopPct == null ? '—' : `${r.sopPct}%`}
                      </span>
                      <span className="w-28 shrink-0 text-right text-2xs tabular-nums text-silver/60">
                        {r.shifts} shifts
                        {r.incomplete > 0 && (
                          <span className="ml-1 text-warning">· {r.incomplete} inc</span>
                        )}
                        {r.tempAlerts > 0 && (
                          <span className="ml-1 text-alert">· {r.tempAlerts} temp</span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <p className="text-2xs text-silver/50">
          Green is 95% and above, amber 85–94%, red below 85%. Percentages are weighted by the number
          of shifts, so a store that ran twenty shifts is not averaged against one that ran two.
        </p>
      </CardContent>
    </Card>
  );
}
