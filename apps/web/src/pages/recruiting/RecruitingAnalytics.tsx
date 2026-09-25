import { useEffect, useState, type ReactNode } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, Trash2 } from 'lucide-react';
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
  ErrorBanner,
  Field,
  Input,
  MetricCard,
  PageHeader,
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
import { CANDIDATE_SOURCES, SOURCE_LABEL, STAGE_LABEL } from './recruitingLabels';

/**
 * Recruiting analytics: is the pipeline converting, how fast do roles
 * fill, where do hires come from and what do they cost, how do offers
 * land and how is each client's order filled — and do the people hired
 * stay. The last used to live only in the Retention analytics, cut by
 * store; here it is cut by the source a hire came from and by who hired
 * them, which is what a recruiter can act on.
 *
 * Mostly numbers and tables on purpose: a handful of ratios read best as
 * stat tiles, and seven sources or a dozen clients as rows. The funnel is
 * the one ordered series, drawn as one-hue bars with every step labeled.
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
      <CardContent className="p-4 md:p-5">
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
  if (funnel.applicants === 0) return <p className="text-sm text-silver/70">No one applied in this range.</p>;
  const top = funnel.stages[0]!.reached;
  return (
    <>
      <ol aria-label="Hiring funnel" className="space-y-3">
        {funnel.stages.map((s, i) => {
          const next = funnel.stages[i + 1];
          return (
            <li key={s.stage}>
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="text-white">{STAGE_LABEL[s.stage]}</span>
                <span className="tabular-nums text-white">{s.reached}</span>
              </div>
              <div
                aria-hidden="true"
                className="mt-1 h-2.5 rounded-r"
                style={{ width: `${top ? Math.max((s.reached / top) * 100, s.reached ? 1 : 0) : 0}%`, background: MARK }}
              />
              {next && s.toNextPct !== null && (
                <p className="mt-1 text-2xs text-silver">
                  {fmtPercent(s.toNextPct)} moved on to {STAGE_LABEL[next.stage].toLowerCase()}
                </p>
              )}
            </li>
          );
        })}
      </ol>
      <p className="mt-3 text-xs text-silver">
        Of {funnel.applicants}: {funnel.inProgress} still in progress, {funnel.rejected} rejected, {funnel.withdrawn}{' '}
        withdrew.
      </p>
    </>
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

  const remove = async (id: string) => {
    try {
      await deleteSourceSpend(id);
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not remove it.');
    }
  };

  const rows = spend.data?.spend ?? [];
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
                        onClick={() => void remove(r.id)}
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
    <div className="mx-auto max-w-6xl space-y-4">
      <PageHeader
        title="Recruiting analytics"
        subtitle="How the pipeline converts, how fast roles fill, what each source costs, and who stays."
        breadcrumbs={[{ label: 'Recruiting', to: '/recruiting' }]}
        secondaryActions={
          <Button asChild variant="ghost" size="sm">
            <Link to="/recruiting">
              <ArrowLeft className="h-3.5 w-3.5" />
              Pipeline
            </Link>
          </Button>
        }
      />

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
              <Section title="Funnel" hint="Everyone who applied in the range, and how far they got.">
                <Funnel funnel={data.funnel} />
              </Section>
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
              <p className="text-sm text-silver/70">No one hired through recruiting in that window has had 90 days yet.</p>
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
    </div>
  );
}
