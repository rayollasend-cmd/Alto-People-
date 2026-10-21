import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { BarChart3 } from 'lucide-react';
import { useAuth, useTerm } from '@/lib/auth';
import { listClientStatements } from '@/lib/clientsApi';
import { fmtDate, fmtMoney, fmtMoneyCompact } from '@/lib/format';
import { getNpsResults } from '@/lib/npsApi';
import { storeTrends } from '@/lib/schedulingApi';
import { cn } from '@/lib/cn';
import { Card, CardContent } from '@/components/ui/Card';
import { ChartFrame } from '@/components/ui/ChartFrame';
import { PALETTE, TICK, TOOLTIP_LABEL_STYLE, TOOLTIP_STYLE } from '@/components/ui/charts/palette';
import { Sparkline } from '@/components/ui/charts/Sparkline';
import { EmptyState } from '@/components/ui/EmptyState';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * How a client is doing, on its record: hours and margin week by week for
 * each of its locations, its NPS wave by wave, and what each statement
 * billed. Each piece shows only to the people who can read its numbers —
 * labor margin (scheduling, executive, payroll), NPS (executive,
 * marketing), statements (payroll).
 */

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

const weekLabel = (ymd: string) => {
  const [, m, d] = ymd.slice(0, 10).split('-').map(Number);
  return `${m}/${d}`;
};
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

function useClientNumbers(clientId: string) {
  const { can } = useAuth();
  const canLabor = can('manage:scheduling') || can('view:executive') || can('process:payroll');
  const canNps = can('view:executive') || can('view:marketing');
  const canBill = can('process:payroll');
  const labor = useQuery({ queryKey: ['clients', clientId, 'storeTrends'], queryFn: () => storeTrends<StoreTrend>(clientId), enabled: canLabor, retry: false, staleTime: 5 * 60_000 });
  const nps = useQuery({ queryKey: ['executive', 'nps'], queryFn: getNpsResults, enabled: canNps, retry: false });
  const statements = useQuery({ queryKey: ['clients', clientId, 'statements'], queryFn: () => listClientStatements(clientId), enabled: canBill, retry: false });
  const stores = labor.data?.stores ?? [];
  const weeks = rollUpWeeks(stores);
  const truncated = labor.data?.truncated ?? false;
  const standardShare = standardShareOf(stores);
  const npsPoints = nps.data?.clientTrends?.find((c) => c.clientId === clientId)?.points ?? [];
  const billed = (statements.data?.statements ?? [])
    .filter((s) => s.snapshot?.totals)
    .sort((a, b) => a.periodEnd.localeCompare(b.periodEnd))
    .slice(-12)
    .map((s) => ({
      id: s.id,
      label: s.number !== null ? `#${s.number}` : weekLabel(s.periodEnd),
      periodEnd: s.periodEnd,
      amount: s.snapshot.totals.amount,
      hours: s.snapshot.totals.hours,
      state: s.status === 'DRAFT' ? ('Draft' as const) : s.paidAt ? ('Paid' as const) : ('Outstanding' as const),
    }));
  return { canLabor, canNps, canBill, labor, nps, statements, stores, weeks, npsPoints, billed, truncated, standardShare };
}

/* ----- The strip at the top of the record -------------------------------- */

function GlanceTile({ label, value, hint, children, onOpen }: { label: string; value: string; hint?: string; children?: React.ReactNode; onOpen?: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex min-w-0 flex-col gap-1 rounded-lg border border-line bg-surface-raised px-3 py-2.5 text-left transition-colors hover:border-gold/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
    >
      <span className="text-2xs font-medium uppercase tracking-wider text-ink-muted">{label}</span>
      <span className="flex items-end justify-between gap-2">
        <span className="text-lg font-semibold tabular-nums text-ink">{value}</span>
        {children}
      </span>
      {hint && <span className="truncate text-2xs text-ink-muted">{hint}</span>}
    </button>
  );
}

