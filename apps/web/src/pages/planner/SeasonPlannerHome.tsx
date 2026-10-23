import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, BedDouble, CalendarRange, Copy, Download, FileText, Plus, TrendingUp } from 'lucide-react';
import { toast } from 'sonner';
import {
  RECRUITING_CHANNELS,
  RECRUITING_CHANNEL_LABELS,
  type ChannelPercent,
  type ChannelWeeks,
  type SeasonDemandWeek,
  type SeasonGap,
  type SeasonPlanComputed,
  type SeasonPlanSiteComputed,
  type SeasonPlanSiteInput,
  type SeasonPlanSummary,
  type SeasonPlanUpdate,
  type SeasonRecruitingTarget,
} from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useConfirm, usePrompt } from '@/lib/confirm';
import { listClients } from '@/lib/clientsApi';
import { fmtDate } from '@/lib/format';
import {
  compareSeasonPlans,
  createSeasonPlan,
  duplicateSeasonPlan,
  getSeasonPlan,
  listSeasonPlans,
  seasonPlanCsvUrl,
  seasonPlanSitePdfUrl,
  updateSeasonPlan,
} from '@/lib/seasonPlansApi';
import { Badge } from '@/components/ui/Badge';
import { LiveWhatIfCard } from '@/components/planner/LiveWhatIfCard';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { DataGrid } from '@/components/ui/DataGrid';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { MetricCard } from '@/components/ui/MetricCard';
import { QueryError } from '@/components/ui/QueryError';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { ListTemplate } from '@/components/templates';
import { StackedBarChart } from '@/components/ui/charts';
import { ChartFrame, type ChartColumn } from '@/components/ui/ChartFrame';
import { TaskDemandEditor, linesOf, mixLine, spreadLines } from './TaskDemandEditor';
import { fmtMoney } from '@/lib/format';

/**
 * THE SEASON PLANNER — demand becomes people, beds, seats and recruits.
 *
 * A plan is a scenario: the floor headcount each store needs per shift
 * per week, what the vans carry, the beds on hand, and the recruiting
 * mix. The server does the arithmetic (shift slots ÷ shifts per person
 * × reserve) and names every shortfall; this page is the inputs, the
 * answer, and two scenarios side by side.
 *
 * One hero per surface: the associates needed at the peak week. The
 * weekly bar has its Details table twin; everything editable sits under
 * collapsible sections so the answer stays above the fold.
 */

