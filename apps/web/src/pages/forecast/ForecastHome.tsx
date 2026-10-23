import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from 'recharts';
import { CalendarRange, LineChart, RefreshCw, SlidersHorizontal, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { FORECAST_SIGNAL_KINDS, FORECAST_SIGNAL_LABELS, type ForecastResponse, type ForecastSignalKind, type ForecastSiteSummary, type ForecastWeek } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { listClients } from '@/lib/clientsApi';
import { fmtDate } from '@/lib/format';
import { createPlanFromForecast, getSiteForecast, listForecastSites, removeForecastSignal, runForecast, setForecastSignal } from '@/lib/forecastApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { QueryError } from '@/components/ui/QueryError';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { ListTemplate } from '@/components/templates';
import { DetailsTable, PALETTE, ChartTooltipContent as PortalTooltip, TICK as KIT_TICK } from '@/components/ui/charts';

/**
 * Brief 3-4 — the labor-demand forecast.
 *
 * One site at a time: twenty-six weeks of verified hours behind, twenty-six
 * weeks of forecast ahead as a line inside its band, the drivers of the
 * weeks to come in words, the signals a person entered, and how the model
 * has done so far. The planner starts from it with one click.
 */

const SIGNAL_KINDS: ReadonlyArray<{ value: ForecastSignalKind; label: string }> = FORECAST_SIGNAL_KINDS.map((value) => ({ value, label: FORECAST_SIGNAL_LABELS[value] }));
const kindLabel = (k: ForecastSignalKind) => FORECAST_SIGNAL_LABELS[k] ?? k;

// The kit's grid, ticks and reference color — one look across every chart.
const GRID = PALETTE.grid;
const TICK = { ...KIT_TICK, fontSize: 10 } as const;
const REF = PALETTE.ref;
/** The forecast's uncertainty band: the primary hue, faint. */
const BAND = 'rgb(var(--color-chart-1) / 0.18)';

const hours = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${Math.round(n).toLocaleString()} h`);
const pct = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${n.toFixed(1)}%`);
const weekLabel = (key: string) => fmtDate(`${key}T12:00:00Z`);
/** Fewer weeks than one horizon of history: the forecast is a guess, and says so. */
export const CONFIDENT_HISTORY_WEEKS = 26;
const lowConfidence = (s: ForecastSiteSummary | null) => s !== null && s.historyWeeks < CONFIDENT_HISTORY_WEEKS;

