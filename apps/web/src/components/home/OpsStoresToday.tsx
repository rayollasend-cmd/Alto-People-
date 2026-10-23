import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Store } from 'lucide-react';
import { ApiError, apiFetch } from '@/lib/api';
import { useAuth, useTerm } from '@/lib/auth';
import { getShiftCoverageGaps } from '@/lib/shiftWindowsApi';
import { ymdLocal } from '@/lib/format';
import { cn } from '@/lib/cn';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { SectionTitle } from '@/components/ui/SectionTitle';

/**
 * The operations manager's floor, store by store, today (F500 G5): one row
 * a store — who is on the floor against who is scheduled now, the day's
 * filled and open shifts, call-outs, shift windows nobody leads, and how
 * much of tomorrow is confirmed. Read from the same /workforce/overview the
 * floor row above it uses (its per-store board), so the two never disagree;
 * the "no lead" count comes from the store-leads gaps.
 */

export interface OpsStoreRow {
  clientId: string | null;
  clientName: string;
  onFloor: number;
  scheduledNow: number;
  scheduledToday?: number;
  openToday: number;
  callOutsToday?: number;
  confirmedTomorrow?: number;
  unconfirmedTomorrow: number;
  openTomorrow: number;
  noShowsToday: number;
  incidentsToday: number;
  unscheduledNow: number;
  status: 'red' | 'amber' | 'green';
}

interface OverviewStores {
  today: { stores: OpsStoreRow[] };
}

interface Row extends OpsStoreRow {
  /** Shift windows at this client with no lead; null when not known (no access). */
  noLead: number | null;
  tomorrowTotal: number;
}

const DOT: Record<OpsStoreRow['status'], string> = {
  red: 'bg-alert',
  amber: 'bg-warning',
  green: 'bg-success',
};
const STATUS_WORD: Record<OpsStoreRow['status'], string> = {
  red: 'Needs you now',
  amber: 'Gaps to fill',
  green: 'On track',
};

