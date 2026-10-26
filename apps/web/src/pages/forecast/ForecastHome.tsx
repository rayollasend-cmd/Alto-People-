import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarRange, LineChart, RefreshCw, SlidersHorizontal, Trash2 } from '@/components/ui/icons';
import { toast } from 'sonner';
import { FORECAST_SIGNAL_KINDS, FORECAST_SIGNAL_LABELS, type ForecastResponse, type ForecastSignalKind, type ForecastSiteSummary, type ForecastWeek } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { listClients } from '@/lib/clientsApi';
import { fmtDate, fmtDateOnly } from '@/lib/format';
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
import { DataGrid } from '@/components/ui/DataGrid';
import { ListTemplate } from '@/components/templates';
import { DetailsTable, PALETTE } from '@/components/ui/charts';
import { lazyPlot } from '@/components/ui/charts/lazyPlot';

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

/** The chart's drawing (recharts) loads with the chart, not the page (lazyPlot). */
const ForecastPlot = lazyPlot(() => import('./ForecastChart.plot').then((m) => ({ default: m.ForecastPlot })));

/**
 * The forecast's likely range: the forecast's own hue, clear enough to read
 * as a band on navy and on white (at 0.18 it vanished in both themes).
 */
const BAND = 'rgb(var(--color-chart-1) / 0.28)';
const BAND_EDGE = 'rgb(var(--color-chart-1) / 0.55)';

const hours = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${Math.round(n).toLocaleString()} h`);
const pct = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${n.toFixed(1)}%`);
const weekLabel = (key: string) => fmtDateOnly(key, { year: 'auto' });
/** A signed change in hours, the way a person writes it: "+12 h", "−41 h". */
const signedHours = (n: number) => `${n < 0 ? '−' : '+'}${Math.abs(Math.round(n)).toLocaleString()} h`;
/** A multiplier as the change it makes: 1.05 → "+5%", 0.8 → "−20%". */
const factorPct = (f: number) => {
  const p = Math.round((f - 1) * 100);
  return `${p < 0 ? '−' : '+'}${Math.abs(p)}%`;
};
/** The band edge as words: −0.15 → "15% under", 0.18 → "18% over". */
const bandWords = (n: number) => `${Math.round(Math.abs(n) * 100)}% ${n < 0 ? 'under' : 'over'}`;

/** The trend's TOTAL pull is capped at a fifth of the recent level (the API's TREND_CAP), so a falling site settles instead of sliding to zero. */
const TREND_CAP = 0.2;
function trendPull(d: ForecastWeek['drivers']): { pull: number; capped: boolean } {
  const cap = TREND_CAP * d.recentMean;
  const raw = d.trendPerWeek * d.leadWeeks;
  const capped = Math.abs(raw) > cap + 0.05;
  return { pull: capped ? Math.sign(raw) * cap : raw, capped };
}

/**
 * What every week ahead starts from, said once above the weeks: the last
 * eight weeks' average, their trend, how far a trend may carry, and how
 * much last year counts. "recent 83 h falling 16 h a week (held to 17 h
 * below)" on every row read as code (F500 audit 2026-10-26).
 */
export function forecastBasis(weeks: ForecastWeek[]): string {
  const d = weeks[0]?.drivers;
  if (!d) return '';
  const avg = Math.round(d.recentMean).toLocaleString();
  const t = Math.abs(Math.round(d.trendPerWeek));
  const parts = [
    `Each week starts from the last 8 weeks' average, ${avg} h a week${d.trendPerWeek && t ? `, and their trend: ${d.trendPerWeek > 0 ? 'up' : 'down'} about ${t} h a week` : ''}.`,
  ];
  if (weeks.some((w) => trendPull(w.drivers).capped)) {
    parts.push(`A trend counts for at most a fifth of the average (${Math.round(TREND_CAP * d.recentMean).toLocaleString()} h), so a few weeks' change doesn't carry on for months.`);
  }
  const ly = weeks.find((w) => w.drivers.lastYearScaled !== null)?.drivers;
  if (ly) parts.push(`The same week last year, scaled to this year's level, counts for ${Math.round(ly.lastYearWeight * 100)}%.`);
  return parts.join(' ');
}