export function ForecastHome() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { can } = useAuth();
  const canManage = can('manage:org');
  const qc = useQueryClient();

  const sitesQ = useQuery({ queryKey: ['forecast', 'sites'], queryFn: listForecastSites });
  const sites = useMemo(() => sitesQ.data?.sites ?? [], [sitesQ.data]);
  const run = sitesQ.data?.run ?? null;
  const selected = searchParams.get('site') ?? sites[0]?.locationId ?? '';
  const siteQ = useQuery({ queryKey: ['forecast', 'site', selected], queryFn: () => getSiteForecast(selected), enabled: selected.length > 0 });

  const [signalsOpen, setSignalsOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(searchParams.get('plan') === '1');

  const compute = useMutation({
    mutationFn: runForecast,
    onSuccess: async (r) => {
      toast.success(`Forecast computed for ${r.sites} site${r.sites === 1 ? '' : 's'}${r.weights.mapePct !== null ? ` · back-test error ${r.weights.mapePct.toFixed(1)}%` : ''}.`);
      await qc.invalidateQueries({ queryKey: ['forecast'] });
    },
    onError: (err: unknown) => toast.error(err instanceof ApiError ? err.message : 'Could not compute the forecast.'),
  });

  const site = siteQ.data?.site ?? sites.find((s) => s.locationId === selected) ?? null;
  const weeks = siteQ.data?.weeks ?? [];
  const future = weeks.filter((w) => w.actualHours === null);
  const next4 = future.slice(0, 4).reduce((a, w) => a + w.p50, 0);

  return (
    // Design system §4.2: the List template — the summary strip, one filter row, the lists.
    <ListTemplate
      title="Demand forecast"
      subtitle="Verified hours per site and week, twenty-six weeks ahead with the band the model has earned. Start a season plan from it in one click."
      actions={[
        { label: run ? 'Recompute' : 'Compute forecast', icon: RefreshCw, primary: true, onSelect: () => compute.mutate(), loading: compute.isPending, hidden: !canManage },
        { label: 'Signals', icon: SlidersHorizontal, onSelect: () => setSignalsOpen(true), disabled: !selected, hidden: !canManage },
        { label: 'Start a season plan', icon: CalendarRange, onSelect: () => setPlanOpen(true), disabled: !run, hidden: !canManage },
      ]}
      summary={
        <MetricStrip label="Forecast at a glance">
          <MetricCard label="Sites forecast" value={sitesQ.isLoading ? '…' : String(sites.length)} hint={run ? `Computed ${fmtDate(run.generatedAt)}` : 'Not computed yet'} />
          <MetricCard label="Next 4 weeks" value={siteQ.isLoading ? '…' : hours(run ? next4 : null)} hint={site ? site.siteName : 'Pick a site'} />
          <MetricCard
            label="Back-test error"
            value={pct(site?.mapePct ?? null)}
            hint="Mean absolute error at a four-week lead"
            nothing={site && site.mapePct === null ? 'Not scored yet' : undefined}
          />
          <MetricCard
            label="History"
            value={site ? `${site.historyWeeks} wk` : '—'}
            tone={lowConfidence(site) ? 'warning' : 'default'}
            hint={lowConfidence(site) ? `Low confidence: ${site!.historyWeeks} of ${CONFIDENT_HISTORY_WEEKS} weeks of history` : 'Weeks of verified hours behind the forecast'}
          />
        </MetricStrip>
      }
      filters={
        sites.length > 0 ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <label className="text-xs text-ink-muted" htmlFor="forecast-site">
              Site
            </label>
            <Select id="forecast-site" size="sm" value={selected} onChange={(e) => setSearchParams((p) => { p.set('site', e.target.value); return p; })} className="w-full sm:w-80">
              {sites.map((s) => (
                <option key={s.locationId} value={s.locationId}>
                  {s.siteName}
                  {s.clientName ? ` · ${s.clientName}` : ''}
                </option>
              ))}
            </Select>
          </div>
        ) : undefined
      }
    >
      {sitesQ.isError ? (
        <QueryError what="the forecast" query={sitesQ} />
      ) : sitesQ.isLoading ? (
        <Skeleton className="h-72" />
      ) : sites.length === 0 ? (
        <EmptyState icon={LineChart} title="No active site to forecast" description="A forecast needs a site with verified hours behind it." />
      ) : !run ? (
        <EmptyState
          icon={LineChart}
          title="No forecast yet"
          description="The first compute reads every site's verified hours, back-tests the model on them, and writes twenty-six weeks ahead."
          action={canManage ? <Button onClick={() => compute.mutate()} loading={compute.isPending}>Compute forecast</Button> : undefined}
        />
      ) : siteQ.isError ? (
        <QueryError what="this site's forecast" query={siteQ} />
      ) : siteQ.isLoading || !siteQ.data ? (
        <Skeleton className="h-72" />
      ) : (
        <>
          <ForecastChart weeks={weeks} site={site} band={run.weights} />
          <div className="grid gap-5 lg:grid-cols-2">
            <DriversCard weeks={future.slice(0, 4)} />
            <AccuracyCard data={siteQ.data} />
          </div>
        </>
      )}

      {signalsOpen && selected && (
        <SignalsDialog locationId={selected} data={siteQ.data ?? null} weeks={future} onClose={() => setSignalsOpen(false)} />
      )}
      {planOpen && <PlanDialog sites={sites} onClose={() => setPlanOpen(false)} />}
    </ListTemplate>
  );
}

/* ---------------------------------------------------------------- chart */

