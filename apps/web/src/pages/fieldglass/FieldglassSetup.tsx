import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, FileSpreadsheet, History as HistoryIcon, Pencil, X } from 'lucide-react';
import { toast } from 'sonner';
import type { FieldglassStatus } from '@alto-people/shared';
import { ApiError, apiFetch } from '@/lib/api';
import { cn } from '@/lib/cn';
import { fmtDate } from '@/lib/format';
import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  FilterBar,
  FilterChip,
  Input,
  Label,
  PageHeader,
  SearchInput,
  SegmentedControl,
  Select,
  Skeleton,
} from '@/components/ui';
import { FieldglassQueueList, type FieldglassQueueRow } from './FieldglassQueue';
import { STATUS_CHIP } from '../time/FieldglassDesk';

/**
 * Fieldglass setup — finance's desk for the buyer's Fieldglass accounts:
 *
 *   to do          everyone to ADD (approved and scheduled, or already
 *                  working unbilled), TRANSFER (registered under the client
 *                  they left) or CLOSE (separated, still registered) — each
 *                  row unfolds to the registration packet
 *   in Fieldglass  everyone registered: their Worker ID (fix or add it in
 *                  place), the client, since when and by whom, when they
 *                  last worked, and where their newest timesheet stands
 */

interface RosterRow {
  associateId: string;
  name: string;
  photoUrl: string | null;
  clientId: string | null;
  clientName: string | null;
  workerId: string | null;
  addedAt: string;
  addedBy: string | null;
  separated: boolean;
  lastWorked: string | null;
  lastTimesheet: { weekEnd: string; status: FieldglassStatus | null; entered: boolean } | null;
}

interface SetupResponse {
  generatedAt: string;
  queue: FieldglassQueueRow[];
  roster: RosterRow[];
}


/* ===== Filters ==========================================================
 * Finance works this desk one client at a time ("who do I owe Walmart
 * 218?"), one person at a time ("did Rosa ever get a Worker ID?"), and
 * by date when a billing week is being closed. Every filter lives in the
 * URL, so a filtered desk can be sent to someone else as a link.
 * ====================================================================== */

type Kind = 'all' | 'add' | 'transfer' | 'close';

/** The date a To-do row is judged on: when they start (or started). */
const queueDate = (r: FieldglassQueueRow): string | null =>
  (r.firstShiftAt ?? r.hireDate ?? r.approvedAt ?? null)?.slice(0, 10) ?? null;

/** The date a registered row is judged on: when they last worked. */
const rosterDate = (r: RosterRow): string | null =>
  (r.lastWorked ?? r.addedAt ?? null)?.slice(0, 10) ?? null;

const inRange = (day: string | null, from: string, to: string): boolean => {
  if (!from && !to) return true;
  // No date to judge means it can't satisfy a date filter — better absent
  // than silently counted in a billing window it may not belong to.
  if (!day) return false;
  if (from && day < from) return false;
  if (to && day > to) return false;
  return true;
};

const matches = (haystack: Array<string | null | undefined>, search: string): boolean => {
  const tokens = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const hay = haystack.filter(Boolean).join(' ').toLowerCase();
  return tokens.every((t) => hay.includes(t));
};

/** "2026-09-18" → "09/18/2026", as Fieldglass writes dates. */
const usDate = (ymd: string) => `${ymd.slice(5, 7)}/${ymd.slice(8, 10)}/${ymd.slice(0, 4)}`;

function Tile({ label, value, hint, tone }: { label: string; value: number | string; hint?: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-navy-secondary bg-navy/60 px-3 py-2.5">
      <div className="text-2xs font-semibold uppercase tracking-wider text-silver/70">{label}</div>
      <div className={cn('mt-0.5 text-xl font-semibold tabular-nums text-white', tone)}>{value}</div>
      {hint && <div className="truncate text-xs text-silver/80">{hint}</div>}
    </div>
  );
}