/** Four numbers with their trend, above the client's details — each opens the Performance tab. */
export function ClientGlance({ clientId, onOpen }: { clientId: string; onOpen: () => void }) {
  const n = useClientNumbers(clientId);
  const lastWeek = n.weeks[n.weeks.length - 1];
  const prevWeek = n.weeks[n.weeks.length - 2];
  const lastNps = [...n.npsPoints].reverse().find((p) => p.nps !== null);
  const lastBill = n.billed[n.billed.length - 1];
  const outstanding = n.billed.filter((b) => b.state === 'Outstanding').reduce((s, b) => s + b.amount, 0);
  const tiles: React.ReactNode[] = [];
  if (n.canLabor && n.weeks.length > 0) {
    const hoursDelta = lastWeek && prevWeek ? lastWeek.hours - prevWeek.hours : null;
    tiles.push(
      <GlanceTile key="hours" label="Hours last week" value={lastWeek ? lastWeek.hours.toLocaleString('en-US') : '—'} hint={hoursDelta === null ? undefined : `${hoursDelta >= 0 ? '+' : '−'}${Math.abs(Math.round(hoursDelta)).toLocaleString('en-US')} vs the week before`} onOpen={onOpen}>
        <Sparkline series={n.weeks.map((w) => w.hours)} tone="primary" />
      </GlanceTile>,
      <GlanceTile key="margin" label={n.standardShare >= 0.5 ? 'Margin per hour · standard rates' : 'Margin per hour'} value={perHour(lastWeek?.marginPerHour ?? null)} hint={marginBasis(n.standardShare)} onOpen={onOpen}>
        <Sparkline series={n.weeks.map((w) => w.marginPerHour)} tone={(lastWeek?.marginPerHour ?? 0) < 0 ? 'bad' : 'good'} />
      </GlanceTile>,
    );
  }
  if (n.canNps && n.npsPoints.some((p) => p.nps !== null)) {
    tiles.push(
      <GlanceTile key="nps" label={`NPS · ${lastNps?.quarter ?? ''}`} value={lastNps?.nps === null || lastNps === undefined ? '—' : `${lastNps.nps > 0 ? '+' : ''}${lastNps.nps}`} hint="Their managers’ answer, by quarter" onOpen={onOpen}>
        <Sparkline series={n.npsPoints.map((p) => p.nps)} tone="primary" />
      </GlanceTile>,
    );
  }
  if (n.canBill && n.billed.length > 0) {
    tiles.push(
      <GlanceTile key="billed" label="Last statement" value={lastBill ? fmtMoneyCompact(lastBill.amount) : '—'} hint={outstanding > 0 ? `${fmtMoney(outstanding)} outstanding` : 'Nothing outstanding'} onOpen={onOpen}>
        <Sparkline series={n.billed.map((b) => b.amount)} tone="primary" />
      </GlanceTile>,
    );
  }
  if (tiles.length === 0) return null;
  return (
    <div className={cn('grid grid-cols-2 gap-3', tiles.length >= 4 ? 'lg:grid-cols-4' : tiles.length === 3 ? 'lg:grid-cols-3' : '')} aria-label="At a glance">
      {tiles}
    </div>
  );
}

/** Whether the person can see any of the Performance tab. */
export function useCanSeeClientPerformance(): boolean {
  const { can } = useAuth();
  return can('manage:scheduling') || can('view:executive') || can('process:payroll') || can('view:marketing');
}

/* ----- The Performance tab ------------------------------------------------ */

