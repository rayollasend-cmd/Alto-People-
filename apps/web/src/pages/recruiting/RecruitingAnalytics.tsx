import { useEffect, useState, type ReactNode } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { performWithUndo } from '@/lib/undoToast';
import { Trash2 } from 'lucide-react';
import type { RecruitingAnalytics as Analytics } from '@alto-people/shared';
type SourceRow = Analytics['sources'][number];
type ClientRow = Analytics['clients'][number];
type RetentionRow = Analytics['retention']['bySource'][number];
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtMoney, fmtPercent, ymdLocal } from '@/lib/format';
import {
  deleteSourceSpend,
  getRecruitingAnalytics,
  listSourceSpend,
  saveSourceSpend,
} from '@/lib/recruitingApi';
import {
  Button,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  ErrorBanner,
  Field,
  Input,
  MetricCard,
  SegmentedControl,
  Select,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui';
import { DataGrid } from '@/components/ui/DataGrid';
import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ChartFrame } from '@/components/ui/ChartFrame';
import { PALETTE, TICK, TOOLTIP_LABEL_STYLE, TOOLTIP_STYLE } from '@/components/ui/charts/palette';
import { ListTemplate } from '@/components/templates';
import { CANDIDATE_SOURCES, SOURCE_LABEL, STAGE_LABEL } from './recruitingLabels';

/**
 * Recruiting analytics: is the pipeline converting, how fast do roles
 * fill, where do hires come from and what do they cost, how do offers
 * land and how is each client's order filled — and do the people hired
 * stay. The last used to live only in the Retention analytics, cut by
 * store; here it is cut by the source a hire came from and by who hired
 * them, which is what a recruiter can act on.
 *
 * A handful of ratios read best as stat tiles and a dozen clients as rows;
 * the funnel and the sources are drawn — one hue, every bar labeled — each
 * with its table a click away (and always there for a screen reader).
 */

type Preset = '30d' | '90d' | '12m' | 'ytd';
const PRESETS: Array<{ value: Preset; label: string }> = [
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: '12m', label: '12 months' },
  { value: 'ytd', label: 'This year' },
];

function shift(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return ymdLocal(new Date(y, m - 1, d + days));
}

function rangeOf(preset: Preset, today: string): { from: string; to: string } {
  switch (preset) {
    case '30d':
      return { from: shift(today, -29), to: today };
    case '12m':
      return { from: shift(today, -364), to: today };
    case 'ytd':
      return { from: `${today.slice(0, 4)}-01-01`, to: today };
    default:
      return { from: shift(today, -89), to: today };
  }
}

const MARK = 'rgb(var(--color-chart-1))';
const TRACK = 'rgb(var(--color-chart-1) / 0.18)';

/** Sources are stored lowercased; a known one has its label, any other is capitalized. */
const sourceName = (s: string | null) =>
  s === null ? 'Not recorded' : (SOURCE_LABEL[s] ?? `${s.charAt(0).toUpperCase()}${s.slice(1)}`);
const days = (n: number | null) =>
  n === null ? '—' : n < 1 ? '< 1 day' : `${n} day${n === 1 ? '' : 's'}`;

/** A ratio against its whole: the unfilled track is the same hue, lighter. */
function Meter({ pct, label }: { pct: number | null; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? 0}
        className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full sm:w-24"
        style={{ background: TRACK }}
      >
        <div className="h-full rounded-full" style={{ width: `${pct ?? 0}%`, background: MARK }} />
      </div>
      <span className="tabular-nums text-white">{fmtPercent(pct)}</span>
    </div>
  );
}

