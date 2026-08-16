import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, DollarSign, Download } from 'lucide-react';
import type { LaborCostRow } from '@alto-people/shared';
import { laborCosts } from '@/lib/schedulingApi';
import { ApiError } from '@/lib/api';
import { downloadCsv } from '@/lib/csv';
import { fmtDate } from '@/lib/format';
import { PageHeader } from '@/components/ui/PageHeader';
import {
  Button,
  Card,
  CardContent,
  EmptyState,
  ErrorBanner,
  Input,
  Select,
  SkeletonRows,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui';

/**
 * Labor costs — the daily "what is this schedule costing us" report HR
 * asked for: one row per (day, client, store), scheduled cost next to
 * worked cost.
 *
 * Scheduled = every non-cancelled shift priced at its own payRate, else
 * the (client, position) rate default — identical resolution to the
 * scheduling page's KPI strip, so the two never disagree. Worked = every
 * clocked-out punch (approved or awaiting review) net of breaks, priced
 * at the rate snapshotted at clock-in. Rows missing rates are flagged,
 * not silently $0 — the fix lives in Clients → Rate defaults.
 */

const todayYmd = (): string => {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
};

const addDaysYmd = (ymd: string, days: number): string => {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${dt.getFullYear()}-${mm}-${dd}`;
};

const money = (v: number): string =>
  `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const hours = (minutes: number): string => `${(minutes / 60).toFixed(1)}h`;

interface Totals {
  scheduledMinutes: number;
  scheduledCost: number;
  scheduledShifts: number;
  scheduledNoRate: number;
  workedMinutes: number;
  workedCost: number;
  workedPunches: number;
  workedNoRate: number;
}
const emptyTotals = (): Totals => ({
  scheduledMinutes: 0,
  scheduledCost: 0,
  scheduledShifts: 0,
  scheduledNoRate: 0,
  workedMinutes: 0,
  workedCost: 0,
  workedPunches: 0,
  workedNoRate: 0,
});
const addRow = (t: Totals, r: LaborCostRow): void => {
  t.scheduledMinutes += r.scheduledMinutes;
  t.scheduledCost += r.scheduledCost;
  t.scheduledShifts += r.scheduledShifts;
  t.scheduledNoRate += r.scheduledNoRate;
  t.workedMinutes += r.workedMinutes;
  t.workedCost += r.workedCost;
  t.workedPunches += r.workedPunches;
  t.workedNoRate += r.workedNoRate;
};

export function LaborCostsHome() {
  const [from, setFrom] = useState(todayYmd);
  const [toInclusive, setToInclusive] = useState(todayYmd);
  const [rows, setRows] = useState<LaborCostRow[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clientFilter, setClientFilter] = useState('');
  const [locationFilter, setLocationFilter] = useState('');

  const load = useCallback(async () => {
    if (!from || !toInclusive || toInclusive < from) return;
    setRows(null);
    setError(null);
    try {
      // Server takes an exclusive upper bound; the picker is inclusive.
      const res = await laborCosts({
        from: new Date(`${from}T00:00:00`).toISOString(),
        to: new Date(`${addDaysYmd(toInclusive, 1)}T00:00:00`).toISOString(),
      });
      setRows(res.rows);
      setTruncated(res.truncated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load labor costs.');
      setRows([]);
    }
  }, [from, toInclusive]);

  useEffect(() => {
    void load();
  }, [load]);

  const preset = (days: number) => {
    const today = todayYmd();
    setFrom(days === 0 ? today : addDaysYmd(today, -days + 1));
    setToInclusive(today);
  };

  // Filter options come from the loaded rows — no extra fetch, and bounded
  // roles automatically only see their own client.
  const clientOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows ?? []) {
      if (r.clientId) m.set(r.clientId, r.clientName ?? r.clientId);
    }
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows]);
  const locationOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows ?? []) {
      if (clientFilter && r.clientId !== clientFilter) continue;
      if (r.locationId) m.set(r.locationId, r.locationName ?? r.locationId);
    }
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows, clientFilter]);

  const visible = useMemo(
    () =>
      (rows ?? []).filter(
        (r) =>
          (!clientFilter || r.clientId === clientFilter) &&
          (!locationFilter || r.locationId === locationFilter),
      ),
    [rows, clientFilter, locationFilter],
  );

  const byDay = useMemo(() => {
    const days = new Map<string, { rows: LaborCostRow[]; totals: Totals }>();
    for (const r of visible) {
      let d = days.get(r.date);
      if (!d) {
        d = { rows: [], totals: emptyTotals() };
        days.set(r.date, d);
      }
      d.rows.push(r);
      addRow(d.totals, r);
    }
    return [...days.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [visible]);

  const grand = useMemo(() => {
    const t = emptyTotals();
    for (const r of visible) addRow(t, r);
    return t;
  }, [visible]);

  const exportCsv = () => {
    downloadCsv(`labor-costs-${from}-to-${toInclusive}.csv`, [
      [
        'Date', 'Client', 'Store', 'Shifts', 'Scheduled hours', 'Scheduled cost',
        'Shifts without rate', 'Punches', 'Worked hours', 'Worked cost',
        'Punches without rate',
      ],
      ...visible.map((r) => [
        r.date,
        r.clientName ?? '',
        r.locationName ?? '',
        r.scheduledShifts,
        (r.scheduledMinutes / 60).toFixed(2),
        r.scheduledCost.toFixed(2),
        r.scheduledNoRate,
        r.workedPunches,
        (r.workedMinutes / 60).toFixed(2),
        r.workedCost.toFixed(2),
        r.workedNoRate,
      ]),
    ]);
  };

  const noRateTotal = grand.scheduledNoRate + grand.workedNoRate;

  return (
    <div>
      <PageHeader
        title="Labor costs"
        subtitle="Scheduled vs worked labor spend, per client and store, day by day"
      />

      <div className="mb-3 flex flex-wrap items-end gap-2">
        <div>
          <label className="block text-2xs uppercase tracking-widest text-silver/80 mb-1">
            From
          </label>
          <Input
            type="date"
            value={from}
            max={toInclusive}
            onChange={(e) => setFrom(e.target.value)}
            className="h-9 w-40"
          />
        </div>
        <div>
          <label className="block text-2xs uppercase tracking-widest text-silver/80 mb-1">
            To
          </label>
          <Input
            type="date"
            value={toInclusive}
            min={from}
            onChange={(e) => setToInclusive(e.target.value)}
            className="h-9 w-40"
          />
        </div>
        <div className="flex gap-1.5">
          <Button size="sm" variant="outline" onClick={() => preset(0)}>
            Today
          </Button>
          <Button size="sm" variant="outline" onClick={() => preset(7)}>
            Last 7 days
          </Button>
          <Button size="sm" variant="outline" onClick={() => preset(30)}>
            Last 30 days
          </Button>
        </div>
        <Select
          value={clientFilter}
          onChange={(e) => {
            setClientFilter(e.target.value);
            setLocationFilter('');
          }}
          size="sm"
          className="w-auto"
          aria-label="Filter by client"
        >
          <option value="">All clients</option>
          {clientOptions.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </Select>
        <Select
          value={locationFilter}
          onChange={(e) => setLocationFilter(e.target.value)}
          size="sm"
          className="w-auto"
          aria-label="Filter by store"
        >
          <option value="">All stores</option>
          {locationOptions.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </Select>
        <Button
          size="sm"
          variant="secondary"
          onClick={exportCsv}
          disabled={visible.length === 0}
          className="ml-auto"
        >
          <Download className="h-4 w-4" />
          Export CSV
        </Button>
      </div>

      {error && <ErrorBanner className="mb-3">{error}</ErrorBanner>}

      {truncated && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/[0.07] p-3 text-sm text-silver">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          The range has more activity than one report covers — totals are a
          floor. Narrow the date range for exact numbers.
        </div>
      )}

      {noRateTotal > 0 && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/[0.07] p-3 text-sm text-silver">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <span>
            {grand.scheduledNoRate > 0 && (
              <>
                {grand.scheduledNoRate} shift{grand.scheduledNoRate === 1 ? '' : 's'}{' '}
                in range {grand.scheduledNoRate === 1 ? 'has' : 'have'} no pay rate
                and contribute $0 — set per-position defaults in{' '}
                <Link to="/clients" className="text-gold hover:underline">
                  Clients → Rate defaults
                </Link>
                .{' '}
              </>
            )}
            {grand.workedNoRate > 0 && (
              <>
                {grand.workedNoRate} punch{grand.workedNoRate === 1 ? '' : 'es'} had
                no snapshotted rate.
              </>
            )}
          </span>
        </div>
      )}

      {rows === null ? (
        <SkeletonRows count={6} />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={DollarSign}
          title="No labor activity in this range"
          description="No shifts or punches match the selected dates and filters."
        />
      ) : (
        <div className="space-y-5">
          {byDay.map(([date, day]) => (
            <Card key={date} className="overflow-hidden">
              <CardContent className="p-0">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-navy-secondary bg-navy-secondary/30 px-4 py-2.5">
                  <div className="text-sm font-medium text-white">{fmtDate(date)}</div>
                  <div className="text-xs text-silver tabular-nums">
                    Scheduled {hours(day.totals.scheduledMinutes)} ·{' '}
                    <span className="text-white">{money(day.totals.scheduledCost)}</span>
                    {'  ·  '}Worked {hours(day.totals.workedMinutes)} ·{' '}
                    <span className="text-white">{money(day.totals.workedCost)}</span>
                  </div>
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Client</TableHead>
                      <TableHead>Store</TableHead>
                      <TableHead className="text-right">Shifts</TableHead>
                      <TableHead className="text-right hidden sm:table-cell">
                        Sched. hours
                      </TableHead>
                      <TableHead className="text-right">Sched. cost</TableHead>
                      <TableHead className="text-right hidden md:table-cell">
                        Punches
                      </TableHead>
                      <TableHead className="text-right hidden sm:table-cell">
                        Worked hours
                      </TableHead>
                      <TableHead className="text-right">Worked cost</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {day.rows.map((r) => (
                      <TableRow key={`${r.date}|${r.clientId}|${r.locationId}`}>
                        <TableCell className="text-white">
                          {r.clientName ?? '—'}
                        </TableCell>
                        <TableCell className="text-silver">
                          {r.locationName ?? '—'}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-silver">
                          {r.scheduledShifts}
                          {r.scheduledNoRate > 0 && (
                            <span
                              className="ml-1 text-warning"
                              title={`${r.scheduledNoRate} without a pay rate`}
                            >
                              ({r.scheduledNoRate}!)
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-silver hidden sm:table-cell">
                          {hours(r.scheduledMinutes)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-white">
                          {money(r.scheduledCost)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-silver hidden md:table-cell">
                          {r.workedPunches}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-silver hidden sm:table-cell">
                          {hours(r.workedMinutes)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-white">
                          {money(r.workedCost)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ))}

          <Card>
            <CardContent className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <div className="text-sm font-medium text-white">
                Range total ({visible.length} row{visible.length === 1 ? '' : 's'})
              </div>
              <div className="text-sm text-silver tabular-nums">
                Scheduled {hours(grand.scheduledMinutes)} ·{' '}
                <span className="text-white">{money(grand.scheduledCost)}</span>
                {'  ·  '}Worked {hours(grand.workedMinutes)} ·{' '}
                <span className="text-white">{money(grand.workedCost)}</span>
              </div>
            </CardContent>
          </Card>

          <p className="text-2xs text-silver/60">
            Scheduled cost prices each shift at its own rate, else the client's
            per-position default. Worked cost prices each clocked-out punch (net
            of breaks) at the rate captured at clock-in. Per-shift rates are
            visible on each shift in{' '}
            <Link to="/scheduling" className="text-gold hover:underline">
              Scheduling
            </Link>
            .
          </p>
        </div>
      )}
    </div>
  );
}
