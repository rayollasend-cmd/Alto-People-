import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, Bot, Cpu, ListTodo, Plus, User } from '@/components/ui/icons';
import { WORKER_CAPABILITIES, WORK_TASK_RISK_LABELS, WORK_TASK_STATUS_LABELS, type WorkTaskStatus, type WorkTaskView } from '@alto-people/shared';
import { useAuth, useTerm } from '@/lib/auth';
import { useViewerSites } from '@/pages/scheduling/viewerSites';
import { listTasks, getTaskDay } from '@/lib/tasksApi';
import { fmtDateTz, fmtShiftRangeTz, ymdLocal, zonedWallTimeToUtc } from '@/lib/format';
import { urlDay, urlString, useUrlParam, useUrlState } from '@/lib/useUrlState';
import { ListTemplate } from '@/components/templates';
import { Badge, Button, DateField, MetricCard, MetricStrip, Select } from '@/components/ui';
import { FilterBar } from '@/components/ui/FilterBar';
import { DataGrid } from '@/components/ui/DataGrid';
import { cn } from '@/lib/cn';
import { TaskDrawer } from './TaskDrawer';
import { NewTaskDialog } from './NewTaskDialog';

/**
 * Brief 3-2: the tasks board. Every unit of work at a site in a window,
 * who holds it (a person, an agent or a robot), and what state it is in.
 * A row opens the task: the assignment with every reason the engine
 * weighed, the timeline, and the actions a supervisor takes.
 */

type StatusFilter = 'live' | 'queued' | 'exceptions' | 'done' | 'all';

const STATUS_VALUES: readonly StatusFilter[] = ['live', 'queued', 'exceptions', 'done', 'all'];

const LIVE: WorkTaskStatus[] = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'HANDED_OFF'];
const EXCEPTIONS: WorkTaskStatus[] = ['STALLED', 'FAILED'];

const STATUS_VARIANT: Record<WorkTaskStatus, 'default' | 'success' | 'pending' | 'destructive' | 'accent' | 'outline'> = {
  OPEN: 'outline',
  QUEUED: 'pending',
  ASSIGNED: 'default',
  IN_PROGRESS: 'accent',
  STALLED: 'destructive',
  FAILED: 'destructive',
  HANDED_OFF: 'accent',
  DONE: 'success',
  CANCELLED: 'outline',
};

const CAP_LABEL = new Map<string, string>(WORKER_CAPABILITIES.map((c) => [c.code, c.label]));

/** One glyph per kind of holder, the same the nav uses: a person, an agent (Bot), a robot (Cpu). */
export function HolderIcon({ type, className }: { type: 'PERSON' | 'AGENT' | 'ROBOT'; className?: string }) {
  const Icon = type === 'ROBOT' ? Cpu : type === 'AGENT' ? Bot : User;
  return <Icon className={cn('h-3.5 w-3.5 shrink-0', className)} aria-hidden="true" />;
}


/** Which tile a task's state counts under. */
function bucketOf(status: WorkTaskStatus): Exclude<StatusFilter, 'all'> {
  if (LIVE.includes(status)) return 'live';
  if (status === 'QUEUED') return 'queued';
  if (EXCEPTIONS.includes(status)) return 'exceptions';
  return 'done';
}

/** The states the Inbox's "Tasks needing a person" counts — the board's needs view lists exactly these, on any day. */
export const NEEDS_A_PERSON: readonly WorkTaskStatus[] = ['QUEUED', 'STALLED', 'FAILED'];

/**
 * One calendar day on a zone's clock, as instants [from, to) — the board's
 * day for a viewer whose sites all share one zone (a Central-time store's
 * day, not the company's Eastern one).
 */
export function zonedDayBounds(day: string, timeZone: string): { from: string; to: string } {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return {
    from: zonedWallTimeToUtc(y, m, d, 0, 0, timeZone).toISOString(),
    to: zonedWallTimeToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, timeZone).toISOString(),
  };
}

export function countByBucket(tasks: WorkTaskView[] | null): Record<Exclude<StatusFilter, 'all'>, number> | null {
  if (!tasks) return null;
  const out = { live: 0, queued: 0, exceptions: 0, done: 0 };
  for (const t of tasks) out[bucketOf(t.status)] += 1;
  return out;
}

