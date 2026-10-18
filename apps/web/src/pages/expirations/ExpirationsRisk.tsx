import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CalendarClock, ShieldCheck } from 'lucide-react';
import { getExpirationRisk, type ExpirationRisk, type RiskItem } from '@/lib/expirations113Api';
import { useTenant, useTerm } from '@/lib/auth';
import { fmtDate, fmtDateTime, fmtDayShort } from '@/lib/format';
import { useMediaQuery } from '@/lib/useViewport';
import { cn } from '@/lib/cn';
import { AssociateLink } from '@/components/ui/AssociateLink';
import { CHART, ChartFrame } from '@/components/ui/ChartFrame';
import { QueryError } from '@/components/ui/QueryError';
import { Badge, Button, Card, CardContent, EmptyState, ErrorBanner, SearchInput, Select, SkeletonRows } from '@/components/ui';

/**
 * Expirations as the floor feels them (GET /expirations/risk).
 *
 *   At risk   the lapses that will stop someone working a shift they're
 *             already on, soonest shift first — with what requires the
 *             credential there (the shift, the store, or the client)
 *   Timeline  thirteen weeks across, stores down, with the expired column
 *             first; pick a cell to see who
 *
 * One query feeds both; the filters (client, store, credential, person)
 * narrow it in the browser so their choices never shrink as you pick.
 */

export interface RiskFilters {
  clientId: string;
  storeId: string;
  qualificationId: string;
  q: string;
}

const REQUIRED_BY: Record<'shift' | 'site' | 'client', (term: ReturnType<typeof useTerm>) => string> = {
  shift: () => 'Required on this shift',
  site: (term) => `Required at this ${term('label.store').toLowerCase()}`,
  client: (term) => `Required by this ${term('label.client').toLowerCase()}`,
};

export function useExpirationRisk() {
  return useQuery({ queryKey: ['expirations', 'risk'], queryFn: () => getExpirationRisk(90) });
}

export function applyRiskFilters(items: RiskItem[], f: RiskFilters): RiskItem[] {
  const q = f.q.trim().toLowerCase();
  return items.filter(
    (i) =>
      (!f.clientId || i.clientId === f.clientId) &&
      (!f.storeId || i.storeId === f.storeId) &&
      (!f.qualificationId || i.qualificationId === f.qualificationId) &&
      (!q || i.associateName.toLowerCase().includes(q) || i.associateEmail.toLowerCase().includes(q) || i.qualificationName.toLowerCase().includes(q)),
  );
}

export function RiskFilterBar({ data, filters, setFilters }: { data: ExpirationRisk; filters: RiskFilters; setFilters: (f: RiskFilters) => void }) {
  const term = useTerm();
  const hasClients = useTenant().moduleOn('clientPortal');
  const stores = data.filters.stores.filter((s) => !filters.clientId || s.clientId === filters.clientId);
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="min-w-0 flex-1 basis-56 sm:max-w-xs">
        <SearchInput value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} placeholder="Find a person or credential" aria-label="Search expirations" />
      </div>
      {hasClients && data.filters.clients.length > 1 && (
        <>
          <label htmlFor="exp-client" className="sr-only">
            {term('label.client')}
          </label>
          <Select id="exp-client" size="sm" value={filters.clientId} onChange={(e) => setFilters({ ...filters, clientId: e.target.value, storeId: '' })}>
            <option value="">Every {term('label.client').toLowerCase()}</option>
            {data.filters.clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </>
      )}
      {stores.length > 1 && (
        <>
          <label htmlFor="exp-store" className="sr-only">
            {term('label.store')}
          </label>
          <Select id="exp-store" size="sm" value={filters.storeId} onChange={(e) => setFilters({ ...filters, storeId: e.target.value })}>
            <option value="">Every {term('label.store').toLowerCase()}</option>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </>
      )}
      {data.filters.qualifications.length > 1 && (
        <>
          <label htmlFor="exp-qual" className="sr-only">
            Credential
          </label>
          <Select id="exp-qual" size="sm" value={filters.qualificationId} onChange={(e) => setFilters({ ...filters, qualificationId: e.target.value })}>
            <option value="">Every credential</option>
            {data.filters.qualifications.map((q) => (
              <option key={q.id} value={q.id}>
                {q.name}
              </option>
            ))}
          </Select>
        </>
      )}
    </div>
  );
}

