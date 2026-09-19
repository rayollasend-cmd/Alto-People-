import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, FileSpreadsheet, History as HistoryIcon, Pencil, Search, X } from 'lucide-react';
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
  Input,
  PageHeader,
  SegmentedControl,
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
  const counts = useMemo(() => {
    const queue = data?.queue ?? [];
    return {
      add: queue.filter((r) => r.kind === 'add').length,
      transfer: queue.filter((r) => r.kind === 'transfer').length,
      close: queue.filter((r) => r.kind === 'close').length,
      unbilled: queue.reduce((s, r) => s + (r.hoursUnbilled ?? 0), 0),
      unbilledPeople: queue.filter((r) => (r.hoursUnbilled ?? 0) > 0).length,
      active: (data?.roster ?? []).filter((r) => !r.separated).length,
      noWorkerId: (data?.roster ?? []).filter((r) => !r.separated && !r.workerId).length,
    };
  }, [data]);

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

          <SegmentedControl
            ariaLabel="Fieldglass setup"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'todo', label: `To do (${data.queue.length})` },
              { value: 'registered', label: `In Fieldglass (${counts.active})` },
            ]}
          />

          {tab === 'todo' ? (
            <Card className="p-4">
              {data.queue.length === 0 ? (
                <EmptyState title="Everyone is set up in Fieldglass" description="New hires land here once they’re approved and scheduled — or the moment they work unregistered." />
              ) : (
                <FieldglassQueueList queue={data.queue} returnTo="/fieldglass" />
              )}
            </Card>
          ) : (
            <Roster rows={data.roster} noWorkerId={counts.noWorkerId} />
          )}
        </>
      )}
    </div>
  );
}

function Roster({ rows, noWorkerId }: { rows: RosterRow[]; noWorkerId: number }) {
  const [search, setSearch] = useState('');
  const [missingOnly, setMissingOnly] = useState(false);
  const shown = useMemo(() => {
    const tokens = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return rows.filter((r) => {
      if (missingOnly && (r.workerId || r.separated)) return false;
      const hay = `${r.name} ${r.clientName ?? ''} ${r.workerId ?? ''}`.toLowerCase();
      return tokens.every((t) => hay.includes(t));
    });
  }, [rows, search, missingOnly]);

  if (rows.length === 0) {
    return <EmptyState title="Nobody registered yet" description="Mark someone added from To do and they’ll be listed here with their Worker ID." />;
  }
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-navy-secondary p-3">
        <div className="relative min-w-[14rem] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-silver/60" aria-hidden="true" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, client or Worker ID…"
            aria-label="Search who’s in Fieldglass"
            className="pl-8"
          />
        </div>
        {noWorkerId > 0 && (
          <Button variant={missingOnly ? 'secondary' : 'ghost'} size="sm" aria-pressed={missingOnly} onClick={() => setMissingOnly((v) => !v)}>
            Missing a Worker ID ({noWorkerId})
          </Button>
        )}
      </div>
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