export function FieldglassSetup() {
  const q = useQuery({
    queryKey: ['finance', 'fieldglass', 'setup'],
    queryFn: () => apiFetch<SetupResponse>('/finance/fieldglass'),
    refetchInterval: 120_000,
  });
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'registered' ? 'registered' : 'todo';
  const setTab = (t: 'todo' | 'registered') =>
    setParams(
      (p) => {
        if (t === 'todo') p.delete('tab');
        else p.set('tab', t);
        return p;
      },
      { replace: true },
    );

  const data = q.data;

  // Filters live in the URL next to ?tab=.
  const search = params.get('q') ?? '';
  const client = params.get('client') ?? '';
  const kind = (params.get('kind') as Kind | null) ?? 'all';
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const missingOnly = params.get('missing') === '1';
  const setParam = (key: string, value: string) =>
    setParams(
      (prev) => {
        if (value) prev.set(key, value);
        else prev.delete(key);
        return prev;
      },
      { replace: true },
    );
  const filtered = search !== '' || client !== '' || kind !== 'all' || from !== '' || to !== '' || missingOnly;
  const clearFilters = () =>
    setParams(
      (prev) => {
        for (const k of ['q', 'client', 'kind', 'from', 'to', 'missing']) prev.delete(k);
        return prev;
      },
      { replace: true },
    );

  // Every client that appears anywhere on the desk, so the list doesn't
  // change under you when you switch tabs.
  const clients = useMemo(() => {
    const names = new Set<string>();
    for (const r of data?.queue ?? []) {
      if (r.clientName) names.add(r.clientName);
      if (r.fromClientName) names.add(r.fromClientName);
    }
    for (const r of data?.roster ?? []) if (r.clientName) names.add(r.clientName);
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [data]);

  const queue = useMemo(
    () =>
      (data?.queue ?? []).filter((r) => {
        if (kind !== 'all' && r.kind !== kind) return false;
        // A transfer sits between two clients; either side counts as that
        // client's work to do.
        if (client && r.clientName !== client && r.fromClientName !== client) return false;
        if (!inRange(queueDate(r), from, to)) return false;
        return matches([r.name, r.clientName, r.fromClientName, r.position, r.email, r.workerId], search);
      }),
    [data, kind, client, from, to, search],
  );
  const roster = useMemo(
    () =>
      (data?.roster ?? []).filter((r) => {
        if (missingOnly && (r.workerId || r.separated)) return false;
        if (client && r.clientName !== client) return false;
        if (!inRange(rosterDate(r), from, to)) return false;
        return matches([r.name, r.clientName, r.workerId], search);
      }),
    [data, missingOnly, client, from, to, search],
  );

  const counts = useMemo(() => {
    return {
      add: queue.filter((r) => r.kind === 'add').length,
      transfer: queue.filter((r) => r.kind === 'transfer').length,
      close: queue.filter((r) => r.kind === 'close').length,
      unbilled: queue.reduce((s, r) => s + (r.hoursUnbilled ?? 0), 0),
      unbilledPeople: queue.filter((r) => (r.hoursUnbilled ?? 0) > 0).length,
      active: roster.filter((r) => !r.separated).length,
      noWorkerId: roster.filter((r) => !r.separated && !r.workerId).length,
      // Totals behind the filter, for the "showing x of y" line.
      allQueue: (data?.queue ?? []).length,
      allActive: (data?.roster ?? []).filter((r) => !r.separated).length,
      allMissing: (data?.roster ?? []).filter((r) => !r.separated && !r.workerId).length,
    };
  }, [data, queue, roster]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Fieldglass setup"
        subtitle="Register new associates in Fieldglass, move transfers to their new client, close out separations — and keep every Worker ID on file."
        secondaryActions={
          <Button asChild variant="outline" size="sm">
            <Link to="/time-attendance/timesheets">
              <FileSpreadsheet className="h-3.5 w-3.5" />
              Fieldglass timesheets
            </Link>
          </Button>
        }
      />
      {q.isError && <ErrorBanner>{q.error instanceof ApiError ? q.error.message : 'Couldn’t load Fieldglass setup.'}</ErrorBanner>}
      {q.isLoading || !data ? (
        <div className="space-y-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <Tile label="To add" value={counts.add} hint={counts.add ? 'new in Fieldglass' : 'nobody waiting'} tone={counts.add ? 'text-gold' : 'text-silver'} />
            <Tile label="Transfers" value={counts.transfer} hint="close old, open new" tone={counts.transfer ? 'text-warning' : 'text-silver'} />
            <Tile label="To close" value={counts.close} hint="separated, still registered" tone={counts.close ? 'text-alert' : 'text-silver'} />
            <Tile
              label="Can’t be billed yet"
              value={`${counts.unbilled.toFixed(1)}h`}
              hint={counts.unbilledPeople ? `worked by ${counts.unbilledPeople} not in Fieldglass` : 'every worked hour is billable'}
              tone={counts.unbilled > 0 ? 'text-alert' : 'text-silver'}
            />
          </div>

          <FilterBar className="gap-x-3 gap-y-2">
            <SearchInput
              value={search}
              onChange={(e) => setParam('q', e.target.value)}
              placeholder="Name, client, Worker ID…"
              aria-label="Search the Fieldglass desk"
              wrapperClassName="min-w-[14rem] flex-1"
            />
            <div className="flex items-center gap-1.5">
              <Label htmlFor="fg-client" className="text-2xs uppercase tracking-wider text-silver/70">
                Client
              </Label>
              <Select
                id="fg-client"
                value={client}
                onChange={(e) => setParam('client', e.target.value)}
                className="h-9 w-44"
              >
                <option value="">All clients</option>
                {clients.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex items-center gap-1.5">
              <Label htmlFor="fg-from" className="text-2xs uppercase tracking-wider text-silver/70">
                {tab === 'todo' ? 'Starts' : 'Last worked'}
              </Label>
              <Input
                id="fg-from"
                type="date"
                value={from}
                max={to || undefined}
                onChange={(e) => setParam('from', e.target.value)}
                className="h-9 w-[9.5rem]"
                aria-label={tab === 'todo' ? 'Starts on or after' : 'Last worked on or after'}
              />
              <span className="text-xs text-silver/60">to</span>
              <Input
                id="fg-to"
                type="date"
                value={to}
                min={from || undefined}
                onChange={(e) => setParam('to', e.target.value)}
                className="h-9 w-[9.5rem]"
                aria-label={tab === 'todo' ? 'Starts on or before' : 'Last worked on or before'}
              />
            </div>
            {tab === 'todo' ? (
              <div className="flex items-center gap-1.5">
                {(
                  [
                    ['all', 'All'],
                    ['add', 'To add'],
                    ['transfer', 'Transfers'],
                    ['close', 'To close'],
                  ] as Array<[Kind, string]>
                ).map(([value, label]) => (
                  <FilterChip
                    key={value}
                    active={kind === value}
                    onClick={() => setParam('kind', value === 'all' ? '' : value)}
                  >
                    {label}
                  </FilterChip>
                ))}
              </div>
            ) : (
              <FilterChip active={missingOnly} onClick={() => setParam('missing', missingOnly ? '' : '1')}>
                Missing a Worker ID ({counts.allMissing})
              </FilterChip>
            )}
            {filtered && (
              <Button variant="ghost" size="xs" onClick={clearFilters}>
                <X className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                Clear
              </Button>
            )}
          </FilterBar>

          {filtered && (
            <p className="-mt-2 text-xs text-silver/70" aria-live="polite">
              {tab === 'todo'
                ? `Showing ${queue.length} of ${counts.allQueue} waiting on setup.`
                : `Showing ${roster.length} of ${counts.allActive} registered.`}{' '}
              The tiles above count what you are looking at.
            </p>
          )}

          <SegmentedControl
            ariaLabel="Fieldglass setup"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'todo', label: `To do (${queue.length})` },
              { value: 'registered', label: `In Fieldglass (${counts.active})` },
            ]}
          />

          {tab === 'todo' ? (
            <Card className="p-4">
              {queue.length === 0 ? (
                <EmptyState
                  title={filtered ? 'Nobody matches those filters' : 'Everyone is set up in Fieldglass'}
                  description={
                    filtered
                      ? 'Widen the client, the dates or the search to see the rest of the desk.'
                      : 'New hires land here once they’re approved and scheduled — or the moment they work unregistered.'
                  }
                  action={
                    filtered ? (
                      <Button variant="outline" size="sm" onClick={clearFilters}>
                        Clear filters
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                <FieldglassQueueList queue={queue} returnTo={`/fieldglass${params.toString() ? `?${params.toString()}` : ''}`} />
              )}
            </Card>
          ) : (
            <Roster rows={roster} total={(data.roster ?? []).length} onClear={clearFilters} />
          )}
        </>
      )}
    </div>
  );
}

function Roster({
  rows,
  total,
  onClear,
}: {
  rows: RosterRow[];
  total: number;
  onClear: () => void;
}) {
  // Searching and filtering moved to the one bar above, shared with the
  // To do tab — two search boxes on one page was the old confusion.
  const shown = rows;

  if (total === 0) {
    return <EmptyState title="Nobody registered yet" description="Mark someone added from To do and they’ll be listed here with their Worker ID." />;
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        title="Nobody matches those filters"
        description="Widen the client, the dates or the search to see everyone registered."
        action={
          <Button variant="outline" size="sm" onClick={onClear}>
            Clear filters
          </Button>
        }
      />
    );
  }
  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[52rem] text-sm">
          <thead>
            <tr className="text-left text-2xs uppercase tracking-wider text-silver/70">
              <th className="px-3 py-2 font-semibold">Worker</th>
              <th className="px-3 py-2 font-semibold">Client</th>
              <th className="px-3 py-2 font-semibold">Worker ID</th>
              <th className="px-3 py-2 font-semibold">In Fieldglass since</th>
              <th className="px-3 py-2 font-semibold">Last worked</th>
              <th className="px-3 py-2 font-semibold">Latest timesheet</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.associateId} className="border-t border-navy-secondary/60">
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2.5">
                    <Avatar src={r.photoUrl} name={r.name} size="sm" />
                    <div className="min-w-0">
                      <Link
                        to={`/time-attendance/timesheets/history/${r.associateId}`}
                        className="inline-flex items-center gap-1 font-medium text-white hover:text-gold hover:underline"
                        title="Every timesheet, across pay periods"
                      >
                        {r.name}
                        <HistoryIcon className="h-3 w-3 text-silver/60" aria-hidden="true" />
                      </Link>
                      {r.separated && (
                        <div>
                          <Badge variant="destructive" size="sm">
                            Separated — close
                          </Badge>
                        </div>
                      )}
                    </div>
                  </div>
                </td>
                <td className="px-3 py-2 text-silver">{r.clientName ?? '—'}</td>
                <td className="px-3 py-2">
                  <WorkerIdCell row={r} />
                </td>
                <td className="px-3 py-2 text-silver">
                  {fmtDate(r.addedAt)}
                  {r.addedBy && <div className="text-xs2 text-silver/60">by {r.addedBy}</div>}
                </td>
                <td className="px-3 py-2 tabular-nums text-silver">{r.lastWorked ? usDate(r.lastWorked) : '—'}</td>
                <td className="px-3 py-2">
                  {r.lastTimesheet ? (
                    <div className="flex flex-col items-start gap-0.5">
                      <Badge
                        variant={r.lastTimesheet.status ? STATUS_CHIP[r.lastTimesheet.status].variant : r.lastTimesheet.entered ? 'accent' : 'default'}
                        size="sm"
                      >
                        {r.lastTimesheet.status ? STATUS_CHIP[r.lastTimesheet.status].label : r.lastTimesheet.entered ? 'Entered' : 'Not entered'}
                      </Badge>
                      <span className="text-xs2 tabular-nums text-silver/70">week ending {usDate(r.lastTimesheet.weekEnd)}</span>
                    </div>
                  ) : (
                    <span className="text-silver/40">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 && <p className="p-4 text-center text-sm text-silver">Nobody matches.</p>}
      </div>
    </Card>
  );
}