const lapseText = (i: RiskItem) =>
  i.daysUntilExpiry < 0
    ? `Expired ${fmtDate(i.expiresAt)} · ${-i.daysUntilExpiry} ${-i.daysUntilExpiry === 1 ? 'day' : 'days'} ago`
    : i.daysUntilExpiry === 0
      ? `Expires today`
      : `Expires ${fmtDate(i.expiresAt)} · in ${i.daysUntilExpiry} ${i.daysUntilExpiry === 1 ? 'day' : 'days'}`;

/* ----- At risk ----------------------------------------------------------- */

export function ExpirationAtRisk({ filters, setFilters, onRenew }: { filters: RiskFilters; setFilters: (f: RiskFilters) => void; onRenew?: (i: RiskItem) => void }) {
  const term = useTerm();
  const risk = useExpirationRisk();
  const data = risk.data;
  const byId = useMemo(() => new Map((data?.items ?? []).map((i) => [i.id, i])), [data]);
  const atRisk = useMemo(() => applyRiskFilters((data?.atRisk ?? []).map((id) => byId.get(id)!).filter(Boolean), filters), [data, byId, filters]);
  const others = useMemo(() => applyRiskFilters((data?.items ?? []).filter((i) => !i.blockingShift && i.daysUntilExpiry <= 30), filters).length, [data, filters]);

  if (risk.isError) return <QueryError what="expirations" query={risk} />;
  if (!data) return <SkeletonRows count={5} />;
  return (
    <div className="space-y-4">
      <RiskFilterBar data={data} filters={filters} setFilters={setFilters} />
      {data.truncated && <ErrorBanner severity="warning">Showing the first {data.items.length.toLocaleString()} expiring credentials. Narrow by {term('label.store').toLowerCase()} or credential to see the rest.</ErrorBanner>}
      <p className="text-sm text-ink-muted" aria-live="polite">
        {atRisk.length === 0
          ? 'No scheduled shift is blocked by a lapsing credential.'
          : `${atRisk.length} ${atRisk.length === 1 ? 'lapse blocks' : 'lapses block'} a scheduled shift — the soonest is ${fmtDayShort(atRisk[0]!.blockingShift!.startsAt)}.`}
        {others > 0 && ` ${others} more lapse within 30 days with no shift affected yet.`}
      </p>
      {atRisk.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState icon={ShieldCheck} title="Nobody’s shifts are at risk" description="When a credential lapses before a shift that requires it, it shows here first — soonest shift at the top." />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-y divide-line" aria-label="Lapses that block a scheduled shift">
              {atRisk.map((i) => {
                const s = i.blockingShift!;
                return (
                  <li key={i.id} className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
                    <div className="min-w-[12rem] flex-1">
                      <AssociateLink associateId={i.associateId} className="text-sm font-medium text-ink">
                        {i.associateName}
                      </AssociateLink>
                      <div className="text-xs text-ink-muted">
                        {i.qualificationName} · <span className={i.daysUntilExpiry < 0 ? 'text-alert' : 'text-warning'}>{lapseText(i)}</span>
                      </div>
                    </div>
                    <div className="min-w-[12rem] flex-1 text-sm">
                      <div className="flex items-center gap-1.5 text-ink">
                        <CalendarClock className="h-3.5 w-3.5 text-ink-muted" aria-hidden="true" />
                        {fmtDateTime(s.startsAt)}
                      </div>
                      <div className="text-xs text-ink-muted">
                        {[s.position, s.storeName].filter(Boolean).join(' · ')} · {REQUIRED_BY[s.requiredBy](term)}
                      </div>
                    </div>
                    {onRenew && (
                      <Button size="sm" variant="outline" onClick={() => onRenew(i)}>
                        Mark renewed
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/* ----- Timeline ------------------------------------------------------------ */

const shade = (n: number, max: number) => {
  if (n === 0) return '';
  const r = n / Math.max(1, max);
  return r > 0.66 ? 'bg-warning/40 text-ink font-medium' : r > 0.33 ? 'bg-warning/25 text-ink' : 'bg-warning/10 text-ink';
};

export function ExpirationTimeline({ filters, setFilters, onRenew }: { filters: RiskFilters; setFilters: (f: RiskFilters) => void; onRenew?: (i: RiskItem) => void }) {
  const term = useTerm();
  const hasClients = useTenant().moduleOn('clientPortal');
  const isPhone = useMediaQuery('(max-width: 767px)');
  const risk = useExpirationRisk();
  const data = risk.data;
  const [pick, setPick] = useState<{ storeId: string | null; week: number | 'expired' } | null>(null);

  const items = useMemo(() => applyRiskFilters(data?.items ?? [], filters), [data, filters]);
  // Rebuild the grid from the filtered items, so the filters reach it too.
  const grid = useMemo(() => {
    if (!data) return [];
    const first = new Date(`${data.weeks[0]}T00:00:00`).getTime();
    const rows = new Map<string, { storeId: string | null; storeName: string; clientName: string | null; expired: number; perWeek: number[] }>();
    for (const i of items) {
      const key = i.storeId ?? 'none';
      const row = rows.get(key) ?? { storeId: i.storeId, storeName: i.storeName ?? 'Not placed', clientName: i.clientName, expired: 0, perWeek: data.weeks.map(() => 0) };
      if (i.daysUntilExpiry < 0) row.expired += 1;
      else {
        const w = Math.floor((new Date(`${i.expiresAt}T12:00:00`).getTime() - first) / (7 * 86_400_000));
        if (w >= 0 && w < data.weeks.length) row.perWeek[w]! += 1;
      }
      rows.set(key, row);
    }
    return [...rows.values()].sort((a, b) => (a.storeId ? 0 : 1) - (b.storeId ? 0 : 1) || (a.clientName ?? '').localeCompare(b.clientName ?? '') || a.storeName.localeCompare(b.storeName));
  }, [data, items]);
  const max = Math.max(1, ...grid.flatMap((r) => r.perWeek));
  const perWeek = useMemo(() => (data ? data.weeks.map((w, k) => ({ week: fmtDayShort(w), lapsing: grid.reduce((s, r) => s + r.perWeek[k]!, 0) })) : []), [data, grid]);
  const picked = useMemo(() => {
    if (!pick || !data) return [];
    const first = new Date(`${data.weeks[0]}T00:00:00`).getTime();
    return items.filter((i) => {
      if ((i.storeId ?? null) !== pick.storeId) return false;
      if (pick.week === 'expired') return i.daysUntilExpiry < 0;
      const w = Math.floor((new Date(`${i.expiresAt}T12:00:00`).getTime() - first) / (7 * 86_400_000));
      return i.daysUntilExpiry >= 0 && w === pick.week;
    });
  }, [pick, items, data]);

  if (risk.isError) return <QueryError what="expirations" query={risk} />;
  if (!data) return <SkeletonRows count={6} />;
  const total = perWeek.reduce((s, w) => s + w.lapsing, 0);

  return (
    <div className="space-y-4">
      <RiskFilterBar data={data} filters={filters} setFilters={setFilters} />
      <ChartFrame
        title="Lapsing each week"
        summary={`${total} credentials lapse over the next ${data.weeks.length} weeks; the busiest week has ${Math.max(0, ...perWeek.map((w) => w.lapsing))}.`}
        columns={[
          { key: 'week', label: 'Week of' },
          { key: 'lapsing', label: 'Lapsing', numeric: true },
        ]}
        rows={perWeek}
        csvName="expirations-by-week"
        height={180}
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={perWeek} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
            <CartesianGrid stroke={CHART.grid} vertical={false} />
            <XAxis dataKey="week" tick={{ fill: CHART.axis, fontSize: 11 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
            <YAxis allowDecimals={false} tick={{ fill: CHART.axis, fontSize: 11 }} tickLine={false} axisLine={false} />
            <Tooltip contentStyle={CHART.tooltip} cursor={{ fill: CHART.grid }} />
            <Bar dataKey="lapsing" name="Lapsing" fill={CHART.warn} radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartFrame>

      {grid.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState icon={ShieldCheck} title="Nothing lapses in the next 90 days" description="Credentials with an expiry date appear here, week by week, as they come due." />
          </CardContent>
        </Card>
      ) : isPhone ? (
        <div className="space-y-3">
          {grid.map((r) => {
            const mine = items.filter((i) => (i.storeId ?? null) === r.storeId).sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
            return (
              <Card key={r.storeId ?? 'none'}>
                <CardContent className="p-3">
                  <div className="mb-2 text-sm font-medium text-ink">
                    {r.storeName}
                    {hasClients && r.clientName && <span className="font-normal text-ink-muted"> · {r.clientName}</span>}
                  </div>
                  <ul className="space-y-1.5">
                    {mine.map((i) => (
                      <li key={i.id} className="flex items-center justify-between gap-2 text-sm">
                        <span className="min-w-0 truncate text-ink">
                          {i.associateName} <span className="text-ink-muted">· {i.qualificationName}</span>
                        </span>
                        <span className={cn('shrink-0 text-xs tabular-nums', i.daysUntilExpiry < 0 ? 'text-alert' : 'text-ink-muted')}>{i.daysUntilExpiry < 0 ? 'Expired' : fmtDayShort(i.expiresAt)}</span>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            );
          })}
        </div>
      ) : (
        <Card>
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <caption className="sr-only">Credentials lapsing, by {term('label.store').toLowerCase()} and week</caption>
              <thead>
                <tr className="border-b border-line text-xs text-ink-muted">
                  <th scope="col" className="sticky left-0 bg-surface px-3 py-2 text-left font-medium">
                    {term('label.store')}
                  </th>
                  <th scope="col" className="px-2 py-2 text-center font-medium text-alert">
                    Expired
                  </th>
                  {data.weeks.map((w) => (
                    <th key={w} scope="col" className="whitespace-nowrap px-2 py-2 text-center font-medium">
                      {fmtDayShort(w)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {grid.map((r) => (
                  <tr key={r.storeId ?? 'none'} className="border-b border-line/60 last:border-0">
                    <th scope="row" className="sticky left-0 bg-surface px-3 py-2 text-left font-normal">
                      <div className="text-ink">{r.storeName}</div>
                      {hasClients && r.clientName && <div className="text-2xs text-ink-muted">{r.clientName}</div>}
                    </th>
                    <td className="px-1 py-1 text-center">
                      {r.expired > 0 ? (
                        <button
                          type="button"
                          onClick={() => setPick({ storeId: r.storeId, week: 'expired' })}
                          className="w-full rounded bg-alert/15 px-2 py-1.5 tabular-nums text-alert hover:ring-1 hover:ring-alert"
                          aria-label={`${r.expired} expired at ${r.storeName}`}
                        >
                          {r.expired}
                        </button>
                      ) : (
                        <span className="text-ink-subtle" aria-hidden="true">·</span>
                      )}
                    </td>
                    {r.perWeek.map((n, k) => (
                      <td key={k} className="px-1 py-1 text-center">
                        {n > 0 ? (
                          <button
                            type="button"
                            onClick={() => setPick({ storeId: r.storeId, week: k })}
                            className={cn('w-full rounded px-2 py-1.5 tabular-nums hover:ring-1 hover:ring-warning', shade(n, max), pick?.storeId === r.storeId && pick.week === k && 'ring-2 ring-accent')}
                            aria-label={`${n} lapsing at ${r.storeName} the week of ${fmtDayShort(data.weeks[k]!)}`}
                          >
                            {n}
                          </button>
                        ) : (
                          <span className="text-ink-subtle" aria-hidden="true">·</span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {picked.length > 0 && (
        <Card>
          <CardContent className="p-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-ink">
                {picked.length} at {picked[0]!.storeName ?? 'no placement'} · {pick?.week === 'expired' ? 'already expired' : `week of ${fmtDayShort(data.weeks[pick!.week as number]!)}`}
              </span>
              <Button size="sm" variant="ghost" onClick={() => setPick(null)}>
                Close
              </Button>
            </div>
            <ul className="divide-y divide-line">
              {picked.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2 text-sm">
                  <AssociateLink associateId={i.associateId} className="min-w-[10rem] flex-1 text-ink">
                    {i.associateName}
                  </AssociateLink>
                  <span className="flex-1 text-ink-muted">
                    {i.qualificationName} · {lapseText(i)}
                  </span>
                  {i.blockingShift && <Badge variant="destructive">Blocks a shift {fmtDayShort(i.blockingShift.startsAt)}</Badge>}
                  {onRenew && (
                    <Button size="sm" variant="ghost" onClick={() => onRenew(i)}>
                      Mark renewed
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
