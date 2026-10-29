import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ClientPerformanceStatement } from '@alto-people/shared';
import { BarChart3 } from '@/components/ui/icons';
import { useAuth, useTerm } from '@/lib/auth';
import { getClientPerformance } from '@/lib/clientsApi';
import { fmtDate, fmtMoney } from '@/lib/format';
import { storeTrends } from '@/lib/schedulingApi';
import { cn } from '@/lib/cn';
import { Card, CardContent } from '@/components/ui/Card';
import { ChartFrame } from '@/components/ui/ChartFrame';
import { LegendKey, PALETTE, StackedBarChart, TrendLineChart } from '@/components/ui/charts';
import { lazyPlot } from '@/components/ui/charts/lazyPlot';
import { Sparkline } from '@/components/ui/charts/Sparkline';
import { EmptyState } from '@/components/ui/EmptyState';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * How a client is doing, on its record's Performance tab (Clients rebuild,
 * 2026-10-22): the weeks, the statements, NPS and margin by site. Each
 * piece shows only to the people who can read its numbers — statements
 * (process:payroll or view:executive, decided by the API), NPS (executive,
 * marketing), labor margin (scheduling, executive, payroll).
 */

/** The statements chart's drawing (recharts) loads with the chart, not the page (lazyPlot). */
const StatementsPlot = lazyPlot(() => import('./ClientStatements.plot').then((m) => ({ default: m.StatementsPlot })));

export interface StoreTrend {
  clientId: string;
  locationId: string;
  locationName: string;
  clientName: string;
  weeks: Array<{ start: string; hours: number; marginPerHour: number | null }>;
  avgMarginPerHour: number | null;
  hours4w: number;
  /** Share of the time priced at org standard rates — no rate card (or pay rate) behind it. */
  standardShare?: number;
}

const perHour = (v: number | null) => (v === null ? '—' : `${v < 0 ? '−' : ''}${fmtMoney(Math.abs(v))}/h`);

/** Hours-weighted share of a client's time priced at standard rates. */
export function standardShareOf(stores: StoreTrend[]): number {
  const hours = stores.reduce((s, x) => s + x.hours4w, 0);
  if (hours <= 0) return 0;
  return stores.reduce((s, x) => s + (x.standardShare ?? 0) * x.hours4w, 0) / hours;
}

/** How the margin was priced, in a few words — honest when the rate cards don't cover it. */
export function marginBasis(share: number): string {
  if (share >= 0.5) return 'At standard rates — add rate cards for this client’s roles to see its real margin';
  if (share > 0.05) return `Bill less pay, per hour · ${Math.round(share * 100)}% at standard rates`;
  return 'Bill less pay, per hour worked, from the rate cards';
}

/** Week-by-week totals across a set of locations: hours summed, margin per hour weighted by hours. */
export function rollUpWeeks(stores: StoreTrend[]): Array<{ start: string; hours: number; marginPerHour: number | null }> {
  const byWeek = new Map<string, { hours: number; marginHours: number; margin: number }>();
  for (const s of stores) {
    for (const w of s.weeks) {
      const b = byWeek.get(w.start) ?? { hours: 0, marginHours: 0, margin: 0 };
      b.hours += w.hours;
      if (w.marginPerHour !== null) {
        b.marginHours += w.hours;
        b.margin += w.marginPerHour * w.hours;
      }
      byWeek.set(w.start, b);
    }
  }
  return [...byWeek.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([start, b]) => ({ start, hours: Math.round(b.hours * 10) / 10, marginPerHour: b.marginHours > 0 ? Math.round((b.margin / b.marginHours) * 100) / 100 : null }));
}

/* ----- The Performance tab ------------------------------------------------ */

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** "Oct 4" for a calendar day, read as the day it names (never shifted by the viewer's zone). */
export const shortDay = (ymd: string) => fmtDate(ymd.slice(0, 10)).replace(/,\s*\d{4}$/, '');
const longDay = (ymd: string) => fmtDate(ymd.slice(0, 10));
const pctText = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v * 10) / 10}%`);
const hoursText = (v: number) => `${Math.round(v).toLocaleString('en-US')}h`;

const STATE_LABEL: Record<ClientPerformanceStatement['state'], string> = { paid: 'Paid', waiting: 'Waiting on payment', draft: 'Draft' };
/** Paid, waiting (not yet due), late (past due) or a draft — states, so the state colours. */
type BarState = 'paid' | 'waiting' | 'late' | 'draft';
const barState = (s: Pick<ClientPerformanceStatement, 'state' | 'daysPastDue'>): BarState => (s.state === 'waiting' && (s.daysPastDue ?? 0) > 0 ? 'late' : s.state);
const BAR_COLOR: Record<BarState, string> = { paid: PALETTE.good, waiting: PALETTE.warn, late: PALETTE.bad, draft: PALETTE.other };
const statementColor = (s: StatementRow) => BAR_COLOR[barState(s)];

/** A statement as the chart and its table read it. */
const statementRow = (s: ClientPerformanceStatement) => ({
  ...s,
  label: shortDay(s.periodEnd),
  name: s.number !== null ? `#${s.number}` : 'Draft',
  status: s.state === 'waiting' && s.daysPastDue ? `Waiting · ${s.daysPastDue} day${s.daysPastDue === 1 ? '' : 's'} late` : STATE_LABEL[s.state],
});
export type StatementRow = ReturnType<typeof statementRow>;