export function ClientPerformance({ clientId }: { clientId: string }) {
  const term = useTerm();
  const n = useClientNumbers(clientId);
  const storeWord = term('label.store').toLowerCase();
  const weekRows = useMemo(() => n.weeks.map((w) => ({ week: weekLabel(w.start), hours: w.hours, margin: w.marginPerHour })), [n.weeks]);
  const loading = (n.canLabor && n.labor.isPending) || (n.canBill && n.statements.isPending) || (n.canNps && n.nps.isPending);
  if (loading) return <Skeleton className="h-72" />;
  const nothing = n.weeks.length === 0 && !n.npsPoints.some((p) => p.nps !== null) && n.billed.length === 0;
  if (nothing) {
    return <EmptyState icon={BarChart3} title="No numbers yet" description={`Hours, margin, NPS and statements show here once this ${term('label.client').toLowerCase()} has some.`} />;
  }
  const totalHours = n.weeks.reduce((s, w) => s + w.hours, 0);

  return (
    <div className="space-y-4">
      {n.weeks.length > 0 && (
        <ChartFrame
          title="Hours and margin, week by week"
          description={`The last ${n.weeks.length} full weeks across every ${storeWord}. ${marginBasis(n.standardShare)}.${n.truncated ? ' Too many punches to count them all — the oldest week may read low.' : ''}`}
          summary={`${Math.round(totalHours).toLocaleString('en-US')} hours over ${n.weeks.length} weeks; the last week ran ${perHour(n.weeks[n.weeks.length - 1]!.marginPerHour)}.`}
          csvName="client-hours-margin"
          columns={[
            { key: 'week', label: 'Week of' },
            { key: 'hours', label: 'Hours', numeric: true },
            { key: 'margin', label: 'Margin per hour', numeric: true, format: (v) => perHour(v as number | null) },
          ]}
          rows={weekRows}
        >
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={weekRows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={PALETTE.grid} vertical={false} />
              <XAxis dataKey="week" tick={TICK} tickLine={false} axisLine={false} />
              <YAxis yAxisId="h" tick={TICK} tickLine={false} axisLine={false} width={48} />
              <YAxis yAxisId="m" orientation="right" tick={TICK} tickLine={false} axisLine={false} width={56} tickFormatter={(v: number) => `$${v}`} />
              <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL_STYLE} cursor={{ fill: PALETTE.cursor }} formatter={(v, name) => (name === 'Margin per hour' ? perHour(Number(v)) : Number(v).toLocaleString('en-US'))} />
              <Bar yAxisId="h" dataKey="hours" name="Hours" fill={PALETTE.series[0]} radius={[3, 3, 0, 0]} maxBarSize={36} />
              <Line yAxisId="m" dataKey="margin" name="Margin per hour" stroke={PALETTE.series[1]} strokeWidth={2} dot={{ r: 3 }} connectNulls type="monotone" />
            </ComposedChart>
          </ResponsiveContainer>
        </ChartFrame>
      )}

      {n.stores.length > 1 && (
        <Card>
          <CardContent className="space-y-3 p-4 md:p-5">
            <SectionTitle as="h3" title={`By ${storeWord}`} description="Hours over the weeks, and the average margin per hour." />
            <ul className="divide-y divide-line">
              {[...n.stores]
                .sort((a, b) => b.hours4w - a.hours4w)
                .map((s) => (
                  <li key={s.locationId} className="flex items-center gap-3 py-2 text-sm">
                    <span className="min-w-0 flex-1 truncate text-ink">{s.locationName}</span>
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

      <div className="grid gap-4 xl:grid-cols-2">
        {n.npsPoints.some((p) => p.nps !== null) && (
          <ChartFrame
            title="NPS by quarter"
            description="Their managers’ answer to “how likely are you to recommend us?”, −100 to +100."
            summary={`NPS over ${n.npsPoints.length} quarters, latest ${[...n.npsPoints].reverse().find((p) => p.nps !== null)?.nps ?? '—'}.`}
            csvName="client-nps"
            height={220}
            columns={[
              { key: 'quarter', label: 'Quarter' },
              { key: 'nps', label: 'NPS', numeric: true },
              { key: 'responded', label: 'Answers', numeric: true },
            ]}
            rows={n.npsPoints}
          >
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={n.npsPoints} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
                <CartesianGrid stroke={PALETTE.grid} vertical={false} />
                <XAxis dataKey="quarter" tick={TICK} tickLine={false} axisLine={false} />
                <YAxis domain={[-100, 100]} ticks={[-100, -50, 0, 50, 100]} tick={TICK} tickLine={false} axisLine={false} width={40} />
                <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL_STYLE} />
                <Line dataKey="nps" name="NPS" stroke={PALETTE.series[0]} strokeWidth={2} dot={{ r: 3 }} connectNulls type="monotone" />
              </LineChart>
            </ResponsiveContainer>
          </ChartFrame>
        )}
        {n.billed.length > 0 && (
          <ChartFrame
            title="Billed, statement by statement"
            description="The last 12 statements. Gold is paid, amber is waiting on payment, grey is still a draft."
            summary={`${n.billed.length} statements, ${fmtMoney(n.billed.reduce((s, b) => s + b.amount, 0))} billed in all.`}
            csvName="client-statements"
            height={220}
            columns={[
              { key: 'label', label: 'Statement' },
              { key: 'periodEnd', label: 'Period ending', format: (v) => fmtDate(String(v)) },
              { key: 'hours', label: 'Hours', numeric: true },
              { key: 'amount', label: 'Billed', numeric: true, format: (v) => fmtMoney(v as number) },
              { key: 'state', label: 'Status' },
            ]}
            rows={n.billed}
          >
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={n.billed} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid stroke={PALETTE.grid} vertical={false} />
                <XAxis dataKey="label" tick={TICK} tickLine={false} axisLine={false} />
                <YAxis tick={TICK} tickLine={false} axisLine={false} width={52} tickFormatter={(v: number) => fmtMoneyCompact(v)} />
                <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL_STYLE} cursor={{ fill: PALETTE.cursor }} formatter={(v) => fmtMoney(Number(v))} />
                <Bar dataKey="amount" name="Billed" radius={[3, 3, 0, 0]} maxBarSize={32}>
                  {n.billed.map((b) => (
                    <Cell key={b.id} fill={b.state === 'Paid' ? PALETTE.series[0] : b.state === 'Outstanding' ? PALETTE.warn : PALETTE.other} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </ChartFrame>
        )}
      </div>
    </div>
  );
}