/** The Worker ID, fixed or added in place. */
function WorkerIdCell({ row }: { row: RosterRow }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(row.workerId ?? '');
  const [busy, setBusy] = useState(false);
  const clean = draft.trim();
  const bad = clean !== '' && !/^[A-Za-z0-9._-]+$/.test(clean);

  const save = async () => {
    setBusy(true);
    try {
      await apiFetch(`/finance/fieldglass/${row.associateId}`, { method: 'PATCH', body: { workerId: clean } });
      await qc.invalidateQueries({ queryKey: ['finance', 'fieldglass'] });
      toast.success(clean ? `Worker ID saved for ${row.name}.` : `Worker ID cleared for ${row.name}.`);
      setEditing(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not save the Worker ID.');
    } finally {
      setBusy(false);
    }
  };

  if (!editing) {
    return row.workerId ? (
      <span className="inline-flex items-center gap-1.5">
        <span className="font-mono text-white">{row.workerId}</span>
        <Button variant="ghost" size="sm" onClick={() => setEditing(true)} aria-label={`Edit ${row.name}’s Worker ID`}>
          <Pencil className="h-3.5 w-3.5" />
        </Button>
      </span>
    ) : row.separated ? (
      <span className="text-silver/40">—</span>
    ) : (
      <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
        Add Worker ID
      </Button>
    );
  }
  return (
    <form
      className="flex items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        if (!bad) void save();
      }}
    >
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="WKR00012345"
        aria-label={`${row.name}’s Fieldglass Worker ID`}
        aria-invalid={bad}
        autoFocus
        className="h-8 w-36 font-mono"
      />
      <Button type="submit" size="sm" loading={busy} disabled={busy || bad} aria-label="Save Worker ID">
        <Check className="h-3.5 w-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => {
          setDraft(row.workerId ?? '');
          setEditing(false);
        }}
        aria-label="Cancel"
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </form>
  );
}
