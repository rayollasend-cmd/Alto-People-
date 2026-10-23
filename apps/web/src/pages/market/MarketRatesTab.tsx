import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PALETTE, StackedBarChart } from '@/components/ui/charts';
import { Gauge, MapPinned } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useAuth, useTerm } from '@/lib/auth';
import { getMarketRates, setClientMargin, type MarketRow } from '@/lib/marketRatesApi';
import { upsertRateDefault } from '@/lib/schedulingApi';
import { useClients } from '@/lib/useClients';
import { useStoreScope } from '@/lib/storeScope';
import { useUrlParam } from '@/lib/useUrlState';
import { FilterBar } from '@/components/ui/FilterBar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { ChartFrame } from '@/components/ui/ChartFrame';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { QueryError } from '@/components/ui/QueryError';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { MarketRange, money, ordinal } from './MarketRange';

/**
 * Every store-role against its metro: the market's spread with our pay on
 * it, the gap to the median, the bill rate and its markup, the store's own
 * fill over 90 days, and what to do — raise to the median (with the bill
 * rate that keeps the margin), or hold. "Propose" sends the rate through
 * the dated rate card and its approval; nothing changes from here directly.
 */

const pct = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `${Math.round(x * 100)}%`);
const BAND_LABEL = { below: 'Below the median', at: 'At the median', above: 'Above the median' } as const;
const MARGIN_SOURCE = { target: 'the client’s target margin', current: 'today’s margin on this rate', default: 'the default margin' } as const;