const num = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v.toLocaleString('en-US'));
/** "May 2" for an org-week start; the year is in the page header. */
const weekLabel = (ymd: string) => {
  const [, m, d] = ymd.split('-').map(Number);
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${MONTHS[(m ?? 1) - 1]} ${d}`;
};

/** The weekly figures, the plan chart's table and CSV. */
const dash = (v: unknown) => (v === null || v === undefined ? '—' : String(v));
const WEEKLY_COLUMNS: ChartColumn[] = [
  { key: 'label', label: 'Week of' },
  { key: 'daily', label: 'On floor / day', numeric: true },
  { key: 'associatesNeeded', label: 'Associates', numeric: true },
  { key: 'bedsNeeded', label: 'Beds needed', numeric: true },
  { key: 'bedsAvailable', label: 'Beds available', numeric: true },
  { key: 'vanSeatsNeeded', label: 'Van seats needed', numeric: true },
  { key: 'vanSeatsAvailable', label: 'Van seats carried', numeric: true },
  { key: 'scheduledHours', label: 'Scheduled hours', numeric: true, format: dash },
  { key: 'activeHeadcount', label: 'Active now', numeric: true, format: dash },
  { key: 'forecastShortDays', label: 'Short days (forecast)', numeric: true, format: dash },
];
const GAP_BADGE: Record<SeasonGap['kind'], { variant: 'destructive' | 'pending' | 'info' | 'accent'; label: string }> = {
  HEADCOUNT: { variant: 'destructive', label: 'People' },
  BEDS: { variant: 'destructive', label: 'Beds' },
  VAN_SEATS: { variant: 'pending', label: 'Van seats' },
  RECRUITING: { variant: 'accent', label: 'Recruiting' },
};

/** Next summer by default: May 1 to Sep 30 of the coming year (or this year before May). */
function defaultSeason(): { start: string; end: string } {
  const now = new Date();
  const year = now.getMonth() < 4 ? now.getFullYear() : now.getFullYear() + 1;
  return { start: `${year}-05-01`, end: `${year}-09-30` };
}

export function SeasonPlannerHome() {
  const [searchParams] = useSearchParams();
  const planId = searchParams.get('plan');
  const compare = searchParams.get('compare');
  if (compare && compare.includes(',')) {
    const [a, b] = compare.split(',');
    if (a && b) return <CompareView a={a} b={b} />;
  }
  if (planId) return <PlanView id={planId} />;
  return <PlansList />;
}

/* ============================================================ the list */

function PlansList() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const canManage = can('manage:org');
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [compareA, setCompareA] = useState('');
  const [compareB, setCompareB] = useState('');
  const q = useQuery({ queryKey: ['season-plans', 'list', showArchived], queryFn: () => listSeasonPlans(showArchived) });
  const plans = q.data?.plans ?? [];
  const noPlans = !!q.data && plans.length === 0 && !showArchived;

  return (
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    <ListTemplate
        title="Season planner"
        subtitle="Demand by store, shift and week becomes associates, beds, van seats and recruiting targets. Save scenarios and compare them side by side."
        // With no plan yet both ways in sit in the empty state itself, not
        // only up here (F500 G2); the header carries them once there is a list.
        primaryAction={
          canManage && !noPlans ? (
            <Button onClick={() => setCreating(true)}>
              <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
              New plan
            </Button>
          ) : undefined
        }
        secondaryActions={
          canManage && !noPlans ? (
            // Brief 3-4: a plan whose demand is the 26-week forecast, one click away.
            <Button variant="outline" onClick={() => navigate('/forecast?plan=1')}>
              <TrendingUp className="mr-2 h-4 w-4" aria-hidden="true" />
              Start from the forecast
            </Button>
          ) : undefined
        }
    >

      {q.isError ? (
        <QueryError what="season plans" query={q} />
      ) : (
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <CardTitle>Scenarios</CardTitle>
                <CardDescription>Open one to edit its demand and read its gaps; pick two to compare.</CardDescription>
              </div>
              <label className="flex items-center gap-2 text-sm text-silver">
                <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived
              </label>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {q.isLoading ? (
              <Skeleton className="h-40" />
            ) : plans.length === 0 ? (
              <EmptyState
                icon={CalendarRange}
                title={showArchived ? 'No season plans' : 'No season plan yet'}
                description="Start from the 26-week forecast, or a blank plan from every store's current staffing targets, one row per week of the season."
                action={
                  canManage && !showArchived ? (
                    <div className="flex flex-wrap justify-center gap-2">
                      <Button onClick={() => navigate('/forecast?plan=1')}>
                        <TrendingUp className="mr-2 h-4 w-4" aria-hidden="true" />
                        Start from the forecast
                      </Button>
                      <Button variant="secondary" onClick={() => setCreating(true)}>
                        <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
                        Blank plan
                      </Button>
                    </div>
                  ) : undefined
                }
              />
            ) : (
              <DataGrid<SeasonPlanSummary>
                id="season-plans"
                caption="Season plans"
                rows={plans}
                rowKey={(p) => p.id}
                urlState={false}
                columnChooser={false}
                exportCsv={{ filename: 'season-plans' }}
                rowHref={(p) => `/season-planner?plan=${p.id}`}
                columns={[
                  { key: 'name', header: 'Plan', accessor: (p) => p.name, sortable: true, primary: true, cell: (p) => (<span className="flex items-center gap-2">{p.name}{p.archivedAt && <Badge variant="outline">Archived</Badge>}</span>) },
                  { key: 'client', header: 'Client', accessor: (p) => p.clientName ?? 'All clients', sortable: true, cardMeta: true },
                  { key: 'season', header: 'Season', accessor: (p) => p.seasonStart, sortable: true, searchable: false, cell: (p) => `${fmtDate(p.seasonStart)} – ${fmtDate(p.seasonEnd)} · ${p.weeks.length} wk`, cardMeta: true },
                  { key: 'sites', header: 'Stores', accessor: (p) => p.siteCount, sortable: true, searchable: false, align: 'right' },
                  { key: 'updated', header: 'Updated', accessor: (p) => p.updatedAt, sortable: true, searchable: false, cell: (p) => fmtDate(p.updatedAt), className: 'text-silver' },
                ]}
              />
            )}

            {plans.length >= 2 && (
              <div className="flex flex-wrap items-end gap-3 rounded-md border border-navy-secondary p-3">
                <Field label="Compare">
                  <Select value={compareA} onChange={(e) => setCompareA(e.target.value)} aria-label="First plan">
                    <option value="">Pick a plan…</option>
                    {plans.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </Select>
                </Field>
                <Field label="with">
                  <Select value={compareB} onChange={(e) => setCompareB(e.target.value)} aria-label="Second plan">
                    <option value="">Pick a plan…</option>
                    {plans.filter((p) => p.id !== compareA).map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </Select>
                </Field>
                <Button variant="outline" disabled={!compareA || !compareB} onClick={() => navigate(`/season-planner?compare=${compareA},${compareB}`)}>
                  Compare side by side
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {creating && <CreatePlanDialog onClose={() => setCreating(false)} />}
    </ListTemplate>
  );
}

function CreatePlanDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const season = defaultSeason();
  const [name, setName] = useState('');
  const [clientId, setClientId] = useState('');
  const [seasonStart, setSeasonStart] = useState(season.start);
  const [seasonEnd, setSeasonEnd] = useState(season.end);
  const [targetHours, setTargetHours] = useState('40');
  const [shiftHours, setShiftHours] = useState('8');
  const [reserve, setReserve] = useState('10');
  const clients = useQuery({ queryKey: ['season-plans', 'clients'], queryFn: () => listClients({ status: 'ACTIVE', limit: 200 }) });

  const create = useMutation({
    mutationFn: createSeasonPlan,
    onSuccess: async (plan) => {
      toast.success(`${plan.name} created with ${plan.sites.length} store${plan.sites.length === 1 ? '' : 's'}.`);
      await qc.invalidateQueries({ queryKey: ['season-plans'] });
      onClose();
      navigate(`/season-planner?plan=${plan.id}`);
    },
    onError: (err: unknown) => toast.error(err instanceof ApiError ? err.message : 'Could not create the plan.'),
  });
  const valid = name.trim().length >= 2 && seasonStart.length === 10 && seasonEnd.length === 10 && seasonEnd >= seasonStart;

  return (
    <Dialog open onOpenChange={(o) => !o && !create.isPending && onClose()} confirmDiscard={() => name.trim().length > 0}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New season plan</DialogTitle>
          <DialogDescription>
            Starts from every store&apos;s current staffing targets, one row per week. Change the demand, beds and vans on the plan afterwards.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="Name" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Summer 2027 — original" autoFocus maxLength={120} />
          </Field>
          <Field label="Client" hint="Leave on every client for a company-wide plan.">
            <Select value={clientId} onChange={(e) => setClientId(e.target.value)}>
              <option value="">Every client</option>
              {(clients.data?.clients ?? []).map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Season start" required>
              <Input type="date" value={seasonStart} onChange={(e) => setSeasonStart(e.target.value)} className="text-base" />
            </Field>
            <Field label="Season end" required>
              <Input type="date" value={seasonEnd} onChange={(e) => setSeasonEnd(e.target.value)} className="text-base" />
            </Field>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Hours per week">
              <Input type="number" min={8} max={80} value={targetHours} onChange={(e) => setTargetHours(e.target.value)} className="text-base" />
            </Field>
            <Field label="Shift hours">
              <Input type="number" min={4} max={12} value={shiftHours} onChange={(e) => setShiftHours(e.target.value)} className="text-base" />
            </Field>
            <Field label="Reserve %">
              <Input type="number" min={0} max={100} value={reserve} onChange={(e) => setReserve(e.target.value)} className="text-base" />
            </Field>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={create.isPending}>Cancel</Button>
          <Button
            loading={create.isPending}
            disabled={!valid}
            onClick={() =>
              create.mutate({
                name: name.trim(),
                clientId: clientId || null,
                seasonStart,
                seasonEnd,
                targetHoursPerWeek: Number(targetHours) || 40,
                shiftHours: Number(shiftHours) || 8,
                reservePct: Number(reserve) || 0,
              })
            }
          >
            Create plan
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ============================================================ the plan */

function PlanView({ id }: { id: string }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const canManage = can('manage:org');
  const q = useQuery({ queryKey: ['season-plans', 'plan', id], queryFn: () => getSeasonPlan(id) });
  const plan = q.data;

  const save = useMutation({
    mutationFn: (body: SeasonPlanUpdate) => updateSeasonPlan(id, body),
    onSuccess: async (next) => {
      qc.setQueryData(['season-plans', 'plan', id], next);
      await qc.invalidateQueries({ queryKey: ['season-plans', 'list'] });
      toast.success('Saved. The numbers below are recomputed.');
    },
    onError: (err: unknown) => toast.error(err instanceof ApiError ? err.message : 'Could not save.'),
  });
  const duplicate = useMutation({
    mutationFn: (name: string) => duplicateSeasonPlan(id, name),
    onSuccess: async (copy) => {
      await qc.invalidateQueries({ queryKey: ['season-plans', 'list'] });
      toast.success(`Copied as “${copy.name}”.`);
      navigate(`/season-planner?plan=${copy.id}`);
    },
    onError: (err: unknown) => toast.error(err instanceof ApiError ? err.message : 'Could not copy.'),
  });

  const weekly = useMemo(() => (plan?.totals ?? []).map((t) => ({ ...t, label: weekLabel(t.week) })), [plan]);
  const vanSeats = useMemo(() => {
    const sites = plan?.sites ?? [];
    const needed = sites.reduce((a, s) => a + s.peak.vanSeatsNeeded, 0);
    const available = sites.reduce((a, s) => a + s.vanSeatsPerRun * s.runsPerShift, 0);
    return { needed, available, gap: sites.reduce((a, s) => a + Math.max(0, s.peak.vanSeatsNeeded - s.vanSeatsPerRun * s.runsPerShift), 0) };
  }, [plan]);
  const toRecruit = useMemo(() => (plan?.recruiting ?? []).reduce((a, r) => a + r.gap, 0), [plan]);

  if (q.isError) return <QueryError what="the season plan" query={q} />;

  return (
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    <ListTemplate
        title={plan?.name ?? 'Season plan'}
        subtitle={
          plan
            ? `${plan.clientName ?? 'Every client'} · ${fmtDate(plan.seasonStart)} – ${fmtDate(plan.seasonEnd)} · ${plan.weeks.length} weeks · ${plan.sites.length} stores`
            : undefined
        }
        topbarTitle="Season planner"
        breadcrumbs={[{ label: 'Season planner', to: '/season-planner' }, { label: plan?.name ?? '…' }]}
        secondaryActions={
          plan ? (
            <>
              <Button variant="outline" onClick={() => window.open(seasonPlanCsvUrl(plan.id), '_blank', 'noopener')}>
                <Download className="mr-2 h-4 w-4" aria-hidden="true" />
                CSV
              </Button>
              {canManage && (
                <Button
                  variant="outline"
                  loading={duplicate.isPending}
                  onClick={async () => {
                    const name = await prompt({
                      title: 'Copy this plan',
                      description: 'A copy to try a different idea on — the original stays as it is.',
                      reasonLabel: 'Name for the copy',
                      reasonPlaceholder: `${plan.name} — overnight-first`,
                      reasonMaxLength: 120,
                    });
                    if (name && name.trim().length >= 2) duplicate.mutate(name.trim());
                  }}
                >
                  <Copy className="mr-2 h-4 w-4" aria-hidden="true" />
                  Duplicate
                </Button>
              )}
              {canManage && !plan.archivedAt && (
                <Button
                  variant="ghost"
                  onClick={async () => {
                    if (await confirm({ title: `Archive “${plan.name}”?`, description: 'It leaves the list. Nothing else changes; it can be shown again with “Show archived”.' })) {
                      save.mutate({ archived: true });
                    }
                  }}
                >
                  Archive
                </Button>
              )}
            </>
          ) : undefined
        }
    >

      {q.isLoading || !plan ? (
        <Skeleton className="h-64" />
      ) : (
        <>
          {/* ---- the hero and three tiles --------------------------------- */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div className="col-span-2 lg:col-span-1">
              <MetricCard
                label="Associates needed at peak"
                value={String(plan.peak.associatesNeeded)}
                hint={`Week of ${weekLabel(plan.peak.week)} · ${num(plan.peak.daily)} on the floor a day · ${plan.targetHoursPerWeek} h weeks, ${plan.reservePct}% reserve`}
              />
            </div>
            <MetricCard
              label="Beds at peak"
              value={`${num(plan.peak.bedsNeeded)} / ${num(plan.peak.bedsAvailable)}`}
              hint={plan.peak.bedsGap > 0 ? `${num(plan.peak.bedsGap)} short` : 'needed / available — covered'}
              accent={plan.peak.bedsGap > 0}
            />
            <MetricCard
              label="Van seats per shift"
              value={`${num(vanSeats.needed)} / ${num(vanSeats.available)}`}
              hint={vanSeats.gap > 0 ? `${num(vanSeats.gap)} short across stores` : 'needed / carried — covered'}
              accent={vanSeats.gap > 0}
            />
            <MetricCard
              label="Still to recruit"
              value={String(toRecruit)}
              hint={toRecruit > 0 ? 'beyond who is on the books' : 'the pipeline covers the peak'}
              accent={toRecruit > 0}
            />
          </div>

          {/* ---- the live week: what-if against the calendar --------------- */}
          <LiveWhatIfCard planId={plan.id} weeks={plan.weeks} />

          {/* ---- week by week --------------------------------------------- */}
          {weekly.length === 0 ? (
            <Card>
              <CardContent>
                <EmptyState icon={CalendarRange} title="No weeks" description="The season dates do not cover a full org week." />
              </CardContent>
            </Card>
          ) : (
            // The kit chart in a ChartFrame (F500 G2): a legend-free single
            // series, its own Table / CSV view carrying every weekly figure.
            <ChartFrame
              title="Associates needed, week by week"
              description={`Across every store in the plan. Floor headcount × 7 days ÷ ${plan.targetHoursPerWeek / plan.shiftHours} shifts a person, plus ${plan.reservePct}% reserve.`}
              summary={`Peak: ${plan.peak.associatesNeeded} associates the week of ${weekLabel(plan.peak.week)}, over ${weekly.length} week${weekly.length === 1 ? '' : 's'}.`}
              csvName="season-plan-weeks"
              height={240}
              columns={WEEKLY_COLUMNS}
              rows={weekly}
            >
              <StackedBarChart
                data={weekly}
                x="label"
                series={[{ key: 'associatesNeeded', name: 'Associates' }]}
                heading={(l) => `Week of ${l}`}
              />
            </ChartFrame>
          )}

          {/* ---- gaps and recruiting -------------------------------------- */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card className={plan.gaps.length > 0 ? 'border-warning/60' : undefined}>
              <CardHeader>
                <CardTitle>Every shortfall, named</CardTitle>
                <CardDescription>{plan.gaps.length === 0 ? 'Nothing short with the inputs as entered.' : `${plan.gaps.length} gap${plan.gaps.length === 1 ? '' : 's'}, biggest first.`}</CardDescription>
              </CardHeader>
              <CardContent>
                {plan.gaps.length === 0 ? (
                  <EmptyState icon={BedDouble} title="No gaps" description="" />
                ) : (
                  <ol className="divide-y divide-navy-secondary">
                    {plan.gaps.map((g, i) => (
                      <li key={`${g.kind}-${g.siteName ?? 'all'}-${i}`} className="flex items-start gap-3 py-2 text-sm">
                        <Badge variant={GAP_BADGE[g.kind].variant}>{GAP_BADGE[g.kind].label}</Badge>
                        <span className="text-white/90">{g.text}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Recruiting targets</CardTitle>
                <CardDescription>The peak need split by channel, and the date each must be in hand.</CardDescription>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <DataGrid<SeasonRecruitingTarget>
                  id="season-recruiting"
                  caption="Recruiting targets by channel"
                  rows={plan.recruiting}
                  rowKey={(r) => r.channel}
                  search={false}
                  urlState={false}
                  columnChooser={false}
                  columns={[
                    { key: 'channel', header: 'Channel', accessor: (r) => r.label, sortable: false, primary: true },
                    { key: 'share', header: 'Share', accessor: (r) => r.sharePct, sortable: false, searchable: false, align: 'right', cell: (r) => `${r.sharePct}%`, className: 'text-silver' },
                    { key: 'target', header: 'Target', accessor: (r) => r.target, sortable: false, searchable: false, align: 'right', className: 'tabular-nums font-medium', cardMeta: true },
                    { key: 'pipeline', header: 'On the books', accessor: (r) => r.pipeline, sortable: false, searchable: false, align: 'right', className: 'tabular-nums' },
                    { key: 'gap', header: 'Gap', accessor: (r) => r.gap, sortable: false, searchable: false, align: 'right', cardMeta: true, cell: (r) => (r.gap > 0 ? <span className="text-alert">{r.gap}</span> : <span className="text-success">0</span>) },
                    { key: 'by', header: 'Recruit by', accessor: (r) => r.recruitBy, sortable: false, searchable: false, cell: (r) => fmtDate(r.recruitBy), className: 'text-silver' },
                  ]}
                />
              </CardContent>
            </Card>
          </div>

          {/* ---- the inputs ----------------------------------------------- */}
          <SitesEditor plan={plan} canManage={canManage} saving={save.isPending} onSave={(sites) => save.mutate({ sites })} />
          <PlanSettings plan={plan} canManage={canManage} saving={save.isPending} onSave={(body) => save.mutate(body)} />
        </>
      )}
    </ListTemplate>
  );
}

/* ------------------------------------------------------- sites editor */

type SiteDraft = SeasonPlanSiteInput & { siteName: string; clientName: string };

function draftsFrom(sites: SeasonPlanSiteComputed[], weeks: string[]): SiteDraft[] {
  return sites.map((s) => ({
    locationId: s.locationId,
    siteName: s.siteName,
    clientName: s.clientName,
    bedsAvailable: s.bedsAvailable,
    vanSeatsPerRun: s.vanSeatsPerRun,
    runsPerShift: s.runsPerShift,
    routeMinutes: s.routeMinutes,
    demand: weeks.map((week) => {
      const w = s.weeks.find((x) => x.week === week);
      return { week, day: w?.day ?? 0, evening: w?.evening ?? 0, overnight: w?.overnight ?? 0 };
    }),
    taskDemand: spreadLines(weeks, linesOf(s.taskDemand ?? [])),
  }));
}

function SitesEditor({ plan, canManage, saving, onSave }: { plan: SeasonPlanComputed; canManage: boolean; saving: boolean; onSave: (sites: SeasonPlanSiteInput[]) => void }) {
  const [drafts, setDrafts] = useState<SiteDraft[]>(() => draftsFrom(plan.sites, plan.weeks));
  const [dirty, setDirty] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  // A save (or a reload) brings fresh numbers; the draft follows them.
  useEffect(() => {
    setDrafts(draftsFrom(plan.sites, plan.weeks));
    setDirty(false);
  }, [plan]);

  const patch = (locationId: string, fn: (d: SiteDraft) => SiteDraft) => {
    setDrafts((prev) => prev.map((d) => (d.locationId === locationId ? fn(d) : d)));
    setDirty(true);
  };
  const setCell = (locationId: string, week: string, field: keyof SeasonDemandWeek, value: string) => {
    const n = Math.max(0, Math.min(2000, Math.floor(Number(value) || 0)));
    patch(locationId, (d) => ({ ...d, demand: d.demand.map((w) => (w.week === week ? { ...w, [field]: n } : w)) }));
  };
  const fillFromFirst = (locationId: string) => {
    patch(locationId, (d) => {
      const first = d.demand[0];
      if (!first) return d;
      return { ...d, demand: d.demand.map((w) => ({ ...w, day: first.day, evening: first.evening, overnight: first.overnight })) };
    });
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle>Demand by store</CardTitle>
            <CardDescription>People on the floor per shift, per day, for each week — and the beds and vans each store has.</CardDescription>
          </div>
          {canManage && (
            <Button onClick={() => onSave(drafts.map(({ siteName: _s, clientName: _c, ...rest }) => rest))} loading={saving} disabled={!dirty}>
              Save demand
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {drafts.map((d) => {
          const isOpen = open[d.locationId] ?? drafts.length === 1;
          const computed = plan.sites.find((s) => s.locationId === d.locationId);
          return (
            <details
              key={d.locationId}
              open={isOpen}
              onToggle={(e) => setOpen((prev) => ({ ...prev, [d.locationId]: (e.target as HTMLDetailsElement).open }))}
              className="rounded-md border border-navy-secondary"
            >
              <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <span className="font-medium text-white">
                  {d.siteName} <span className="text-silver">· {d.clientName}</span>
                </span>
                {computed && (
                  <span className="text-xs text-silver">
                    peak {num(computed.peak.daily)} a day → {num(computed.peak.associatesNeeded)} associates · beds {num(computed.peak.bedsNeeded)}/{num(d.bedsAvailable)}
                  </span>
                )}
              </summary>
              <div className="space-y-3 border-t border-navy-secondary p-3">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Field label="Beds available">
                    <Input type="number" min={0} max={5000} value={d.bedsAvailable} disabled={!canManage} className="text-base" onChange={(e) => patch(d.locationId, (x) => ({ ...x, bedsAvailable: Math.max(0, Number(e.target.value) || 0) }))} />
                  </Field>
                  <Field label="Seats per van run">
                    <Input type="number" min={0} max={200} value={d.vanSeatsPerRun} disabled={!canManage} className="text-base" onChange={(e) => patch(d.locationId, (x) => ({ ...x, vanSeatsPerRun: Math.max(0, Number(e.target.value) || 0) }))} />
                  </Field>
                  <Field label="Runs per shift">
                    <Input type="number" min={0} max={20} value={d.runsPerShift} disabled={!canManage} className="text-base" onChange={(e) => patch(d.locationId, (x) => ({ ...x, runsPerShift: Math.max(0, Number(e.target.value) || 0) }))} />
                  </Field>
                  <Field label="Route minutes">
                    <Input type="number" min={0} max={600} value={d.routeMinutes} disabled={!canManage} className="text-base" onChange={(e) => patch(d.locationId, (x) => ({ ...x, routeMinutes: Math.max(0, Number(e.target.value) || 0) }))} />
                  </Field>
                </div>
                <TaskDemandEditor
                  siteName={d.siteName}
                  lines={linesOf(d.taskDemand)}
                  disabled={!canManage}
                  onChange={(lines) => patch(d.locationId, (x) => ({ ...x, taskDemand: spreadLines(plan.weeks, lines) }))}
                />
                {computed && computed.weeks.some((w) => w.mix) && (
                  <p className="text-xs text-silver">
                    At peak: {mixLine(computed.weeks.find((w) => w.week === computed.peak.week)?.mix ?? computed.weeks.find((w) => w.mix)?.mix, computed.robotsPlaced)}
                  </p>
                )}
                <div className="flex items-center justify-between">
                  <span className="text-xs uppercase tracking-wide text-silver">Floor headcount per day</span>
                  {canManage && (
                    <Button variant="ghost" size="sm" onClick={() => fillFromFirst(d.locationId)}>
                      Fill all weeks from the first
                    </Button>
                  )}
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[520px] text-sm">
                    <thead>
                      <tr className="text-left text-xs uppercase tracking-wide text-silver">
                        <th className="py-1 pr-2">Week of</th>
                        <th className="py-1 pr-2">Day</th>
                        <th className="py-1 pr-2">Evening</th>
                        <th className="py-1 pr-2">Overnight</th>
                        <th className="py-1 pr-2 text-right">On floor</th>
                        <th className="py-1 text-right">Associates</th>
                        {computed?.weeks.some((w) => w.mix) && (
                          <>
                            <th className="py-1 pl-3 text-right">Robots</th>
                            <th className="py-1 pl-3 text-right">Backup</th>
                            <th className="py-1 pl-3 text-right">Labor $</th>
                            <th className="py-1 pl-3 text-right">Robot $</th>
                          </>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {d.demand.map((w) => {
                        const cw = computed?.weeks.find((x) => x.week === w.week);
                        return (
                          <tr key={w.week} className="border-t border-navy-secondary/60">
                            <td className="py-1 pr-2 whitespace-nowrap text-silver">{weekLabel(w.week)}</td>
                            {(['day', 'evening', 'overnight'] as const).map((field) => (
                              <td key={field} className="py-1 pr-2">
                                <Input
                                  type="number"
                                  inputMode="numeric"
                                  min={0}
                                  max={2000}
                                  aria-label={`${d.siteName} ${weekLabel(w.week)} ${field}`}
                                  value={w[field]}
                                  disabled={!canManage}
                                  className="h-9 w-20 text-base"
                                  onChange={(e) => setCell(d.locationId, w.week, field, e.target.value)}
                                />
                              </td>
                            ))}
                            <td className="py-1 pr-2 text-right tabular-nums">{num(w.day + w.evening + w.overnight)}</td>
                            <td className="py-1 text-right tabular-nums text-gold">{cw ? num(cw.associatesNeeded) : '—'}</td>
                            {computed?.weeks.some((x) => x.mix) && (
                              <>
                                <td className="py-1 pl-3 text-right tabular-nums">{cw?.mix ? num(cw.mix.robotsNeeded) : '—'}</td>
                                <td className="py-1 pl-3 text-right tabular-nums">{cw?.mix ? num(cw.mix.backupCrew) : '—'}</td>
                                <td className="py-1 pl-3 text-right tabular-nums">{cw?.mix ? fmtMoney(cw.mix.laborCostCents / 100) : '—'}</td>
                                <td className="py-1 pl-3 text-right tabular-nums">{cw?.mix ? fmtMoney(cw.mix.robotCostCents / 100) : '—'}</td>
                              </>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="flex justify-end">
                  <Button variant="outline" size="sm" onClick={() => window.open(seasonPlanSitePdfUrl(plan.id, d.locationId), '_blank', 'noopener')}>
                    <FileText className="mr-2 h-4 w-4" aria-hidden="true" />
                    Store plan PDF
                  </Button>
                </div>
              </div>
            </details>
          );
        })}
        {dirty && canManage && <p className="text-xs text-silver">Unsaved changes — the numbers above recompute when you save.</p>}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------ plan settings */

function ChannelFields({ label, hint, value, disabled, onChange, unit }: { label: string; hint?: string; value: ChannelPercent | ChannelWeeks; disabled: boolean; onChange: (next: ChannelPercent | ChannelWeeks) => void; unit: string }) {
  return (
    <div>
      <div className="mb-1 text-xs uppercase tracking-wide text-silver">{label}</div>
      {hint && <p className="mb-2 text-xs text-silver/80">{hint}</p>}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {RECRUITING_CHANNELS.map((c) => (
          <Field key={c} label={`${RECRUITING_CHANNEL_LABELS[c]} (${unit})`}>
            <Input type="number" min={0} max={unit === '%' ? 100 : 52} value={value[c]} disabled={disabled} className="text-base" onChange={(e) => onChange({ ...value, [c]: Math.max(0, Number(e.target.value) || 0) })} />
          </Field>
        ))}
      </div>
    </div>
  );
}

function PlanSettings({ plan, canManage, saving, onSave }: { plan: SeasonPlanComputed; canManage: boolean; saving: boolean; onSave: (body: SeasonPlanUpdate) => void }) {
  const [draft, setDraft] = useState<SeasonPlanUpdate>(() => settingsFrom(plan));
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    setDraft(settingsFrom(plan));
    setDirty(false);
  }, [plan]);
  const set = <K extends keyof SeasonPlanUpdate>(k: K, v: SeasonPlanUpdate[K]) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setDirty(true);
  };
  const mixTotal = RECRUITING_CHANNELS.reduce((a, c) => a + (draft.channelMix?.[c] ?? 0), 0);

  return (
    <details className="rounded-lg border border-navy-secondary bg-navy-surface/40">
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-white">Plan settings — hours, reserve, recruiting mix, housing and rides</summary>
      <div className="space-y-4 border-t border-navy-secondary p-4">
        <div className="grid grid-cols-3 gap-3">
          <Field label="Hours per week" hint="Target per associate.">
            <Input type="number" min={8} max={80} value={draft.targetHoursPerWeek ?? 40} disabled={!canManage} className="text-base" onChange={(e) => set('targetHoursPerWeek', Number(e.target.value) || 40)} />
          </Field>
          <Field label="Shift hours">
            <Input type="number" min={4} max={12} value={draft.shiftHours ?? 8} disabled={!canManage} className="text-base" onChange={(e) => set('shiftHours', Number(e.target.value) || 8)} />
          </Field>
          <Field label="Reserve %" hint="For call-outs and churn.">
            <Input type="number" min={0} max={100} value={draft.reservePct ?? 10} disabled={!canManage} className="text-base" onChange={(e) => set('reservePct', Number(e.target.value) || 0)} />
          </Field>
        </div>
        <ChannelFields
          label="Recruiting mix"
          hint={mixTotal === 100 ? 'Shares of the associates needed, by channel.' : `Shares add up to ${mixTotal}%, not 100% — targets are scaled to the total.`}
          value={draft.channelMix ?? plan.channelMix}
          disabled={!canManage}
          unit="%"
          onChange={(v) => set('channelMix', v as ChannelPercent)}
        />
        <ChannelFields label="Arrival lead time" hint="Weeks before the season start each channel must be recruited." value={draft.arrivalLeadWeeks ?? plan.arrivalLeadWeeks} disabled={!canManage} unit="weeks" onChange={(v) => set('arrivalLeadWeeks', v as ChannelWeeks)} />
        <ChannelFields label="Housing share" hint="Percent of each channel that needs a bed." value={draft.housingShare ?? plan.housingShare} disabled={!canManage} unit="%" onChange={(v) => set('housingShare', v as ChannelPercent)} />
        <ChannelFields label="Ride share" hint="Percent of each channel that rides the vans." value={draft.rideShare ?? plan.rideShare} disabled={!canManage} unit="%" onChange={(v) => set('rideShare', v as ChannelPercent)} />
        <Field label="Notes">
          <Textarea value={draft.notes ?? ''} disabled={!canManage} rows={3} maxLength={2000} onChange={(e) => set('notes', e.target.value)} />
        </Field>
        {canManage && (
          <div className="flex justify-end">
            <Button onClick={() => onSave(draft)} loading={saving} disabled={!dirty}>
              Save settings
            </Button>
          </div>
        )}
      </div>
    </details>
  );
}

function settingsFrom(plan: SeasonPlanComputed): SeasonPlanUpdate {
  return {
    targetHoursPerWeek: plan.targetHoursPerWeek,
    shiftHours: plan.shiftHours,
    reservePct: plan.reservePct,
    channelMix: plan.channelMix,
    arrivalLeadWeeks: plan.arrivalLeadWeeks,
    housingShare: plan.housingShare,
    rideShare: plan.rideShare,
    notes: plan.notes,
  };
}

/* ============================================================ compare */

function CompareView({ a, b }: { a: string; b: string }) {
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['season-plans', 'compare', a, b], queryFn: () => compareSeasonPlans(a, b) });
  const series = useMemo(() => {
    if (!q.data) return [];
    const weeks = [...new Set([...q.data.a.totals.map((t) => t.week), ...q.data.b.totals.map((t) => t.week)])].sort();
    return weeks.map((week) => ({
      label: weekLabel(week),
      week,
      a: q.data!.a.totals.find((t) => t.week === week)?.associatesNeeded ?? 0,
      b: q.data!.b.totals.find((t) => t.week === week)?.associatesNeeded ?? 0,
    }));
  }, [q.data]);

  if (q.isError) return <QueryError what="the comparison" query={q} />;

  const col = (p: SeasonPlanComputed) => {
    const seatGap = p.sites.reduce((acc, s) => acc + Math.max(0, s.peak.vanSeatsNeeded - s.vanSeatsPerRun * s.runsPerShift), 0);
    const recruit = p.recruiting.reduce((acc, r) => acc + r.gap, 0);
    return (
      <Card>
        <CardHeader>
          <CardTitle>{p.name}</CardTitle>
          <CardDescription>{p.clientName ?? 'Every client'} · {fmtDate(p.seasonStart)} – {fmtDate(p.seasonEnd)}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <MetricCard label="Associates at peak" value={String(p.peak.associatesNeeded)} hint={`Week of ${weekLabel(p.peak.week)} · ${num(p.peak.daily)} a day`} />
          <div className="grid grid-cols-3 gap-2">
            <MetricCard label="Beds short" value={String(p.peak.bedsGap)} hint={`${num(p.peak.bedsNeeded)} / ${num(p.peak.bedsAvailable)}`} accent={p.peak.bedsGap > 0} />
            <MetricCard label="Seats short" value={String(seatGap)} hint="across stores" accent={seatGap > 0} />
            <MetricCard label="To recruit" value={String(recruit)} hint="beyond the books" accent={recruit > 0} />
          </div>
          <p className="text-xs text-silver">
            {p.targetHoursPerWeek} h weeks · {p.shiftHours} h shifts · {p.reservePct}% reserve · mix {RECRUITING_CHANNELS.map((c) => `${p.channelMix[c]}%`).join(' / ')}
          </p>
          <Button variant="ghost" size="sm" onClick={() => navigate(`/season-planner?plan=${p.id}`)}>
            Open this plan
          </Button>
        </CardContent>
      </Card>
    );
  };

  return (
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    <ListTemplate
        title="Compare scenarios"
        subtitle={q.data ? `${q.data.a.name} vs ${q.data.b.name}` : undefined}
        topbarTitle="Season planner"
        breadcrumbs={[{ label: 'Season planner', to: '/season-planner' }, { label: 'Compare' }]}
        secondaryActions={
          <Button variant="ghost" onClick={() => navigate('/season-planner')}>
            <ArrowLeft className="mr-2 h-4 w-4" aria-hidden="true" />
            Back to plans
          </Button>
        }
    >
      {q.isLoading || !q.data ? (
        <Skeleton className="h-64" />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {col(q.data.a)}
            {col(q.data.b)}
          </div>
          <ChartFrame
            title="Associates needed, week by week"
            description="Both scenarios on the same weeks."
            summary={`${q.data.a.name} peaks at ${q.data.a.peak.associatesNeeded} associates; ${q.data.b.name} at ${q.data.b.peak.associatesNeeded}.`}
            csvName="season-plan-compare"
            height={260}
            columns={[
              { key: 'label', label: 'Week of' },
              { key: 'a', label: q.data.a.name, numeric: true },
              { key: 'b', label: q.data.b.name, numeric: true },
              { key: 'diff', label: 'Difference', numeric: true },
            ]}
            rows={series.map((s) => ({ ...s, diff: s.b - s.a }))}
          >
            {/* Two scenarios side by side, the kit's grouped columns with its legend. */}
            <StackedBarChart
              data={series}
              x="label"
              stacked={false}
              series={[
                { key: 'a', name: q.data.a.name },
                { key: 'b', name: q.data.b.name },
              ]}
              heading={(l) => `Week of ${l}`}
            />
          </ChartFrame>
        </>
      )}
    </ListTemplate>
  );
}