export function TasksBoard() {
  const { can } = useAuth();
  const term = useTerm();
  const canManage = can('manage:scheduling');
  // The viewer's sites, with their zones (FLOOR-19): a client-bound viewer
  // (a shift supervisor) has no view:org — their own client's stores carry
  // the zones, so each task reads on its own store's clock.
  const sites = useViewerSites();
  // One zone for every site the viewer runs: their "today" is that clock's.
  const sharedZone = sites && sites.length > 0 && sites.every((x) => x.timezone && x.timezone === sites[0]!.timezone) ? sites[0]!.timezone : null;
  const [params, setParams] = useSearchParams();
  const openId = params.get('task');
  // The Inbox's "Tasks needing a person" opens here (FLOOR-8): every open
  // task waiting for a person, on any day — exactly what the Inbox counts.
  const needs = params.get('needs') === '1';
  // Site, day and state live in the URL (?site=&day=&status=), so a link
  // or a notification opens the same board (F500 G2).
  const [locationId, setLocationId] = useUrlState<string>('site', '', urlString);
  const [status, setStatus] = useUrlParam<StatusFilter>('status', 'live', STATUS_VALUES);
  // The site's day (F500 SH-4): "today" on the floor's own clock, from the
  // API (apps/api/src/lib/siteDay.ts) — never the browser's UTC date, which
  // after 5 PM Pacific was already tomorrow. A day the person picks wins.
  const [pickedDay, setDay] = useUrlState<string>('day', '', urlDay);
  // With no site picked, the day of the one zone the viewer's sites share
  // (any of them answers it) — else the company's.
  const dayAnchor = locationId || (sharedZone && sites ? sites[0]!.id : null);
  const todayQuery = useQuery({
    queryKey: ['tasks', 'day', dayAnchor],
    queryFn: () => getTaskDay(dayAnchor),
    staleTime: 60_000,
    enabled: sites !== null || !!locationId,
  });
  const day = pickedDay || todayQuery.data?.day || (todayQuery.isError ? ymdLocal() : null);
  const dayZone = todayQuery.data?.timezone ?? null;
  // A task's window reads on its own site's clock (it read in UTC: a 9 AM
  // task in Panama City showed 2:00 PM).
  const zoneOf = useMemo(() => new Map((sites ?? []).filter((site) => site.timezone).map((site) => [site.id, site.timezone])), [sites]);
  // The server's zone for the site the day was asked of beats any list entry
  // (a site-bound account's own site carries no zone of its own here).
  const zoneFor = (siteId: string) => (siteId === dayAnchor ? dayZone : null) ?? zoneOf.get(siteId) ?? dayZone;
  const [creating, setCreating] = useState(false);
  const qc = useQueryClient();

  // No site picked, one shared zone: that clock's midnight to midnight (the
  // API's plain day is the company's). The zone is the server's answer for
  // the anchor site, never a browser fallback.
  const boundsZone = !locationId && dayAnchor ? dayZone : null;
  const tasksQuery = useQuery({
    queryKey: ['tasks', 'list', { locationId, day, boundsZone }],
    queryFn: () =>
      boundsZone && day
        ? listTasks({ locationId: null, ...zonedDayBounds(day, boundsZone) })
        : listTasks({ locationId: locationId || null, day }),
    enabled: !needs && day !== null,
    refetchInterval: 30_000,
  });
  // Every open task that needs a person, on any day (the Inbox's count).
  const needsQuery = useQuery({
    queryKey: ['tasks', 'needs', { locationId }],
    queryFn: async () => {
      const lists = await Promise.all(NEEDS_A_PERSON.map((st) => listTasks({ locationId: locationId || null, status: st })));
      return lists.flatMap((l) => l.tasks).sort((a, b) => a.windowStart.localeCompare(b.windowStart));
    },
    enabled: needs,
    refetchInterval: 30_000,
  });
  const listQuery = needs ? needsQuery : tasksQuery;
  const allRows = needs ? (needsQuery.data ?? null) : (tasksQuery.data?.tasks ?? null);
  // In the needs view only its two states filter; a day-board state (live, done) shows them all.
  const effectiveStatus: StatusFilter = needs && status !== 'queued' && status !== 'exceptions' ? 'all' : status;
  const rows = useMemo(() => {
    const all = allRows ?? [];
    return effectiveStatus === 'all' ? all : all.filter((t) => bucketOf(t.status) === effectiveStatus);
  }, [allRows, effectiveStatus]);
  // The tiles count the same list the grid shows, so a number and its
  // rows always agree (the 24h summary disagreed with a per-day list).
  const counts = useMemo(() => countByBucket(allRows), [allRows]);
  const leaveNeeds = () => {
    const next = new URLSearchParams(params);
    next.delete('needs');
    next.delete('status');
    setParams(next, { replace: true });
  };

  const setOpen = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('task', id);
    else next.delete('task');
    setParams(next, { replace: true });
  };

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['tasks'] });
  };

  const siteLabel = term('site');
  const tile = (key: Exclude<StatusFilter, 'all'>) => ({
    onClick: () => setStatus(effectiveStatus === key ? 'all' : key),
    selected: effectiveStatus === key,
  });
  const activeFilters = (locationId ? 1 : 0) + (pickedDay ? 1 : 0);

  return (
    // Design system §4.2: the List template — one filter row, the grid, the drawer.
    <ListTemplate
      title="Tasks"
      subtitle={`Every unit of work at a ${siteLabel.toLowerCase()}, who holds it, and why.`}
      topbarTitle="Tasks"
      primaryAction={
        canManage ? (
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" />
            New task
          </Button>
        ) : undefined
      }
      summary={
        needs ? (
          // The needs view: the two states a person must act on, every day.
          <MetricStrip label="Open tasks needing a person, every day">
            <MetricCard compact label="Waiting for a person" value={counts ? counts.queued : '…'} hint="Any day · someone must choose who does it" tone={counts && counts.queued > 0 ? 'warning' : 'default'} {...tile('queued')} />
            <MetricCard compact label="Exceptions" value={counts ? counts.exceptions : '…'} hint="Any day · stalled or failed" tone={counts && counts.exceptions > 0 ? 'alert' : 'default'} {...tile('exceptions')} />
          </MetricStrip>
        ) : (
        // The tiles ARE the state filter (F500 G2: tiles and a chip row
        // said the same four things). Tap the picked one again for all.
        <MetricStrip label="Tasks on this day by state">
          <MetricCard compact label="Live" value={counts ? counts.live : '…'} hint="Assigned or in progress" {...tile('live')} />
          <MetricCard compact label="Waiting for a person" value={counts ? counts.queued : '…'} hint="Needs someone to choose who does it" tone={counts && counts.queued > 0 ? 'warning' : 'default'} {...tile('queued')} />
          <MetricCard compact label="Exceptions" value={counts ? counts.exceptions : '…'} hint="Stalled or failed" tone={counts && counts.exceptions > 0 ? 'alert' : 'default'} {...tile('exceptions')} />
          <MetricCard compact label="Done" value={counts ? counts.done : '…'} hint="Finished or cancelled" {...tile('done')} />
        </MetricStrip>
        )
      }
      filters={
        <FilterBar
          bare
          activeFilters={activeFilters}
          onClearFilters={() => {
            setLocationId('');
            setDay('');
          }}
          sheetDescription={`Pick a ${siteLabel.toLowerCase()} and a day.`}
          actions={
            needs ? (
              <Button size="sm" variant="ghost" onClick={leaveNeeds}>
                Back to the day’s board
              </Button>
            ) : status !== 'all' ? (
              <Button size="sm" variant="ghost" onClick={() => setStatus('all')}>
                Show every state
              </Button>
            ) : undefined
          }
        >
          <Select size="sm" aria-label={`${siteLabel}`} value={locationId} onChange={(e) => setLocationId(e.target.value)} className="w-full sm:w-56">
            <option value="">Every {siteLabel.toLowerCase()}</option>
            {(sites ?? []).map((site) => (
              <option key={site.id} value={site.id}>
                {site.name}
              </option>
            ))}
          </Select>
          {needs ? (
            <span className="self-center text-xs text-ink-muted">Every day · open tasks needing a person</span>
          ) : (
            <span title={dayZone ? `The day on the ${dayZone.replace(/^.*\//, '').replace(/_/g, ' ')} clock` : undefined}>
              <DateField size="sm" aria-label="Day" value={day ?? ''} clearable={false} onChange={(v) => v && setDay(v)} />
            </span>
          )}
        </FilterBar>
      }
      drawer={openId ? <TaskDrawer taskId={openId} onClose={() => setOpen(null)} onChanged={refresh} canManage={canManage} /> : null}
    >
      <DataGrid<WorkTaskView>
        id="tasks-board"
        caption="Tasks"
        rows={listQuery.isLoading ? null : rows}
        loading={listQuery.isLoading}
        error={listQuery.isError ? 'Could not load the tasks.' : null}
        onRetry={() => void listQuery.refetch()}
        rowKey={(t) => t.id}
        onRowClick={(t) => setOpen(t.id)}
        rowActionLabel={(t) => `Open ${t.type}`}
        search={{ placeholder: 'Search tasks' }}
        empty={{
          icon: ListTodo,
          title: needs
            ? 'No task is waiting for a person'
            : status === 'live' ? 'Nothing live on this day' : status === 'all' ? 'No tasks on this day' : 'Nothing in this state on this day',
          description: needs
            ? 'Every open task has someone on it.'
            : status === 'live' ? 'Tasks appear as they are created, and each is assigned as it arrives.' : 'Change the day or the state to see more.',
          // The header's New task is the page's one gold action; this twin is outline.
          action: canManage ? (
            <Button variant="outline" onClick={() => setCreating(true)}>
              <Plus className="mr-2 h-4 w-4" /> New task
            </Button>
          ) : undefined,
        }}
        columns={[
          {
            key: 'type',
            header: 'Task',
            accessor: (t) => t.type,
            primary: true,
            sortable: true,
            cell: (t) => (
              <span className="flex flex-col">
                <span className="font-medium text-ink">{t.type}</span>
                <span className="text-xs2 text-ink-muted">
                  {CAP_LABEL.get(t.capability) ?? t.capability}
                  {t.reference ? ` · ${t.reference}` : ''}
                </span>
              </span>
            ),
          },
          {
            key: 'where',
            header: 'Where',
            accessor: (t) => `${t.locationName}${t.area ? ` · ${t.area}` : ''}`,
            cardMeta: true,
            sortable: true,
          },
          {
            key: 'window',
            header: 'Window',
            accessor: (t) => t.windowStart,
            sortable: true,
            className: 'tabular-nums',
            cell: (t) => (
              <span className="flex flex-col">
                <span>{fmtShiftRangeTz(t.windowStart, t.windowEnd, zoneFor(t.locationId))}</span>
                <span className="text-xs2 text-ink-muted">{fmtDateTz(t.windowStart, zoneFor(t.locationId))} · {t.estimatedMinutes} min</span>
              </span>
            ),
          },
          {
            key: 'risk',
            header: 'Risk',
            accessor: (t) => t.risk,
            sortable: true,
            cell: (t) =>
              t.risk === 'HIGH' ? (
                <span className="inline-flex items-center gap-1 text-alert">
                  <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" /> High
                </span>
              ) : (
                <span className="text-ink-muted">{WORK_TASK_RISK_LABELS[t.risk].replace(' risk', '')}</span>
              ),
          },
          {
            key: 'holder',
            header: 'Held by',
            accessor: (t) => t.assignment?.workerName ?? (t.status === 'QUEUED' ? 'Waiting for a person' : ''),
            sortable: true,
            cell: (t) =>
              t.assignment ? (
                <span className="inline-flex items-center gap-1.5">
                  <HolderIcon type={t.assignment.workerType} className="text-ink-muted" />
                  {t.assignment.workerName}
                </span>
              ) : t.queuedReason ? (
                <span className="text-warning">{t.queuedReason}</span>
              ) : (
                <span className="text-ink-muted">—</span>
              ),
          },
          {
            key: 'status',
            header: 'State',
            accessor: (t) => WORK_TASK_STATUS_LABELS[t.status],
            sortable: true,
            cardMeta: true,
            cell: (t) => <Badge variant={STATUS_VARIANT[t.status]}>{WORK_TASK_STATUS_LABELS[t.status]}</Badge>,
          },
        ]}
      />
      {creating && (
        <NewTaskDialog
          sites={sites ?? []}
          defaultLocationId={locationId}
          day={day ?? ymdLocal()}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            refresh();
            setOpen(id);
          }}
        />
      )}
    </ListTemplate>
  );
}