function Section({ title, hint, action, children }: { title: string; hint?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <Card>
      <CardContent>
        <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-sm font-medium text-white">{title}</h2>
            {hint && <p className="mt-0.5 text-xs text-silver">{hint}</p>}
          </div>
          {action}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

function Funnel({ funnel }: { funnel: Analytics['funnel'] }) {
  const rows = funnel.stages.map((st, i) => {
    const next = funnel.stages[i + 1];
    return {
      step: STAGE_LABEL[st.stage],
      reached: st.reached,
      movedOn: next && st.toNextPct !== null ? `${fmtPercent(st.toNextPct)} to ${STAGE_LABEL[next.stage].toLowerCase()}` : '',
      label: `${st.reached}${next && st.toNextPct !== null ? ` · ${fmtPercent(st.toNextPct)} on` : ''}`,
    };
  });
  const hired = funnel.stages[funnel.stages.length - 1]?.reached ?? 0;
  return (
    <ChartFrame
      title="Funnel"
      description={
        <>
          Everyone who applied in the range, and how far they got. Of {funnel.applicants}: {funnel.inProgress} still in progress, {funnel.rejected} rejected, {funnel.withdrawn}{' '}
          withdrew.
        </>
      }
      summary={`${funnel.applicants} applied and ${hired} reached ${STAGE_LABEL[funnel.stages[funnel.stages.length - 1]?.stage ?? 'HIRED'].toLowerCase()}.`}
      csvName="hiring-funnel"
      height={Math.max(180, rows.length * 40)}
      columns={[
        { key: 'step', label: 'Step' },
        { key: 'reached', label: 'Reached', numeric: true },
        { key: 'movedOn', label: 'Moved on' },
      ]}
      rows={funnel.applicants === 0 ? [] : rows}
      empty={<p className="text-sm text-silver/70">No one applied in this range.</p>}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 96, bottom: 0, left: 0 }}>
          <XAxis type="number" hide domain={[0, 'dataMax']} />
          <YAxis type="category" dataKey="step" width={92} tick={TICK} tickLine={false} axisLine={false} />
          <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL_STYLE} cursor={{ fill: PALETTE.cursor }} />
          <Bar dataKey="reached" name="Reached" fill={PALETTE.series[0]} radius={[0, 3, 3, 0]} maxBarSize={22} isAnimationActive={false}>
            <LabelList dataKey="label" position="right" style={{ fill: TICK.fill, fontSize: 11 }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

/** Hires by source, and what each hire cost where spend was recorded — side by side. */
function SourceCharts({ sources }: { sources: SourceRow[] }) {
  const hires = sources
    .filter((r) => r.hires > 0 || r.applicants > 0)
    .map((r) => ({ source: sourceName(r.source), hires: r.hires, applicants: r.applicants }))
    .sort((a, b) => b.hires - a.hires || b.applicants - a.applicants);
  const cost = sources
    // A source with nothing spent has no cost to compare — its bar would read as "free".
    .filter((r) => r.costPerHire !== null && r.costPerHire > 0)
    .map((r) => ({ source: sourceName(r.source), costPerHire: r.costPerHire as number, hires: r.hires }))
    .sort((a, b) => b.costPerHire - a.costPerHire);
  if (hires.length === 0 && cost.length === 0) return null;
  const h = (n: number) => Math.max(140, n * 32 + 24);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {hires.length > 0 && (
        <ChartFrame
          title="Hires by source"
          summary={`${hires[0]!.source} brought the most hires: ${hires[0]!.hires}.`}
          csvName="hires-by-source"
          height={h(hires.length)}
          columns={[
            { key: 'source', label: 'Source' },
            { key: 'applicants', label: 'Applied', numeric: true },
            { key: 'hires', label: 'Hired', numeric: true },
          ]}
          rows={hires}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={hires} layout="vertical" margin={{ top: 0, right: 32, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={PALETTE.grid} horizontal={false} />
              <XAxis type="number" allowDecimals={false} tick={TICK} tickLine={false} axisLine={false} />
              <YAxis type="category" dataKey="source" width={110} tick={TICK} tickLine={false} axisLine={false} />
              <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL_STYLE} cursor={{ fill: PALETTE.cursor }} />
              <Bar dataKey="hires" name="Hired" fill={PALETTE.series[0]} radius={[0, 3, 3, 0]} maxBarSize={20}>
                <LabelList dataKey="hires" position="right" style={{ fill: TICK.fill, fontSize: 11 }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartFrame>
      )}
      {cost.length > 0 && (
        <ChartFrame
          title="Cost per hire, by source"
          description="Only sources with money spent and at least one hire."
          summary={cost.length > 1 ? `${cost[0]!.source} cost the most per hire: ${fmtMoney(cost[0]!.costPerHire)}.` : `${cost[0]!.source}: ${fmtMoney(cost[0]!.costPerHire)} per hire.`}
          csvName="cost-per-hire-by-source"
          height={h(cost.length)}
          columns={[
            { key: 'source', label: 'Source' },
            { key: 'hires', label: 'Hired', numeric: true },
            { key: 'costPerHire', label: 'Per hire', numeric: true, format: (v) => fmtMoney(v as number) },
          ]}
          rows={cost}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={cost} layout="vertical" margin={{ top: 0, right: 64, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={PALETTE.grid} horizontal={false} />
              <XAxis type="number" tick={TICK} tickLine={false} axisLine={false} tickFormatter={(v: number) => `$${v}`} />
              <YAxis type="category" dataKey="source" width={110} tick={TICK} tickLine={false} axisLine={false} />
              <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL_STYLE} cursor={{ fill: PALETTE.cursor }} formatter={(v) => fmtMoney(Number(v))} />
              <Bar dataKey="costPerHire" name="Per hire" fill={PALETTE.series[1]} radius={[0, 3, 3, 0]} maxBarSize={20}>
                <LabelList dataKey="costPerHire" position="right" formatter={(v: unknown) => fmtMoney(Number(v))} style={{ fill: TICK.fill, fontSize: 11 }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartFrame>
      )}
    </div>
  );
}

function SpendDialog({
  open,
  onOpenChange,
  seenSources,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Sources candidates actually came from, so a free-typed one ("job fair") can be priced too. */
  seenSources: string[];
}) {
  const queryClient = useQueryClient();
  const spend = useQuery({ queryKey: ['recruiting', 'source-spend'], queryFn: listSourceSpend, enabled: open });
  const [source, setSource] = useState<string>('indeed');
  const [month, setMonth] = useState(ymdLocal().slice(0, 7));
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  // Rows removed in the UI while their undo window is open.
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    if (!open) return;
    setAmount('');
    setNote('');
  }, [open]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['recruiting', 'source-spend'] });
    void queryClient.invalidateQueries({ queryKey: ['recruiting', 'analytics'] });
  };

  const save = async () => {
    const n = Number(amount);
    if (!amount.trim() || !Number.isFinite(n) || n < 0) {
      toast.error('Enter what it cost, in dollars.');
      return;
    }
    setBusy(true);
    try {
      await saveSourceSpend({ source, month, amount: n, note: note.trim() || null });
      toast.success(`Saved ${fmtMoney(n)} for ${sourceName(source)}, ${month}.`);
      setAmount('');
      setNote('');
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not save the spend.');
    } finally {
      setBusy(false);
    }
  };

  const remove = (row: { id: string; source: string; month: string }) => {
    setHiddenIds((prev) => new Set(prev).add(row.id));
    performWithUndo({
      message: `Removed ${sourceName(row.source)}, ${row.month}.`,
      onCommit: async () => {
        await deleteSourceSpend(row.id);
        refresh();
      },
      onUndo: () =>
        setHiddenIds((prev) => {
          const next = new Set(prev);
          next.delete(row.id);
          return next;
        }),
      commitFailedMessage: `Couldn't remove ${sourceName(row.source)}, ${row.month}.`,
    });
  };

  const rows = (spend.data?.spend ?? []).filter((r) => !hiddenIds.has(r.id));
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>What each source cost</DialogTitle>
          <DialogDescription>
            Job-board fees, sponsored posts, agency invoices, referral bonuses — one amount per source per month. Saving
            a month again replaces it.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Source" required>
            {(p) => (
              <Select {...p} value={source} onChange={(e) => setSource(e.target.value)}>
                {[...new Set<string>([...CANDIDATE_SOURCES, ...seenSources])].map((s) => (
                  <option key={s} value={s}>
                    {sourceName(s)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Month" required>
            {(p) => <Input {...p} type="month" value={month} onChange={(e) => setMonth(e.target.value)} />}
          </Field>
          <Field label="Amount (USD)" required>
            {(p) => (
              <Input {...p} type="number" inputMode="decimal" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
            )}
          </Field>
          <Field label="Note">
            {(p) => <Input {...p} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />}
          </Field>
        </div>
        {rows.length > 0 && (
          <div className="max-h-56 overflow-y-auto rounded-md border border-navy-secondary">
            <Table caption="Recorded spend">
              <TableHeader>
                <TableRow>
                  <TableHead>Month</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="w-10"><span className="sr-only">Remove</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="tabular-nums">{r.month}</TableCell>
                    <TableCell>
                      {sourceName(r.source)}
                      {r.note && <div className="text-2xs text-silver">{r.note}</div>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{fmtMoney(r.amount)}</TableCell>
                    <TableCell>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`Remove ${sourceName(r.source)} ${r.month}`}
                        onClick={() => remove(r)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Done
          </Button>
          <Button onClick={() => void save()} loading={busy} disabled={busy || !amount.trim()}>
            Save spend
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RecruitingAnalytics() {
  const { can } = useAuth();
  const canManage = can('manage:recruiting');
  const [searchParams, setSearchParams] = useSearchParams();
  const preset = (PRESETS.some((p) => p.value === searchParams.get('range')) ? searchParams.get('range') : '90d') as Preset;
  const range = rangeOf(preset, ymdLocal());
  const [spendOpen, setSpendOpen] = useState(false);

  const q = useQuery({
    queryKey: ['recruiting', 'analytics', range],
    queryFn: () => getRecruitingAnalytics(range),
    placeholderData: keepPreviousData,
  });
  const data = q.data;

  const setPreset = (p: Preset) => {
    const next = new URLSearchParams(searchParams);
    if (p === '90d') next.delete('range');
    else next.set('range', p);
    setSearchParams(next, { replace: true });
  };

  return (
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    <ListTemplate
        className="mx-auto max-w-6xl"
        title="Recruiting analytics"
        subtitle="How the pipeline converts, how fast roles fill, what each source costs, and who stays."
        // The trail names this page (it published "Recruiting" to the top
        // bar) and is the way back; the "← Pipeline" button was a second.
        breadcrumbs={[{ label: 'Recruiting', to: '/recruiting' }, { label: 'Recruiting analytics' }]}
    >

      <div className="flex flex-wrap items-center justify-between gap-2">
        <SegmentedControl options={PRESETS} value={preset} onChange={setPreset} ariaLabel="Date range" />
        <span className="text-xs text-silver tabular-nums">
          {fmtDate(range.from)} – {fmtDate(range.to)}
        </span>
      </div>

      {q.isError && !data ? (
        <ErrorBanner
          action={
            <Button size="sm" variant="secondary" onClick={() => void q.refetch()}>
              Retry
            </Button>
          }
        >
          {q.error instanceof ApiError ? q.error.message : 'Could not load recruiting analytics.'}
        </ErrorBanner>
      ) : !data ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
          <Skeleton className="h-64" />
        </div>
      ) : (
        <div className={q.isFetching ? 'space-y-4 opacity-70 transition-opacity' : 'space-y-4 transition-opacity'}>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <MetricCard label="Hires" value={data.speed.hires} hint={`${data.funnel.applicants} applied in this range`} />
            <MetricCard label="Median time to hire" value={days(data.speed.medianDaysToHire)} hint="Application to hire" />
            <MetricCard
              label="Median time to fill"
              value={days(data.speed.medianDaysToFill)}
              hint={
                data.speed.postingsFilled
                  ? `Posting opened to last opening filled · ${data.speed.postingsFilled} filled`
                  : 'No postings filled in this range'
              }
            />
            <MetricCard
              label="Offer acceptance"
              value={fmtPercent(data.offers.acceptancePct)}
              hint={`${data.offers.accepted} accepted · ${data.offers.declined} declined · ${data.offers.expired} lapsed`}
            />
            <MetricCard
              label="Fill rate"
              value={fmtPercent(data.fill.fillRatePct)}
              hint={data.fill.openings ? `${data.fill.filled} of ${data.fill.openings} openings filled` : 'No postings opened in this range'}
            />
            <MetricCard
              label="Cost per hire"
              value={data.costPerHire === null ? '—' : fmtMoney(data.costPerHire)}
              hint={data.spendTotal === null ? 'No source spend recorded' : `${fmtMoney(data.spendTotal)} spent`}
            />
            <MetricCard
              label="Stayed 90 days"
              value={fmtPercent(data.retention.overall.stayedPct)}
              hint={
                data.retention.overall.hires
                  ? `${data.retention.overall.stayed} of ${data.retention.overall.hires} hires measured`
                  : 'No hires have had 90 days yet'
              }
            />
            <MetricCard
              label="Still deciding"
              value={data.funnel.inProgress}
              hint="Applicants from this range still in the pipeline"
            />
          </div>

          <div className="grid gap-4 2xl:grid-cols-5">
            <div className="2xl:col-span-2">
              <Funnel funnel={data.funnel} />
            </div>
            <div className="min-w-0 2xl:col-span-3">
              <Section
                title="Where hires come from"
                hint="Spend counts every month the range touches."
                action={
                  canManage ? (
                    <Button size="sm" variant="outline" onClick={() => setSpendOpen(true)}>
                      Record spend
                    </Button>
                  ) : null
                }
              >
                {data.sources.length === 0 ? (
                  <p className="text-sm text-silver/70">No applicants, hires or spend in this range.</p>
                ) : (
                  <DataGrid<SourceRow>
                    id="recruiting-sources"
                    caption="Where hires come from"
                    rows={data.sources}
                    rowKey={(r) => r.source ?? 'none'}
                    search={false}
                    urlState={false}
                    columnChooser={false}
                    exportCsv={{ filename: `hires-by-source-${range.from}-to-${range.to}` }}
                    columns={[
                      { key: 'source', header: 'Source', accessor: (r) => sourceName(r.source), primary: true, sortable: true, className: 'text-white' },
                      { key: 'applicants', header: 'Applied', accessor: (r) => r.applicants, align: 'right', sortable: true, className: 'tabular-nums' },
                      { key: 'hires', header: 'Hired', accessor: (r) => r.hires, align: 'right', sortable: true, className: 'tabular-nums' },
                      { key: 'conv', header: 'Applied → hired', accessor: (r) => r.applicantToHirePct, align: 'right', sortable: true, className: 'tabular-nums', cell: (r) => fmtPercent(r.applicantToHirePct) },
                      { key: 'spend', header: 'Spend', accessor: (r) => r.spend, align: 'right', sortable: true, className: 'tabular-nums', cell: (r) => (r.spend === null ? '—' : fmtMoney(r.spend)) },
                      {
                        key: 'cph',
                        header: 'Per hire',
                        accessor: (r) => r.costPerHire,
                        align: 'right',
                        sortable: true,
                        className: 'tabular-nums',
                        cell: (r) => (r.costPerHire !== null ? fmtMoney(r.costPerHire) : r.spend !== null ? 'No hires' : '—'),
                      },
                    ]}
                  />
                )}
              </Section>
            </div>
          </div>

          <SourceCharts sources={data.sources} />

          <Section
            title="By client"
            hint="Offer acceptance counts declined and lapsed offers. Fill rate is hires against the openings on postings opened in the range."
          >
            {data.clients.length === 0 ? (
              <p className="text-sm text-silver/70">No hires, offers or postings for a client in this range.</p>
            ) : (
              <DataGrid<ClientRow>
                id="recruiting-clients"
                caption="By client"
                rows={data.clients}
                rowKey={(c) => c.clientId}
                search={false}
                urlState={false}
                columnChooser={false}
                exportCsv={{ filename: `recruiting-by-client-${range.from}-to-${range.to}` }}
                columns={[
                  { key: 'client', header: 'Client', accessor: (c) => c.clientName, primary: true, sortable: true, className: 'text-white' },
                  { key: 'hires', header: 'Hires', accessor: (c) => c.hires, align: 'right', sortable: true, className: 'tabular-nums' },
                  {
                    key: 'acceptance',
                    header: 'Offer acceptance',
                    accessor: (c) => c.offerAcceptancePct,
                    csv: (c) => (c.offersDecided ? `${c.offerAcceptancePct}% (${c.offersAccepted} of ${c.offersDecided})` : ''),
                    sortable: true,
                    cell: (c) =>
                      c.offersDecided ? (
                        <div>
                          <Meter pct={c.offerAcceptancePct} label={`${c.clientName} offer acceptance`} />
                          <div className="text-2xs text-silver tabular-nums">
                            {c.offersAccepted} of {c.offersDecided}
                          </div>
                        </div>
                      ) : (
                        <span className="text-silver">—</span>
                      ),
                  },
                  {
                    key: 'fill',
                    header: 'Fill rate',
                    accessor: (c) => c.fillRatePct,
                    csv: (c) => (c.openings ? `${c.fillRatePct}% (${c.filled} of ${c.openings})` : ''),
                    sortable: true,
                    cell: (c) =>
                      c.openings ? (
                        <div>
                          <Meter pct={c.fillRatePct} label={`${c.clientName} fill rate`} />
                          <div className="text-2xs text-silver tabular-nums">
                            {c.filled} of {c.openings} openings
                          </div>
                        </div>
                      ) : (
                        <span className="text-silver">—</span>
                      ),
                  },
                  {
                    key: 'ttf',
                    header: 'Median time to fill',
                    accessor: (c) => c.medianDaysToFill,
                    align: 'right',
                    sortable: true,
                    className: 'tabular-nums',
                    cell: (c) => days(c.medianDaysToFill),
                  },
                ]}
              />
            )}
          </Section>

          <Section
            title="Who stays 90 days"
            hint={
              <>
                People hired {fmtDate(data.retention.window.from)} – {fmtDate(data.retention.window.to)}: the latest 12
                months that have had 90 days, whatever the range above. Stayed means not separated, or separated 90 or
                more days after their hire date.
              </>
            }
          >
            {data.retention.overall.hires === 0 ? (
              <EmptyState size="sm" title="No one hired through recruiting in that window has had 90 days yet." />
            ) : (
              <div className="grid gap-4 md:grid-cols-2">
                {(
                  [
                    ['By source', data.retention.bySource, (k: string | null) => sourceName(k)],
                    ['By who hired them', data.retention.byRecruiter, (_k: string | null, label: string) => label],
                  ] as const
                ).map(([title, rows, name]) => (
                  <div key={title} className="min-w-0">
                    <h3 className="mb-1 text-2xs uppercase tracking-widest text-silver">{title}</h3>
                    <DataGrid<RetentionRow>
                      id={`recruiting-retention-${title === 'By source' ? 'source' : 'recruiter'}`}
                      caption={`Stayed 90 days, ${title.toLowerCase()}`}
                      rows={rows}
                      rowKey={(r) => r.key ?? 'none'}
                      search={false}
                      urlState={false}
                      columnChooser={false}
                      exportCsv={false}
                      columns={[
                        { key: 'name', header: title === 'By source' ? 'Source' : 'Hired by', accessor: (r) => name(r.key, r.label), primary: true, sortable: true, className: 'text-white' },
                        { key: 'hires', header: 'Hires', accessor: (r) => r.hires, align: 'right', sortable: true, className: 'tabular-nums' },
                        {
                          key: 'stayed',
                          header: 'Stayed',
                          accessor: (r) => r.stayedPct,
                          sortable: true,
                          cell: (r) => (
                            <div>
                              <Meter pct={r.stayedPct} label={`${name(r.key, r.label)} stayed 90 days`} />
                              <div className="text-2xs text-silver tabular-nums">
                                {r.stayed} of {r.hires}
                              </div>
                            </div>
                          ),
                        },
                      ]}
                    />
                  </div>
                ))}
              </div>
            )}
          </Section>
        </div>
      )}

      {canManage && (
        <SpendDialog
          open={spendOpen}
          onOpenChange={setSpendOpen}
          seenSources={(data?.sources ?? []).flatMap((s) => (s.source ? [s.source] : []))}
        />
      )}
    </ListTemplate>
  );
}