export function OpsStoresToday() {
  const term = useTerm();
  const { can } = useAuth();
  const navigate = useNavigate();
  const today = ymdLocal();
  const overview = useQuery({
    queryKey: ['workforce', 'overview'],
    queryFn: () => apiFetch<OverviewStores>('/workforce/overview'),
    staleTime: 60_000,
  });
  const canSeeLeads = can('view:hr-admin') || can('manage:org');
  const leads = useQuery({ queryKey: ['shift-windows', 'gaps'], queryFn: () => getShiftCoverageGaps(), staleTime: 60_000, enabled: canSeeLeads });

  const rows: Row[] | null = useMemo(() => {
    if (!overview.data) return null;
    const uncovered = new Map<string, number>();
    for (const c of leads.data?.clients ?? []) uncovered.set(c.clientId, c.uncovered.length);
    return overview.data.today.stores.map((s) => ({
      ...s,
      // Shifts with no client come back as one '—' bucket: name it.
      clientName: s.clientId ? s.clientName : 'Shifts with no client',
      noLead: leads.data && s.clientId ? (uncovered.get(s.clientId) ?? 0) : null,
      tomorrowTotal: (s.confirmedTomorrow ?? 0) + s.unconfirmedTomorrow + s.openTomorrow,
    }));
  }, [overview.data, leads.data]);

  const storeWord = term('site');
  const storesWord = term('sites');
  const scheduleOf = (r: Row, open = false) =>
    r.clientId ? `/scheduling?client=${r.clientId}${open ? '&open=1' : ''}&date=${today}` : `/scheduling?${open ? 'open=1&' : ''}date=${today}`;

  const columns: GridColumn<Row>[] = [
    {
      key: 'store',
      header: storeWord,
      primary: true,
      accessor: (r) => r.clientName,
      sortable: true,
      cell: (r) => (
        <span className="flex min-w-0 items-center gap-2">
          <span className={cn('h-2 w-2 shrink-0 rounded-full', DOT[r.status])} aria-hidden="true" />
          <span className="min-w-0">
            <span className="block font-medium text-ink">{r.clientName}</span>
            <span className="block text-2xs text-ink-muted">{STATUS_WORD[r.status]}</span>
          </span>
        </span>
      ),
      csv: (r) => r.clientName,
    },
    {
      key: 'floor',
      header: 'On the floor now',
      align: 'right',
      sortable: true,
      accessor: (r) => r.onFloor - r.scheduledNow,
      cell: (r) => (
        <span className={cn('tabular-nums', r.onFloor < r.scheduledNow ? 'text-alert' : 'text-ink')}>
          {r.onFloor} of {r.scheduledNow}
          {r.unscheduledNow > 0 && <span className="block text-2xs text-alert">{r.unscheduledNow} not on the schedule</span>}
        </span>
      ),
      csv: (r) => `${r.onFloor} of ${r.scheduledNow}`,
    },
    {
      key: 'scheduled',
      header: 'Filled today',
      align: 'right',
      sortable: true,
      accessor: (r) => r.scheduledToday ?? null,
      cell: (r) => <span className="tabular-nums">{r.scheduledToday ?? '—'}</span>,
    },
    {
      key: 'open',
      header: 'Open today',
      align: 'right',
      sortable: true,
      accessor: (r) => r.openToday,
      stopRowClick: true,
      cell: (r) =>
        r.openToday > 0 ? (
          <Link to={scheduleOf(r, true)} className="tabular-nums text-warning underline-offset-2 hover:underline">
            {r.openToday}
          </Link>
        ) : (
          <span className="tabular-nums text-ink-muted">0</span>
        ),
    },
    {
      key: 'callouts',
      header: 'Call-outs',
      align: 'right',
      sortable: true,
      accessor: (r) => r.callOutsToday ?? null,
      stopRowClick: true,
      cell: (r) =>
        (r.callOutsToday ?? 0) > 0 ? (
          <Link to="/call-outs" className="tabular-nums text-warning underline-offset-2 hover:underline">
            {r.callOutsToday}
          </Link>
        ) : (
          <span className="tabular-nums text-ink-muted">{r.callOutsToday ?? '—'}</span>
        ),
    },
    {
      key: 'nolead',
      header: 'Windows with no lead',
      align: 'right',
      sortable: true,
      accessor: (r) => r.noLead,
      stopRowClick: true,
      cell: (r) =>
        r.noLead === null ? (
          <span className="text-ink-muted">—</span>
        ) : r.noLead > 0 ? (
          <Link to="/scheduling/supervisors" className="tabular-nums text-warning underline-offset-2 hover:underline">
            {r.noLead}
          </Link>
        ) : (
          <span className="tabular-nums text-ink-muted">0</span>
        ),
    },
    {
      key: 'tomorrow',
      header: 'Confirmed tomorrow',
      align: 'right',
      sortable: true,
      accessor: (r) => (r.tomorrowTotal > 0 ? (r.confirmedTomorrow ?? 0) / r.tomorrowTotal : null),
      cell: (r) =>
        r.tomorrowTotal === 0 ? (
          <span className="text-ink-muted">No shifts</span>
        ) : (
          <span className="tabular-nums">
            {r.confirmedTomorrow ?? 0} of {r.tomorrowTotal}
            {r.openTomorrow > 0 && <span className="block text-2xs text-warning">{r.openTomorrow} open</span>}
          </span>
        ),
      csv: (r) => (r.tomorrowTotal === 0 ? '' : `${r.confirmedTomorrow ?? 0} of ${r.tomorrowTotal}`),
    },
  ];

  return (
    <section aria-label={`${storesWord} today`} className="space-y-3">
      <SectionTitle
        icon={Store}
        title={`${storesWord} today`}
        trailing={
          <Link to={`/scheduling?date=${today}`} className="inline-flex items-center gap-1 text-xs text-accent hover:underline">
            Today&rsquo;s schedule <ArrowRight className="h-3 w-3" aria-hidden="true" />
          </Link>
        }
      />
      {rows && rows.length === 0 ? (
        // A quiet day is one line, not a dashed box the height of a table
        // (the floor row above already says "No shifts today").
        <p className="text-sm text-ink-muted" data-testid="ops-stores-none">
          No {storeWord.toLowerCase()} has a shift or anyone on the clock today.{' '}
          <Link to="/scheduling" className="inline-flex items-center gap-1 text-accent hover:underline">
            Open the schedule <ArrowRight className="h-3 w-3" aria-hidden="true" />
          </Link>
        </p>
      ) : (
      <DataGrid<Row>
        id="ops-stores-today"
        caption={`${storesWord} today`}
        noun={{ one: storeWord.toLowerCase(), many: storesWord.toLowerCase() }}
        rows={rows}
        loading={overview.isPending}
        error={overview.isError ? (overview.error instanceof ApiError ? overview.error.message : `Couldn't load today's ${storesWord.toLowerCase()}.`) : null}
        onRetry={() => void overview.refetch()}
        columns={columns}
        rowKey={(r) => r.clientId ?? r.clientName}
        search={false}
        urlState={false}
        columnChooser={false}
        exportCsv={{ filename: `${storesWord.toLowerCase()}-today-${today}` }}
        onRowClick={(r) => navigate(scheduleOf(r))}
        rowActionLabel={(r) => `Open ${r.clientName}'s schedule today`}
        empty={{
          icon: Store,
          title: 'No shifts today',
          description: `No ${storeWord.toLowerCase()} has a shift or anyone on the clock today.`,
          action: (
            <Link to="/scheduling" className="inline-flex items-center gap-1 text-sm text-accent hover:underline">
              Open the schedule <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          ),
        }}
      />
      )}
    </section>
  );
}
