import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, Bot, Cpu, ListTodo, Plus, User } from '@/components/ui/icons';
import { WORKER_CAPABILITIES, WORK_TASK_RISK_LABELS, WORK_TASK_STATUS_LABELS, type WorkTaskStatus, type WorkTaskView } from '@alto-people/shared';
import { useAuth, useTerm } from '@/lib/auth';
import { useOrgSites } from '@/lib/useOrgSites';
import { listTasks, getTaskDay } from '@/lib/tasksApi';
import { fmtDateTz, fmtShiftRangeTz, ymdLocal } from '@/lib/format';
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
  const sites = useOrgSites(true);
  const [params, setParams] = useSearchParams();
  const openId = params.get('task');
  // Site, day and state live in the URL (?site=&day=&status=), so a link
  // or a notification opens the same board (F500 G2).
  const [locationId, setLocationId] = useUrlState<string>('site', '', urlString);
  const [status, setStatus] = useUrlParam<StatusFilter>('status', 'live', STATUS_VALUES);
  // The site's day (F500 SH-4): "today" on the floor's own clock, from the
  // API (apps/api/src/lib/siteDay.ts) — never the browser's UTC date, which
  // after 5 PM Pacific was already tomorrow. A day the person picks wins.
  const [pickedDay, setDay] = useUrlState<string>('day', '', urlDay);
  const todayQuery = useQuery({ queryKey: ['tasks', 'day', locationId], queryFn: () => getTaskDay(locationId || null), staleTime: 60_000 });
  const day = pickedDay || todayQuery.data?.day || (todayQuery.isError ? ymdLocal() : null);
  const dayZone = todayQuery.data?.timezone ?? null;
  // A task's window reads on its own site's clock (it read in UTC: a 9 AM
  // task in Panama City showed 2:00 PM).
  const zoneOf = useMemo(() => new Map((sites ?? []).map((site) => [site.id, site.timezone])), [sites]);
  const [creating, setCreating] = useState(false);
  const qc = useQueryClient();

  const tasksQuery = useQuery({
    queryKey: ['tasks', 'list', { locationId, day }],
    queryFn: () => listTasks({ locationId: locationId || null, day }),
    enabled: day !== null,
    refetchInterval: 30_000,
  });
  const rows = useMemo(() => {
    const all = tasksQuery.data?.tasks ?? [];
    return status === 'all' ? all : all.filter((t) => bucketOf(t.status) === status);
  }, [tasksQuery.data, status]);
  // The tiles count the same day's list the grid shows, so a number and its
  // rows always agree (the 24h summary disagreed with a per-day list).
  const counts = useMemo(() => countByBucket(tasksQuery.data?.tasks ?? null), [tasksQuery.data]);

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
    onClick: () => setStatus(status === key ? 'all' : key),
    selected: status === key,
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
        // The tiles ARE the state filter (F500 G2: tiles and a chip row
        // said the same four things). Tap the picked one again for all.
        <MetricStrip label="Tasks on this day by state">
          <MetricCard compact label="Live" value={counts ? counts.live : '…'} hint="Assigned or in progress" {...tile('live')} />
          <MetricCard compact label="Waiting for a person" value={counts ? counts.queued : '…'} hint="Needs someone to choose who does it" tone={counts && counts.queued > 0 ? 'warning' : 'default'} {...tile('queued')} />
          <MetricCard compact label="Exceptions" value={counts ? counts.exceptions : '…'} hint="Stalled or failed" tone={counts && counts.exceptions > 0 ? 'alert' : 'default'} {...tile('exceptions')} />
          <MetricCard compact label="Done" value={counts ? counts.done : '…'} hint="Finished or cancelled" {...tile('done')} />
        </MetricStrip>
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
            status !== 'all' ? (
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
          <span title={dayZone ? `The day on the ${dayZone.replace(/^.*\//, '').replace(/_/g, ' ')} clock` : undefined}>
            <DateField size="sm" aria-label="Day" value={day ?? ''} clearable={false} onChange={(v) => v && setDay(v)} />
          </span>
        </FilterBar>
      }
      drawer={openId ? <TaskDrawer taskId={openId} onClose={() => setOpen(null)} onChanged={refresh} canManage={canManage} /> : null}
    >
      <DataGrid<WorkTaskView>
        id="tasks-board"
        caption="Tasks"
        rows={tasksQuery.isLoading ? null : rows}
        loading={tasksQuery.isLoading}
        error={tasksQuery.isError ? 'Could not load the tasks.' : null}
        onRetry={() => void tasksQuery.refetch()}
        rowKey={(t) => t.id}
        onRowClick={(t) => setOpen(t.id)}
        rowActionLabel={(t) => `Open ${t.type}`}
        search={{ placeholder: 'Search tasks' }}
        empty={{
          icon: ListTodo,
          title: status === 'live' ? 'Nothing live on this day' : status === 'all' ? 'No tasks on this day' : 'Nothing in this state on this day',
          description: status === 'live' ? 'Tasks appear as they are created, and each is assigned as it arrives.' : 'Change the day or the state to see more.',
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
                <span>{fmtShiftRangeTz(t.windowStart, t.windowEnd, zoneOf.get(t.locationId) ?? dayZone)}</span>
                <span className="text-xs2 text-ink-muted">{fmtDateTz(t.windowStart, zoneOf.get(t.locationId) ?? dayZone)} · {t.estimatedMinutes} min</span>
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