/** What moves one week off the average: its share of the trend, last year, a holiday, a client's signal. */
export function weekParts(d: ForecastWeek['drivers']): string[] {
  const parts: string[] = [];
  const { pull, capped } = trendPull(d);
  if (Math.round(pull) !== 0) parts.push(`trend ${signedHours(pull)}${capped ? ' (its limit)' : ''}`);
  if (d.lastYearScaled !== null) parts.push(`last year ${Math.round(d.lastYearScaled).toLocaleString()} h`);
  if (d.holidayName) parts.push(`${d.holidayName} ${factorPct(d.holidayFactor)}`);
  for (const sg of d.signals) parts.push(`${kindLabel(sg.kind)} ${factorPct(sg.factor)}${sg.source ? ` (${sg.source})` : ''}`);
  return parts;
}
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
      subtitle="Verified hours per site and week, and the next 26 weeks forecast from them. Start a season plan from it in one click."
      actions={[
        { label: run ? 'Recompute' : 'Compute forecast', icon: RefreshCw, primary: true, onSelect: () => compute.mutate(), loading: compute.isPending, hidden: !canManage },
        { label: 'Signals', icon: SlidersHorizontal, onSelect: () => setSignalsOpen(true), disabled: !selected, hidden: !canManage },
        { label: 'Start a season plan', icon: CalendarRange, onSelect: () => setPlanOpen(true), disabled: !run, hidden: !canManage },
      ]}
      summary={
        <MetricStrip label="Forecast at a glance">
          <MetricCard label="Sites forecast" value={sitesQ.isLoading ? '…' : String(sites.length)} hint={run ? `Model tuned ${fmtDate(run.generatedAt)}` : 'Not computed yet'} />
          <MetricCard label="Next 4 weeks" value={siteQ.isLoading ? '…' : hours(run ? next4 : null)} hint={site ? `${site.siteName}, forecast` : 'Pick a site'} />
          <MetricCard
            label="Back-test error"
            value={pct(site?.mapePct ?? null)}
            hint="Mean absolute error at a four-week lead"
            nothing={site && site.mapePct === null ? 'Not scored yet' : undefined}
          />
          <MetricCard
            label="History"
            value={site ? String(site.historyWeeks) : '—'}
            unit={site ? (site.historyWeeks === 1 ? 'week' : 'weeks') : undefined}
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
            ? `${pastWeeks === 1 ? 'The last week' : `The last ${pastWeeks} weeks`} of verified hours, then the next 26 weeks forecast from them, with the likely range shaded around the forecast.`
            : 'No verified hours yet: the next 26 weeks start from nothing until hours come in.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-72 w-full">
          <ForecastPlot data={data} series={series} bandColor={BAND} bandEdge={BAND_EDGE} nowLabel={anchor ? weekLabel(anchor) : undefined} />
        </div>
        <ul className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-muted">
          <li className="flex items-center gap-1.5"><span aria-hidden="true" className="inline-block h-0.5 w-3.5 rounded-full" style={{ background: PALETTE.secondary }} />Verified hours</li>
          <li className="flex items-center gap-1.5"><span aria-hidden="true" className="inline-block h-0.5 w-3.5 rounded-full" style={{ background: PALETTE.primary }} />Forecast</li>
          <li className="flex items-center gap-1.5"><span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-sm border" style={{ background: BAND, borderColor: BAND_EDGE }} />Likely range: {bandWords(band.bandLow)} to {bandWords(band.bandHigh)} the forecast</li>
        </ul>
        <DetailsTable
          label="Details"
          columns={['Week', 'Verified', 'Low', 'Forecast', 'High']}
          // A worked week shows what was worked; the forecast columns are the weeks ahead.
          rows={weeks.map((w) => (w.actualHours === null ? [weekLabel(w.weekStart), '—', Math.round(w.p10), Math.round(w.p50), Math.round(w.p90)] : [weekLabel(w.weekStart), Math.round(w.actualHours), '—', '—', '—']))}
        />
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------- drivers */

function DriversCard({ weeks }: { weeks: ForecastWeek[] }) {
  const basis = forecastBasis(weeks);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Why the next four weeks</CardTitle>
        <CardDescription>{weeks.length ? basis : 'Every number is built from parts a person can check.'}</CardDescription>
      </CardHeader>
      <CardContent>
        {weeks.length === 0 ? (
          <EmptyState icon={LineChart} title="No weeks ahead" description="Compute the forecast to see the next four weeks and why." />
        ) : (
          <ul className="divide-y divide-line">
            {weeks.map((w) => {
              const parts = weekParts(w.drivers);
              return (
                <li key={w.weekStart} className="flex items-start justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <div className="text-sm text-ink">Week of {weekLabel(w.weekStart)}</div>
                    <div className="text-xs text-ink-muted">{[`${Math.round(w.drivers.recentMean).toLocaleString()} h average`, ...parts].join(' · ')}</div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-sm font-semibold tabular-nums text-ink">{hours(w.p50)}</div>
                    <div className="text-xs tabular-nums text-ink-muted">likely {Math.round(w.p10).toLocaleString()}–{Math.round(w.p90).toLocaleString()} h</div>
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
  const rows = data.accuracy.slice(0, 16);
  return (
    <Card>
      <CardHeader>
        <CardTitle>How the model has done</CardTitle>
        <CardDescription>Each month the forecast is scored against the hours that came, and the weights are re-picked from the result.</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyState size="sm" icon={LineChart} title="No scored week yet" description="The first scoring comes a month after the first compute, once forecast weeks have been worked." />
        ) : (
          <DataGrid<ForecastResponse['accuracy'][number]>
            id="forecast-accuracy"
            caption="How the forecast scored"
            rows={rows}
            rowKey={(r) => `${r.weekStart}:${r.leadWeeks}`}
            search={false}
            urlState={false}
            columnChooser={false}
            exportCsv={false}
            columns={[
              { key: 'week', header: 'Week', accessor: (r) => r.weekStart, cell: (r) => weekLabel(r.weekStart), primary: true },
              { key: 'lead', header: 'Ahead', accessor: (r) => r.leadWeeks, align: 'right', className: 'tabular-nums', cell: (r) => `${r.leadWeeks} ${r.leadWeeks === 1 ? 'week' : 'weeks'}` },
              { key: 'forecast', header: 'Forecast', accessor: (r) => r.forecastP50, align: 'right', className: 'tabular-nums', cell: (r) => hours(r.forecastP50) },
              { key: 'actual', header: 'Worked', accessor: (r) => r.actualHours, align: 'right', className: 'tabular-nums', cell: (r) => hours(r.actualHours) },
              {
                key: 'error',
                header: 'Off by',
                accessor: (r) => r.absPctError,
                align: 'right',
                className: 'tabular-nums',
                cell: (r) => (
                  <Badge variant={r.absPctError <= 15 ? 'success' : r.absPctError <= 30 ? 'pending' : 'destructive'} size="sm">
                    {r.absPctError.toFixed(1)}%
                  </Badge>
                ),
              },
            ]}
          />
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
      toast.success('Signal saved. The forecast includes it now.');
      await qc.invalidateQueries({ queryKey: ['forecast'] });
    },
    onError: (err: unknown) => toast.error(err instanceof ApiError ? err.message : 'Could not save the signal.'),
  });
  const remove = useMutation({
    mutationFn: removeForecastSignal,
    onSuccess: async () => qc.invalidateQueries({ queryKey: ['forecast'] }),
    onError: (err: unknown) => toast.error(err instanceof ApiError ? err.message : 'Could not remove the signal.'),
  });
  const f = Number(factor);
  const valid = weekStart.length === 10 && Number.isFinite(f) && f >= 0.1 && f <= 5;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Client signals</DialogTitle>
          <DialogDescription>What the client told you about a week: a truck schedule, occupancy, an event. Each raises or lowers that week's hours, and the forecast says it used it.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {(data?.signals ?? []).length > 0 && (
            <ul className="divide-y divide-navy-secondary/60 rounded-md border border-navy-secondary">
              {data!.signals.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <span className="text-ink">Week of {weekLabel(s.weekStart)}</span>
                    <span className="text-ink-muted"> · {kindLabel(s.kind)} {factorPct(s.factor)}{s.source ? ` · ${s.source}` : ''}</span>
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