export function MarketRatesTab({ onOpenMapping }: { onOpenMapping: () => void }) {
  const { can } = useAuth();
  const term = useTerm();
  const qc = useQueryClient();
  const canManage = can('manage:clients') || can('process:payroll');
  const canPropose = can('manage:scheduling');
  const { clients } = useClients();
  // The client follows the top bar until someone picks one here ('all' =
  // every client on purpose); store and role are filters. All in the URL.
  const scope = useStoreScope();
  const [clientParam, setClientParam] = useUrlParam<string>('client', '');
  const [siteId, setSiteId] = useUrlParam<string>('store', '');
  const [position, setPosition] = useUrlParam<string>('role', '');
  const clientId = clientParam === 'all' ? '' : clientParam || scope.clientId;
  const setClientId = (id: string) => setClientParam(id === '' ? (scope.clientId ? 'all' : '') : id === scope.clientId ? '' : id);

  const q = useQuery({ queryKey: ['market', 'rates', clientId], queryFn: () => getMarketRates({ clientId: clientId || undefined }) });
  const all = useMemo(() => q.data?.rows ?? [], [q.data]);
  const stores = useMemo(() => [...new Map(all.map((r) => [r.siteId, r.siteName])).entries()].sort((a, b) => a[1].localeCompare(b[1])), [all]);
  const roles = useMemo(() => [...new Set(all.map((r) => r.position))].sort(), [all]);
  const rows = useMemo(() => all.filter((r) => (!siteId || r.siteId === siteId) && (!position || r.position === position)), [all, siteId, position]);

  const propose = useMutation({
    mutationFn: (r: MarketRow) => upsertRateDefault({ clientId: r.clientId, position: r.position, payRate: r.recommendation!.payRate, billRate: r.recommendation!.billRate }),
    onSuccess: (res, r) => {
      const pending = (res as unknown as { pending?: boolean }).pending;
      toast.success(pending ? `${r.position} at ${r.clientName}: sent for a second person to approve.` : `${r.position} at ${r.clientName}: new rate card in force.`);
      void qc.invalidateQueries({ queryKey: ['market'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not propose the rate.'),
  });

  const chartRows = useMemo(() => {
    const titles = new Map(all.filter((r) => r.soc).map((r) => [r.soc!.code, r.soc!.title]));
    return Object.entries(q.data?.bands ?? {})
      .map(([code, bands]) => {
        const by = Object.fromEntries(bands.map((b) => [b.band, b]));
        return {
          occupation: titles.get(code) ?? code,
          below: by.below?.fillRate ?? null,
          at: by.at?.fillRate ?? null,
          above: by.above?.fillRate ?? null,
          shifts: bands.reduce((t, b) => t + b.shifts, 0),
        };
      })
      .filter((r) => r.shifts > 0);
  }, [q.data, all]);

  const columns: GridColumn<MarketRow>[] = [
    { key: 'store', header: term('label.store'), accessor: (r) => r.siteName, primary: true, cell: (r) => <span className="font-medium text-ink">{r.siteName}</span> },
    { key: 'client', header: term('label.client'), accessor: (r) => r.clientName, cardMeta: true },
    { key: 'role', header: 'Role', accessor: (r) => r.position, cardMeta: true },
    {
      key: 'pay',
      header: 'Pay',
      accessor: (r) => r.payRate,
      align: 'right',
      className: 'tabular-nums',
      cell: (r) => (
        <div className="text-right">
          <div className="text-ink">{money(r.payRate)}</div>
          {r.percentile !== null && <div className="text-2xs text-ink-muted">{ordinal(r.percentile)} percentile</div>}
        </div>
      ),
    },
    {
      key: 'market',
      header: 'Market',
      accessor: (r) => r.market?.median ?? null,
      width: '14rem',
      searchable: false,
      csv: (r) => (r.market ? `${money(r.market.p10)}–${money(r.market.p90)} (median ${money(r.market.median)})` : ''),
      cell: (r) =>
        r.market ? (
          <MarketRange market={r.market} pay={r.payRate} percentile={r.percentile} />
        ) : (
          <span className="text-xs text-ink-muted">{!r.area ? 'Metro not set' : !r.soc ? 'Role not mapped' : 'No figures yet'}</span>
        ),
    },
    {
      key: 'gap',
      header: 'Gap',
      accessor: (r) => r.gapToMedian,
      align: 'right',
      className: 'tabular-nums',
      cell: (r) =>
        r.gapToMedian === null ? (
          '—'
        ) : r.gapToMedian > 0.25 ? (
          <span className="text-warning">{money(r.gapToMedian)} under</span>
        ) : r.gapToMedian < -0.25 ? (
          <span className="text-success">{money(-r.gapToMedian)} over</span>
        ) : (
          <span className="text-ink-muted">At median</span>
        ),
    },
    {
      key: 'bill',
      header: 'Bill rate',
      accessor: (r) => r.billRate,
      align: 'right',
      className: 'tabular-nums',
      cell: (r) => (
        <div className="text-right">
          <div className="text-ink">{money(r.billRate)}</div>
          {r.markupPct !== null && <div className="text-2xs text-ink-muted">{r.markupPct}% markup</div>}
        </div>
      ),
    },
    {
      key: 'fill',
      header: 'Fill',
      accessor: (r) => r.fill.fillRate,
      align: 'right',
      className: 'tabular-nums',
      cell: (r) => (r.fill.shifts ? <span title={`${r.fill.filled} of ${r.fill.shifts} shifts had someone`}>{pct(r.fill.fillRate)}</span> : <span className="text-ink-muted">No shifts</span>),
    },
    {
      key: 'next',
      header: 'Suggested',
      accessor: (r) => r.recommendation?.payRate ?? null,
      csv: (r) => r.recommendation?.reason ?? '',
      cell: (r) =>
        !r.recommendation ? (
          <span className="text-xs text-ink-muted">—</span>
        ) : r.recommendation.payRate > r.payRate ? (
          <div className="text-sm">
            <span className="text-ink">Pay {money(r.recommendation.payRate)}</span>
            <span className="text-ink-muted"> · bill {money(r.recommendation.billRate)}</span>
          </div>
        ) : (
          <Badge variant="success" size="sm">
            Hold
          </Badge>
        ),
    },
  ];

  const summary = q.data?.summary;
  const avg = summary?.avgRatioToMedian;
  const nothingMapped = q.data && q.data.rows.length > 0 && summary!.priced === 0;

  return (
    <div className="space-y-5">
      <FilterBar urlKey={['client', 'store', 'role']} onClearFilters={() => { setClientParam(''); setSiteId(''); setPosition(''); }} actions={clientId && canManage ? <MarginControl clientId={clientId} /> : undefined}>
        <Field label={term('label.client')} className="w-full md:w-56">
          {(p) => (
            <Select {...p} value={clientId} onChange={(e) => { setClientId(e.target.value); setSiteId(''); }}>
              <option value="">Every {term('label.client').toLowerCase()}</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={term('label.store')} className="w-full md:w-56">
          {(p) => (
            <Select {...p} value={siteId} onChange={(e) => setSiteId(e.target.value)} disabled={stores.length === 0}>
              <option value="">Every {term('label.store').toLowerCase()}</option>
              {stores.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Role" className="w-full md:w-48">
          {(p) => (
            <Select {...p} value={position} onChange={(e) => setPosition(e.target.value)} disabled={roles.length === 0}>
              <option value="">Every role</option>
              {roles.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </FilterBar>

      {q.isError ? (
        <QueryError what="market rates" query={q} />
      ) : q.isLoading || !q.data ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-28" />
            ))}
          </div>
          <Skeleton className="h-72" />
        </div>
      ) : q.data.rows.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={Gauge}
              title="No rates to compare yet"
              description={`Market rates read each ${term('label.client').toLowerCase()}’s rate card. Once a ${term('label.store').toLowerCase()} has pay rates on file for its roles, they appear here against the local market.`}
            />
          </CardContent>
        </Card>
      ) : (
        <>
          <MetricStrip label="Pay against the market">
            <MetricCard label="Roles priced" value={summary!.priced} hint={`of ${summary!.rows} store roles`} />
            <MetricCard label="Below the metro median" value={summary!.belowMedian} hint="By more than 25¢ an hour" tone={summary!.belowMedian > 0 ? 'warning' : 'default'} />
            <MetricCard
              label="Pay against the market"
              value={avg === null || avg === undefined ? '—' : `${avg >= 1 ? '+' : '−'}${Math.abs(Math.round((avg - 1) * 100))}%`}
              hint={avg === null || avg === undefined ? 'Nothing priced yet' : avg >= 1 ? 'Above metro medians, on average' : 'Below metro medians, on average'}
            />
            <MetricCard label="Not mapped yet" value={summary!.unmapped} hint={summary!.unmapped ? 'Need a metro or an occupation' : undefined} onClick={summary!.unmapped ? onOpenMapping : undefined} nothing={summary!.unmapped ? undefined : 'Every role is benchmarked'} />
          </MetricStrip>

          {nothingMapped && (
            <ErrorBanner
              severity="info"
              action={
                <Button size="sm" variant="outline" onClick={onOpenMapping}>
                  <MapPinned className="h-3.5 w-3.5" aria-hidden="true" />
                  Map them
                </Button>
              }
            >
              Nothing is benchmarked yet. Give each {term('label.store').toLowerCase()} its metro and each role its occupation — most are suggested for you.
            </ErrorBanner>
          )}
          {q.data.truncated && <ErrorBanner severity="warning">Showing the first 1,000 {term('label.stores').toLowerCase()}. Pick a {term('label.client').toLowerCase()} to see the rest.</ErrorBanner>}

          <ChartFrame
            title="Fill at each pay level"
            description={`Across the company, by occupation: the share of scheduled shifts that had someone, where you pay below, at or above the metro median. Last 90 days.`}
            summary={chartRows.length ? chartRows.map((r) => `${r.occupation}: ${pct(r.below)} filled below the median, ${pct(r.at)} at it, ${pct(r.above)} above`).join('. ') : 'No shifts yet to compare.'}
            columns={[
              { key: 'occupation', label: 'Occupation' },
              { key: 'below', label: BAND_LABEL.below, numeric: true, format: (v) => pct(v as number | null) },
              { key: 'at', label: BAND_LABEL.at, numeric: true, format: (v) => pct(v as number | null) },
              { key: 'above', label: BAND_LABEL.above, numeric: true, format: (v) => pct(v as number | null) },
              { key: 'shifts', label: 'Shifts', numeric: true },
            ]}
            rows={chartRows}
            csvName="fill-by-pay-level"
            height={Math.max(160, chartRows.length * 64 + 48)}
            empty={<p className="text-sm text-ink-muted">Once benchmarked roles have shifts, fill at each pay level shows here.</p>}
          >
            {/* Bars run sideways so an occupation reads in full ("Maids and Housekeeping Cleaners"), never "Maids…". */}
            <StackedBarChart
              data={chartRows}
              x="occupation"
              layout="horizontal"
              stacked={false}
              format={(v) => pct(v)}
              height={Math.max(160, chartRows.length * 64 + 48)}
              series={[
                { key: 'below', name: BAND_LABEL.below, color: PALETTE.warn },
                { key: 'at', name: BAND_LABEL.at, color: PALETTE.primary },
                { key: 'above', name: BAND_LABEL.above, color: PALETTE.good },
              ]}
            />
          </ChartFrame>

          <DataGrid
            id="market-rates"
            caption="Pay against the local market, by store and role"
            rows={rows}
            columns={columns}
            rowKey={(r) => r.key}
            noun={{ one: 'store role', many: 'store roles' }}
            exportCsv={{ filename: 'market-rates' }}
            search={{ placeholder: `Find a ${term('label.store').toLowerCase()} or role` }}
            defaultSort={{ key: 'gap', direction: 'desc' }}
            expandable={{
              label: (r) => `Details for ${r.position} at ${r.siteName}`,
              render: (r) => <RowDetail row={r} canPropose={canPropose} onPropose={() => propose.mutate(r)} busy={propose.isPending && propose.variables?.key === r.key} />,
            }}
          />
          <p className="text-2xs text-ink-muted">
            Gap is pay against the metro median; fill is the share of shifts with someone, last 90 days. Market figures: U.S. Bureau of Labor Statistics, Occupational Employment and Wage Statistics — hourly wages by metro area and occupation
            {all.find((r) => r.market)?.market?.year ? `, ${all.find((r) => r.market)!.market!.year} survey` : ''}.
          </p>
        </>
      )}
    </div>
  );
}

function RowDetail({ row, canPropose, onPropose, busy }: { row: MarketRow; canPropose: boolean; onPropose: () => void; busy: boolean }) {
  const rec = row.recommendation;
  return (
    <div className="grid gap-4 p-4 md:grid-cols-[1fr_auto] md:items-start">
      <div className="space-y-2 text-sm">
        {row.market ? (
          <p className="text-ink">
            {row.soc?.title} in {row.market.areaName}: {money(row.market.p25)} to {money(row.market.p75)} for the middle half, {money(row.market.median)} median.
          </p>
        ) : (
          <p className="text-ink-muted">{!row.area ? 'This store has no metro yet.' : !row.soc ? 'This role has no occupation yet.' : 'No published figures for this metro and occupation yet.'}</p>
        )}
        {rec && (
          <>
            <p className="text-ink">{rec.reason}</p>
            <p className="text-ink-muted">
              The bill rate {rec.payRate > row.payRate ? 'shown keeps' : 'here keeps'} {MARGIN_SOURCE[rec.marginSource]} ({rec.marginPct}%) at {money(rec.payRate)} pay.
            </p>
            {rec.confidence === 'thin' && (
              <Badge variant="pending" size="sm">
                Thin data
              </Badge>
            )}
          </>
        )}
        {row.fill.shifts > 0 && (
          <p className="text-ink-muted">
            {row.fill.filled} of {row.fill.shifts} shifts filled here in 90 days{row.fill.noShows ? `, ${row.fill.noShows} no-call no-show${row.fill.noShows === 1 ? '' : 's'}` : ''}.
          </p>
        )}
      </div>
      {rec && rec.payRate > row.payRate && canPropose && (
        <Button onClick={onPropose} loading={busy} className="w-full md:w-auto">
          Propose {money(rec.payRate)} pay · {money(rec.billRate)} bill
        </Button>
      )}
    </div>
  );
}

function MarginControl({ clientId }: { clientId: string }) {
  const qc = useQueryClient();
  const [value, setValue] = useState('');
  const save = useMutation({
    mutationFn: () => setClientMargin(clientId, value.trim() === '' ? null : Number(value)),
    onSuccess: () => {
      toast.success(value.trim() === '' ? 'Target margin cleared — bill rates keep today’s margin.' : `Target margin set to ${value}%.`);
      void qc.invalidateQueries({ queryKey: ['market'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save the margin.'),
  });
  const invalid = value.trim() !== '' && (!Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) >= 90);
  return (
    <form
      className="flex items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!invalid) save.mutate();
      }}
    >
      <Field label="Target margin %" hint="Blank keeps today’s margin" error={invalid ? 'Between 0 and 90' : undefined} className="w-36">
        {(p) => <Input {...p} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder="e.g. 25" />}
      </Field>
      <Button type="submit" variant="outline" loading={save.isPending} disabled={invalid}>
        Save
      </Button>
    </form>
  );
}