/** Whether the person can see the Performance tab: anyone who can open the client (the money and NPS parts check their own access). */
export function useCanSeeClientPerformance(): boolean {
  const { can } = useAuth();
  return can('view:clients');
}

/**
 * The Performance tab, full width: the last 12 complete weeks (hours with
 * the overtime among them, fill rate, overtime %), every recent statement
 * by the day its period ends and whether it is paid, waiting or a draft
 * (people who read statements), NPS wave by wave (executives and
 * marketing), and margin per hour by site (scheduling, executives,
 * payroll). One request for the weeks and statements
 * (GET /clients/:id/performance); the same definitions as the clients list.
 */
export function ClientPerformance({ clientId }: { clientId: string }) {
  const term = useTerm();
  const { can } = useAuth();
  const canLabor = can('manage:scheduling') || can('view:executive') || can('process:payroll');
  const storeWord = term('label.store').toLowerCase();
  const perf = useQuery({ queryKey: ['clients', clientId, 'performance'], queryFn: () => getClientPerformance(clientId), retry: false, staleTime: 60_000 });
  const labor = useQuery({ queryKey: ['clients', clientId, 'storeTrends'], queryFn: () => storeTrends<StoreTrend>(clientId), enabled: canLabor, retry: false, staleTime: 5 * 60_000 });

  const weeks = useMemo(
    () =>
      (perf.data?.weeks ?? []).map((w) => ({
        week: shortDay(w.start),
        start: w.start,
        regular: Math.round((w.hours - w.overtimeHours) * 10) / 10,
        overtime: Math.round(w.overtimeHours * 10) / 10,
        hours: w.hours,
        overtimePct: w.overtimePct,
        shifts: w.shifts,
        filled: w.filled,
        fillRatePct: w.fillRatePct,
      })),
    [perf.data],
  );
  const statements = useMemo(() => (perf.data?.statements ?? []).map(statementRow), [perf.data]);
  const stores = useMemo(() => labor.data?.stores ?? [], [labor.data]);
  const marginWeeks = useMemo(() => rollUpWeeks(stores).map((w) => ({ week: shortDay(w.start), start: w.start, margin: w.marginPerHour })), [stores]);
  const standardShare = standardShareOf(stores);

  if (perf.isPending) return <Skeleton className="h-72" />;
  if (perf.isError || !perf.data) {
    return <EmptyState icon={BarChart3} title="The numbers could not be loaded" description="Try again in a moment." />;
  }
  const p = perf.data;
  const nps = (p.nps ?? []).filter((x) => x.nps !== null);
  const totalHours = weeks.reduce((n, w) => n + w.hours, 0);
  const totalOt = weeks.reduce((n, w) => n + w.overtime, 0);
  const totalShifts = weeks.reduce((n, w) => n + w.shifts, 0);
  const totalFilled = weeks.reduce((n, w) => n + w.filled, 0);
  const weekWord = `${p.weeks.length} full weeks (${WEEKDAYS[p.weekStartsOn] ?? 'Saturday'} to ${WEEKDAYS[(p.weekStartsOn + 6) % 7] ?? 'Friday'})`;
  // The margin line's weeks are the client's own too (store-trends answers with them, LEAD-23):
  // name them, rather than "the company week" beside an hours chart on another.
  const marginWeekStart = labor.data?.weekStartsOn ?? p.weekStartsOn;
  const marginWeekWord = `the client's week (${WEEKDAYS[marginWeekStart] ?? 'Saturday'} to ${WEEKDAYS[(marginWeekStart + 6) % 7] ?? 'Friday'})`;
  const billedTotal = statements.reduce((n, s) => n + s.amount, 0);
  const waitingTotal = statements.filter((s) => s.state === 'waiting').reduce((n, s) => n + s.open, 0);

  return (
    <div className="space-y-4">
      <ChartFrame
        title="Hours, week by week"
        description={`Hours worked here over the last ${weekWord}. Overtime is what the labor rules make overtime — the split pay uses, across every client the person worked for that week.`}
        summary={totalHours > 0 ? `${Math.round(totalHours).toLocaleString('en-US')} hours over ${p.weeks.length} weeks, ${Math.round(totalOt).toLocaleString('en-US')} of them overtime. The last week ran ${hoursText(weeks[weeks.length - 1]!.hours)}.` : `No hours worked here in the last ${p.weeks.length} weeks.`}
        csvName="client-hours"
        rows={totalHours > 0 ? weeks : []}
        columns={[
          { key: 'start', label: 'Week of', format: (v) => longDay(String(v)) },
          { key: 'hours', label: 'Hours', numeric: true, format: (v) => (v as number).toLocaleString('en-US') },
          { key: 'overtime', label: 'Overtime hours', numeric: true },
          { key: 'overtimePct', label: 'Overtime %', numeric: true, format: (v) => pctText(v as number | null) },
        ]}
        empty={<EmptyState icon={BarChart3} title="No hours yet" description={`Nobody has clocked hours here in the last ${p.weeks.length} weeks.`} />}
      >
        <StackedBarChart
          data={weeks}
          x="week"
          series={[
            { key: 'regular', name: 'Regular hours', color: PALETTE.series[0] },
            { key: 'overtime', name: 'Overtime', color: PALETTE.series[1] },
          ]}
          format={(v) => Math.round(v).toLocaleString('en-US')}
          yLabel="Hours"
          heading={(x) => `Week of ${x}`}
        />
      </ChartFrame>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartFrame
          title="Fill rate, week by week"
          description="Of the published shifts that started each week, the share that had someone assigned. The dashed line is 95%."
          summary={totalShifts > 0 ? `${totalFilled.toLocaleString('en-US')} of ${totalShifts.toLocaleString('en-US')} shifts filled over ${p.weeks.length} weeks (${pctText((totalFilled / totalShifts) * 100)}).` : `No shifts were published here in the last ${p.weeks.length} weeks.`}
          csvName="client-fill-rate"
          height={220}
          rows={totalShifts > 0 ? weeks : []}
          columns={[
            { key: 'start', label: 'Week of', format: (v) => longDay(String(v)) },
            { key: 'shifts', label: 'Shifts', numeric: true },
            { key: 'filled', label: 'Filled', numeric: true },
            { key: 'fillRatePct', label: 'Fill rate', numeric: true, format: (v) => pctText(v as number | null) },
          ]}
          empty={<EmptyState icon={BarChart3} title="No shifts to fill" description={`No shifts were published here in the last ${p.weeks.length} weeks.`} />}
        >
          <StackedBarChart data={weeks} x="week" series={[{ key: 'fillRatePct', name: 'Fill rate', color: PALETTE.series[2] }]} format={(v) => `${Math.round(v)}%`} target={{ value: 95, label: '95%' }} heading={(x) => `Week of ${x}`} />
        </ChartFrame>
        <ChartFrame
          title="Overtime, week by week"
          description="Overtime and double-time hours as a share of the hours worked here each week."
          summary={totalHours > 0 ? `Overtime was ${pctText((totalOt / totalHours) * 100)} of the hours over ${p.weeks.length} weeks; last week ${pctText(weeks[weeks.length - 1]!.overtimePct)}.` : `No hours worked here in the last ${p.weeks.length} weeks.`}
          csvName="client-overtime"
          height={220}
          rows={totalHours > 0 ? weeks : []}
          columns={[
            { key: 'start', label: 'Week of', format: (v) => longDay(String(v)) },
            { key: 'hours', label: 'Hours', numeric: true },
            { key: 'overtime', label: 'Overtime hours', numeric: true },
            { key: 'overtimePct', label: 'Overtime %', numeric: true, format: (v) => pctText(v as number | null) },
          ]}
          empty={<EmptyState icon={BarChart3} title="No hours yet" description="Overtime shows once people work here." />}
        >
          <StackedBarChart data={weeks} x="week" series={[{ key: 'overtimePct', name: 'Overtime', color: PALETTE.series[1] }]} format={(v) => `${Math.round(v * 10) / 10}%`} heading={(x) => `Week of ${x}`} />
        </ChartFrame>
      </div>

      {p.canSeeMoney && (
        <ChartFrame
          title="Billed by statement"
          description="Each statement on the day its period ends: paid, waiting on payment, past due, or still a draft."
          summary={statements.length ? `${statements.length} statement${statements.length === 1 ? '' : 's'}, ${fmtMoney(billedTotal)} billed in all${waitingTotal > 0 ? `; ${fmtMoney(waitingTotal)} still waiting on payment` : ''}.` : 'No statements yet.'}
          csvName="client-statements"
          rows={statements}
          columns={[
            { key: 'name', label: 'Statement' },
            { key: 'periodEnd', label: 'Period ending', format: (v) => longDay(String(v)) },
            { key: 'hours', label: 'Hours', numeric: true },
            { key: 'amount', label: 'Billed', numeric: true, format: (v) => fmtMoney(v as number) },
            { key: 'status', label: 'Status' },
          ]}
          empty={<EmptyState icon={BarChart3} title="No statements yet" description="Statements show here once one is drafted for this client." />}
        >
          <div className="flex h-full w-full flex-col">
            <div className="min-h-0 flex-1">
              <StatementsPlot statements={statements} colorOf={statementColor} longDay={longDay} />
            </div>
            <div className="mt-1">
              <LegendKey
                items={[
                  { name: 'Paid', color: BAR_COLOR.paid },
                  { name: 'Waiting, not yet due', color: BAR_COLOR.waiting },
                  { name: 'Past due', color: BAR_COLOR.late },
                  { name: 'Draft', color: BAR_COLOR.draft },
                ]}
              />
            </div>
          </div>
        </ChartFrame>
      )}

      {(nps.length > 0 || (canLabor && marginWeeks.some((w) => w.margin !== null))) && (
        <div className="grid gap-4 lg:grid-cols-2">
          {nps.length > 0 && (
            <ChartFrame
              title="NPS by quarter"
              description="Their managers’ answer to “how likely are you to recommend us?”, −100 to +100."
              summary={`NPS over ${nps.length} quarter${nps.length === 1 ? '' : 's'}, latest ${nps[nps.length - 1]!.nps! > 0 ? '+' : ''}${nps[nps.length - 1]!.nps}.`}
              csvName="client-nps"
              height={220}
              rows={p.nps ?? []}
              columns={[
                { key: 'quarter', label: 'Quarter' },
                { key: 'nps', label: 'NPS', numeric: true },
                { key: 'responses', label: 'Answers', numeric: true },
              ]}
            >
              <TrendLineChart data={p.nps ?? []} x="quarter" series={[{ key: 'nps', name: 'NPS' }]} zeroBased={false} format={(v) => `${v > 0 ? '+' : ''}${Math.round(v)}`} />
            </ChartFrame>
          )}
          {canLabor && marginWeeks.some((w) => w.margin !== null) && (
            <ChartFrame
              title="Margin per hour, week by week"
              description={`Bill less pay, per hour worked, on ${marginWeekWord}. ${marginBasis(standardShare)}.${labor.data?.truncated ? ' Too many punches to count them all — the oldest week may read low.' : ''}`}
              summary={`Margin per hour over ${marginWeeks.length} weeks; the last week ran ${perHour(marginWeeks[marginWeeks.length - 1]!.margin)}.`}
              csvName="client-margin"
              height={220}
              rows={marginWeeks}
              columns={[
                { key: 'start', label: 'Week of', format: (v) => longDay(String(v)) },
                { key: 'margin', label: 'Margin per hour', numeric: true, format: (v) => perHour(v as number | null) },
              ]}
            >
              {/* From zero: cut to $3.60–$4.40, a few cents' move drew as a cliff (LEAD-22). */}
              <TrendLineChart data={marginWeeks} x="week" series={[{ key: 'margin', name: 'Margin per hour', color: PALETTE.good }]} format={(v) => `$${Math.round(v * 100) / 100}`} heading={(x) => `Week of ${x}`} />
            </ChartFrame>
          )}
        </div>
      )}

      {canLabor && stores.length > 1 && (
        <Card>
          <CardContent className="space-y-3 p-4 md:p-5">
            <SectionTitle as="h3" title={`By ${storeWord}`} description="Hours over the last four weeks, and the average margin per hour." />
            <ul className="divide-y divide-line">
              {[...stores]
                .sort((a, b) => b.hours4w - a.hours4w)
                .map((s) => (
                  <li key={s.locationId} className="flex items-center gap-3 py-2 text-sm">
                    <span className="min-w-0 flex-1 break-words text-ink">{s.locationName}</span>
                    <Sparkline series={s.weeks.map((w) => w.hours)} tone="primary" label={`${s.locationName} hours by week`} />
                    <span className="w-20 shrink-0 text-right tabular-nums text-ink-muted">{Math.round(s.hours4w).toLocaleString('en-US')} h</span>
                    <span className={cn('w-24 shrink-0 text-right tabular-nums', s.avgMarginPerHour === null ? 'text-ink-muted' : s.avgMarginPerHour >= 0 ? 'text-success' : 'text-alert')}>
                      {perHour(s.avgMarginPerHour)}
                    </span>
                  </li>
                ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
