import { Fragment, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { STOCK_LEGEND } from '@/components/ui/charts';
import { Briefcase, CalendarRange } from 'lucide-react';
import { useAuth, useTenant, useTerm } from '@/lib/auth';
import { postingForGapHref } from '@/pages/recruiting/postingSeed';
import { getStaffingPlan, largestGap, type StaffingStore, type StaffingWeek } from '@/pages/recruiting/staffingGaps';
import { useClients } from '@/lib/useClients';
import { fmtDayShort, fmtMoney } from '@/lib/format';
import { cn } from '@/lib/cn';
import { CHART, ChartFrame } from '@/components/ui/ChartFrame';
import { QueryError } from '@/components/ui/QueryError';
import { Button, Card, CardContent, EmptyState, MetricCard, SegmentedControl, Select, SkeletonRows } from '@/components/ui';

/**
 * The staffing plan (GET /headcount/staffing-plan): heads required against
 * heads in place, store by store and week by week. Required comes from the
 * season plan, else the demand forecast, else the store's staffing targets;
 * the budget is the week's hours at today's bill rates. Gaps are red, with
 * the way to close them one click away (Season planner, open shifts).
 */

type Source = StaffingWeek['source'];

const SOURCE_LABEL: Record<Source, string> = {
  season: 'Season plan',
  forecast: 'Forecast',
  targets: 'Staffing targets',
  none: 'No demand set',
};

export function StaffingPlanView() {
  const term = useTerm();
  const canPost = useAuth().can('manage:recruiting');
  const hasClients = useTenant().moduleOn('clientPortal');
  const { clients } = useClients({ enabled: hasClients });
  const [weeks, setWeeks] = useState<8 | 12 | 26>(12);
  const [clientId, setClientId] = useState('');
  const plan = useQuery({ queryKey: ['headcount', 'staffing-plan', weeks, clientId], queryFn: () => getStaffingPlan({ weeks, clientId: clientId || undefined }) });
  const d = plan.data;

  const chartRows = useMemo(
    () =>
      (d?.totals ?? []).map((t) => ({
        week: fmtDayShort(t.week),
        inPlace: Math.min(t.placed, t.required),
        short: t.gap,
        required: t.required,
        scheduled: t.scheduled,
      })),
    [d],
  );
  const peak = useMemo(() => (d ? d.totals.reduce((m, t) => (t.required > m.required ? t : m), d.totals[0] ?? { week: '', required: 0, placed: 0, scheduled: 0, gap: 0, budget: null }) : null), [d]);
  const budget = useMemo(() => (d ? d.totals.reduce((s, t) => s + (t.budget ?? 0), 0) : 0), [d]);
  const short = useMemo(() => (d ? d.stores.filter((s) => s.weeks.some((w) => w.gap > 0)) : []), [d]);
  const groups = useMemo(() => {
    const out = new Map<string, { clientName: string | null; stores: StaffingStore[] }>();
    for (const s of d?.stores ?? []) {
      const key = s.clientId ?? 'none';
      const g = out.get(key) ?? { clientName: s.clientName, stores: [] };
      g.stores.push(s);
      out.set(key, g);
    }
    return [...out.values()].sort((a, b) => (a.clientName ?? '~').localeCompare(b.clientName ?? '~'));
  }, [d]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <SegmentedControl
          ariaLabel="Weeks ahead"
          value={weeks}
          onChange={setWeeks}
          options={[
            { value: 8 as const, label: '8 weeks' },
            { value: 12 as const, label: '12 weeks' },
            { value: 26 as const, label: '26 weeks' },
          ]}
        />
        {hasClients && clients.length > 1 && (
          <Select size="sm" aria-label={term('label.client')} value={clientId} onChange={(e) => setClientId(e.target.value)}>
            <option value="">Every {term('label.client').toLowerCase()}</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        )}
        <div className="ml-auto flex gap-2">
          <Button asChild size="sm" variant="outline">
            <Link to="/season-planner">
              <CalendarRange className="h-3.5 w-3.5" aria-hidden="true" />
              Season planner
            </Link>
          </Button>
        </div>
      </div>

      {plan.isError ? (
        <QueryError what="the staffing plan" query={plan} />
      ) : !d ? (
        <SkeletonRows count={6} />
      ) : d.stores.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState icon={CalendarRange} title={`No ${term('label.stores').toLowerCase()} to plan`} description={`Once ${term('label.stores').toLowerCase()} are set up with staffing targets or a season plan, heads required against heads in place appear here.`} />
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <MetricCard label="Peak heads required" value={peak?.required ?? 0} hint={peak?.week ? `Week of ${fmtDayShort(peak.week)}` : undefined} />
            <MetricCard label="In place now" value={d.totals[0]?.placed ?? 0} hint={`Placed across ${d.stores.length} ${d.stores.length === 1 ? term('label.store').toLowerCase() : term('label.stores').toLowerCase()}`} />
            <MetricCard label="Short at the peak" value={peak?.gap ?? 0} accent={(peak?.gap ?? 0) > 0} hint={`${short.length} ${short.length === 1 ? term('label.store').toLowerCase() : term('label.stores').toLowerCase()} short in some week`} />
            <MetricCard label={`Bill over ${weeks} weeks`} value={budget ? fmtMoney(budget) : '—'} hint={`An estimate at today’s bill rates · ${d.priced} of ${d.stores.length} priced`} />
          </div>

          <ChartFrame
            title="Required against in place"
            description="Each week: the heads in place, the shortfall stacked on top, and who is actually scheduled."
            summary={`Peak requirement is ${peak?.required ?? 0} heads; ${peak?.gap ?? 0} short that week. ${d.totals[0]?.placed ?? 0} in place now.`}
            columns={[
              { key: 'week', label: 'Week of' },
              { key: 'required', label: 'Required', numeric: true },
              { key: 'inPlace', label: 'In place', numeric: true },
              { key: 'short', label: 'Short', numeric: true },
              { key: 'scheduled', label: 'Scheduled', numeric: true },
            ]}
            rows={chartRows}
            csvName="staffing-plan"
            height={280}
          >
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartRows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid stroke={CHART.grid} vertical={false} />
                <XAxis dataKey="week" tick={{ fill: CHART.axis, fontSize: 11 }} tickLine={false} axisLine={false} />
                <YAxis allowDecimals={false} tick={{ fill: CHART.axis, fontSize: 11 }} tickLine={false} axisLine={false} width="auto" />
                <Tooltip contentStyle={CHART.tooltip} labelStyle={CHART.tooltipLabel} itemStyle={CHART.tooltipItem} />
                <Legend {...STOCK_LEGEND} />
                <Bar dataKey="inPlace" name="In place" stackId="heads" fill={CHART.series[1]} />
                <Bar dataKey="short" name="Short" stackId="heads" fill={CHART.bad} radius={[3, 3, 0, 0]} />
                <Line dataKey="scheduled" name="Scheduled" stroke={CHART.series[0]} strokeWidth={2} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </ChartFrame>

          <Card>
            <CardContent className="overflow-x-auto p-0">
              <table className="w-full text-sm">
                <caption className="sr-only">Heads required and short, by {term('label.store').toLowerCase()} and week</caption>
                <thead>
                  <tr className="border-b border-line text-xs text-ink-muted">
                    <th scope="col" className="sticky left-0 bg-surface px-3 py-2 text-left font-medium">
                      {term('label.store')}
                    </th>
                    <th scope="col" className="px-2 py-2 text-right font-medium">
                      In place
                    </th>
                    {d.weeks.map((w) => (
                      <th key={w} scope="col" className="whitespace-nowrap px-2 py-2 text-center font-medium">
                        {fmtDayShort(w)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {groups.map((g) => (
                    <Fragment key={g.clientName ?? 'none'}>
                      {hasClients && (
                        <tr className="bg-surface-raised">
                          <th scope="rowgroup" colSpan={d.weeks.length + 2} className="px-3 py-1.5 text-left text-xs font-medium uppercase tracking-wider text-ink-muted">
                            {g.clientName ?? `No ${term('label.client').toLowerCase()}`}
                          </th>
                        </tr>
                      )}
                      {g.stores.map((s) => (
                        <tr key={s.storeId} className="border-b border-line/60 last:border-0">
                          <th scope="row" className="sticky left-0 bg-surface px-3 py-2 text-left font-normal">
                            <div className="text-ink">{s.storeName}</div>
                            <div className="text-2xs text-ink-muted">{SOURCE_LABEL[s.weeks.find((w) => w.source !== 'none')?.source ?? 'none']}</div>
                            {canPost && largestGap(s) > 0 && (
                              <Button asChild size="sm" variant="outline" className="mt-1.5 h-7 px-2 text-xs">
                                <Link to={postingForGapHref({ clientId: s.clientId, storeName: s.storeName, openings: largestGap(s) })}>
                                  <Briefcase className="h-3.5 w-3.5" aria-hidden="true" />
                                  Open a posting for {largestGap(s)}
                                </Link>
                              </Button>
                            )}
                          </th>
                          <td className="px-2 py-2 text-right tabular-nums text-ink">{s.placed}</td>
                          {s.weeks.map((w) => (
                            <td key={w.week} className="px-1 py-1 text-center">
                              {w.required === 0 ? (
                                <span className="text-ink-subtle" aria-label="No demand set">
                                  ·
                                </span>
                              ) : (
                                <span
                                  className={cn('block rounded px-1.5 py-1 tabular-nums', w.gap > 0 ? 'bg-alert/15 text-alert' : 'text-ink')}
                                  title={`${w.required} required · ${w.placed} in place · ${w.scheduled} scheduled${w.budget !== null ? ` · ${fmtMoney(w.budget)}` : ''}`}
                                  aria-label={`${s.storeName}, week of ${fmtDayShort(w.week)}: ${w.required} required, ${w.gap > 0 ? `${w.gap} short` : 'covered'}`}
                                >
                                  {w.required}
                                  {w.gap > 0 && <span className="ml-0.5 text-2xs">−{w.gap}</span>}
                                </span>
                              )}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
          <p className="text-xs text-ink-muted">
            Each cell is heads required that week; red with a minus is the shortfall against the people in place. Close a gap in the{' '}
            <Link to="/season-planner" className="text-accent hover:underline">
              Season planner
            </Link>{' '}
            or by posting{' '}
            <Link to="/scheduling" className="text-accent hover:underline">
              open shifts
            </Link>
            .
          </p>
        </>
      )}
    </div>
  );
}