function ForecastChart({ weeks, site, band }: { weeks: ForecastWeek[]; site: ForecastSiteSummary | null; band: { bandLow: number; bandHigh: number } }) {
  const siteName = site?.siteName ?? '';
  const pastWeeks = weeks.filter((w) => w.actualHours !== null).length;
  // The band as multiples of the forecast, not as signed percents ("band -100% to +15%").
  const times = (n: number) => `${Math.max(0, 1 + n).toFixed(2).replace(/\.?0+$/, '')}×`;
  const anchor = weeks.find((w) => w.actualHours === null)?.weekStart;
  const data = weeks.map((w) => ({
    week: w.weekStart,
    label: weekLabel(w.weekStart),
    actual: w.actualHours,
    p50: w.actualHours === null ? w.p50 : null,
    band: w.actualHours === null ? [w.p10, w.p90] : null,
  }));
  const series = {
    actual: { name: 'Verified hours', color: PALETTE.secondary },
    p50: { name: 'Forecast', color: PALETTE.primary },
  };
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>{siteName}: hours by week</CardTitle>
          {lowConfidence(site) && (
            <Badge variant="pending" size="sm">
              Low confidence: {site!.historyWeeks} of {CONFIDENT_HISTORY_WEEKS} weeks of history
            </Badge>
          )}
        </div>
        <CardDescription>
          {pastWeeks > 0
            ? `The ${pastWeeks === 1 ? 'week' : `${pastWeeks} weeks`} since this site's first verified hours, the next twenty-six as the model expects them, inside the range its back-test earned.`
            : 'No verified hours yet: the next twenty-six weeks start from nothing until hours come in.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-72 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={GRID} strokeWidth={1} vertical={false} />
              <XAxis dataKey="label" tick={TICK} axisLine={{ stroke: GRID }} tickLine={false} interval="preserveStartEnd" minTickGap={28} />
              <YAxis tick={TICK} axisLine={false} tickLine={false} width="auto" tickFormatter={(v: number) => `${Math.round(v)}h`} />
              <ChartTooltip cursor={{ stroke: REF, strokeWidth: 1 }} content={<PortalTooltip series={series} format={(v) => `${Math.round(v).toLocaleString()} h`} />} />
              <Area type="monotone" dataKey="band" stroke="none" fill={BAND} isAnimationActive={false} connectNulls={false} legendType="none" />
              <Line type="monotone" dataKey="actual" stroke={PALETTE.secondary} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls={false} />
              <Line type="monotone" dataKey="p50" stroke={PALETTE.primary} strokeWidth={2} strokeDasharray="5 3" dot={false} isAnimationActive={false} connectNulls={false} />
              {anchor && (
                <ReferenceLine x={weekLabel(anchor)} stroke={REF} strokeDasharray="4 3" label={{ value: 'Now', position: 'insideTopLeft', fill: KIT_TICK.fill, fontSize: 10 }} />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <ul className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-silver/80">
          <li className="flex items-center gap-1.5"><span aria-hidden="true" className="inline-block h-0.5 w-3.5 rounded-full" style={{ background: PALETTE.secondary }} />Verified hours</li>
          <li className="flex items-center gap-1.5"><span aria-hidden="true" className="inline-block h-0.5 w-3.5 rounded-full" style={{ background: PALETTE.primary }} />Forecast</li>
          <li className="flex items-center gap-1.5"><span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: BAND }} />Likely range: {times(band.bandLow)} to {times(band.bandHigh)} the forecast</li>
        </ul>
        <DetailsTable
          label="Details"
          columns={['Week', 'Verified', 'Low', 'Forecast', 'High']}
          rows={weeks.map((w) => [weekLabel(w.weekStart), w.actualHours === null ? '—' : Math.round(w.actualHours), w.actualHours === null ? Math.round(w.p10) : '—', Math.round(w.p50), w.actualHours === null ? Math.round(w.p90) : '—'])}
        />
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------- drivers */

function DriversCard({ weeks }: { weeks: ForecastWeek[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Why the next four weeks</CardTitle>
        <CardDescription>Every number is built from parts a person can check.</CardDescription>
      </CardHeader>
      <CardContent>
        {weeks.length === 0 ? (
          <EmptyState icon={LineChart} title="No weeks ahead" description="Compute the forecast to see the next four weeks and why." />
        ) : (
          <ul className="divide-y divide-navy-secondary/60">
            {weeks.map((w) => {
              const d = w.drivers;
              const parts: string[] = [];
              if (d.lastYearScaled !== null) parts.push(`last year ${Math.round(d.lastYearScaled)} h at ${Math.round(d.lastYearWeight * 100)}%`);
              // The trend's total pull is capped at 20% of the recent level (the API's TREND_CAP),
              // so a falling site settles instead of sliding to zero: say so when the cap holds.
              const cap = 0.2 * d.recentMean;
              const capped = Math.abs(d.trendPerWeek * d.leadWeeks) > cap + 0.05;
              parts.push(
                `recent ${Math.round(d.recentMean)} h${d.trendPerWeek ? ` ${d.trendPerWeek > 0 ? 'rising' : 'falling'} ${Math.abs(Math.round(d.trendPerWeek))} h a week` : ''}${capped ? ` (held to ${Math.round(cap)} h ${d.trendPerWeek > 0 ? 'above' : 'below'})` : ''}`,
              );
              if (d.holidayName) parts.push(`${d.holidayName} ×${d.holidayFactor.toFixed(2)}`);
              for (const s of d.signals) parts.push(`${kindLabel(s.kind)} ×${s.factor.toFixed(2)}${s.source ? ` (${s.source})` : ''}`);
              return (
                <li key={w.weekStart} className="flex items-start justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <div className="text-sm text-ink">Week of {weekLabel(w.weekStart)}</div>
                    <div className="text-xs text-ink-muted">{parts.join(' · ')}</div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-sm font-semibold tabular-nums text-ink">{Math.round(w.p50)} h</div>
                    <div className="text-2xs tabular-nums text-ink-muted">{Math.round(w.p10)} to {Math.round(w.p90)}</div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------- accuracy */

function AccuracyCard({ data }: { data: ForecastResponse }) {
  const rows = data.accuracy;
  return (
    <Card>
      <CardHeader>
        <CardTitle>How the model has done</CardTitle>
        <CardDescription>Each month the forecast is scored against the hours that came, and the weights are re-picked from the result.</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-ink-muted">No scored week yet. The first scoring comes a month after the first compute, when forecast weeks have been worked.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-2xs uppercase tracking-wider text-ink-muted">
                  <th className="py-1 pr-3 font-medium">Week</th>
                  <th className="py-1 pr-3 font-medium">Lead</th>
                  <th className="py-1 pr-3 font-medium">Forecast</th>
                  <th className="py-1 pr-3 font-medium">Actual</th>
                  <th className="py-1 pr-3 font-medium">Error</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-navy-secondary/60">
                {rows.slice(0, 16).map((r) => (
                  <tr key={`${r.weekStart}:${r.leadWeeks}`}>
                    <td className="py-1 pr-3 text-silver">{weekLabel(r.weekStart)}</td>
                    <td className="py-1 pr-3 tabular-nums text-ink">{r.leadWeeks} wk</td>
                    <td className="py-1 pr-3 tabular-nums text-ink">{Math.round(r.forecastP50)} h</td>
                    <td className="py-1 pr-3 tabular-nums text-ink">{Math.round(r.actualHours)} h</td>
                    <td className="py-1 pr-3 tabular-nums">
                      <Badge variant={r.absPctError <= 15 ? 'success' : r.absPctError <= 30 ? 'pending' : 'destructive'} size="sm">
                        {r.absPctError.toFixed(1)}%
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------- signals */

function SignalsDialog({ locationId, data, weeks, onClose }: { locationId: string; data: ForecastResponse | null; weeks: ForecastWeek[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [weekStart, setWeekStart] = useState(weeks[0]?.weekStart ?? '');
  const [kind, setKind] = useState<ForecastSignalKind>('TRUCKS');
  const [factor, setFactor] = useState('1.10');
  const [source, setSource] = useState('');
  const [note, setNote] = useState('');
  const save = useMutation({
    mutationFn: () => setForecastSignal({ locationId, weekStart, kind, factor: Number(factor), source: source.trim() || null, note: note.trim() || null }),
    onSuccess: async () => {
      toast.success('Signal saved. Recompute to apply it.');
      await qc.invalidateQueries({ queryKey: ['forecast', 'site', locationId] });
    },
    onError: (err: unknown) => toast.error(err instanceof ApiError ? err.message : 'Could not save the signal.'),
  });
  const remove = useMutation({
    mutationFn: removeForecastSignal,
    onSuccess: async () => qc.invalidateQueries({ queryKey: ['forecast', 'site', locationId] }),
    onError: (err: unknown) => toast.error(err instanceof ApiError ? err.message : 'Could not remove the signal.'),
  });
  const f = Number(factor);
  const valid = weekStart.length === 10 && Number.isFinite(f) && f >= 0.1 && f <= 5;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Client signals</DialogTitle>
          <DialogDescription>What the client told you about a week: a truck schedule, occupancy, an event. Each is a multiplier on that week's hours, and the forecast says it used it.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {(data?.signals ?? []).length > 0 && (
            <ul className="divide-y divide-navy-secondary/60 rounded-md border border-navy-secondary">
              {data!.signals.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <span className="text-ink">Week of {weekLabel(s.weekStart)}</span>
                    <span className="text-ink-muted"> · {kindLabel(s.kind)} ×{s.factor.toFixed(2)}{s.source ? ` · ${s.source}` : ''}</span>
                  </div>
                  <Button size="xs" variant="ghost" aria-label="Remove signal" onClick={() => remove.mutate(s.id)} disabled={remove.isPending}>
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Week" required>
              <Select value={weekStart} onChange={(e) => setWeekStart(e.target.value)}>
                {weeks.map((w) => (
                  <option key={w.weekStart} value={w.weekStart}>Week of {weekLabel(w.weekStart)}</option>
                ))}
              </Select>
            </Field>
            <Field label="Kind" required>
              <Select value={kind} onChange={(e) => setKind(e.target.value as ForecastSignalKind)}>
                {SIGNAL_KINDS.map((k) => (
                  <option key={k.value} value={k.value}>{k.label}</option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Multiplier" required hint="1.20 is a fifth more hours; 0.80 a fifth fewer.">
              <Input type="number" step="0.01" min={0.1} max={5} value={factor} onChange={(e) => setFactor(e.target.value)} className="text-base" />
            </Field>
            <Field label="Source">
              <Input value={source} onChange={(e) => setSource(e.target.value)} placeholder="Client's truck schedule" maxLength={120} />
            </Field>
          </div>
          <Field label="Note">
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
          <Button onClick={() => save.mutate()} disabled={!valid} loading={save.isPending}>Save signal</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ----------------------------------------------------------------- plan */

function defaultSeason(): { start: string; end: string } {
  const d = new Date();
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 7));
  const end = new Date(start.getTime() + 12 * 7 * 86_400_000);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

function PlanDialog({ sites, onClose }: { sites: ForecastSiteSummary[]; onClose: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const season = defaultSeason();
  const [name, setName] = useState('');
  const [clientId, setClientId] = useState('');
  const [seasonStart, setSeasonStart] = useState(season.start);
  const [seasonEnd, setSeasonEnd] = useState(season.end);
  const [shiftHours, setShiftHours] = useState('8');
  const clients = useQuery({ queryKey: ['forecast', 'clients'], queryFn: () => listClients({ status: 'ACTIVE', limit: 200 }) });
  const create = useMutation({
    mutationFn: () => createPlanFromForecast({ name: name.trim(), clientId: clientId || null, seasonStart, seasonEnd, targetHoursPerWeek: 40, shiftHours: Number(shiftHours) || 8, reservePct: 10 }),
    onSuccess: async (plan) => {
      toast.success(`${plan.name} created from the forecast with ${plan.sites.length} site${plan.sites.length === 1 ? '' : 's'}.`);
      await qc.invalidateQueries({ queryKey: ['season-plans'] });
      onClose();
      navigate(`/season-planner?plan=${plan.id}`);
    },
    onError: (err: unknown) => toast.error(err instanceof ApiError ? err.message : 'Could not create the plan.'),
  });
  const valid = name.trim().length >= 2 && seasonEnd >= seasonStart;
  return (
    <Dialog open onOpenChange={(o) => !o && !create.isPending && onClose()} confirmDiscard={() => name.trim().length > 0}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Start a season plan from the forecast</DialogTitle>
          <DialogDescription>
            Each site's weekly hours become people on the floor a day, split across shifts the way its targets split today. {sites.length} site{sites.length === 1 ? '' : 's'} carry a forecast.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="Name" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Summer 2027 — from the forecast" autoFocus maxLength={120} />
          </Field>
          <Field label="Client" hint="Leave on every client for a company-wide plan.">
            <Select value={clientId} onChange={(e) => setClientId(e.target.value)}>
              <option value="">Every client</option>
              {(clients.data?.clients ?? []).map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Season start" required>
              <Input type="date" value={seasonStart} onChange={(e) => setSeasonStart(e.target.value)} className="text-base" />
            </Field>
            <Field label="Season end" required>
              <Input type="date" value={seasonEnd} onChange={(e) => setSeasonEnd(e.target.value)} className="text-base" />
            </Field>
            <Field label="Shift hours">
              <Input type="number" min={4} max={12} value={shiftHours} onChange={(e) => setShiftHours(e.target.value)} className="text-base" />
            </Field>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={create.isPending}>Cancel</Button>
          <Button onClick={() => create.mutate()} disabled={!valid} loading={create.isPending}>Create plan</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
