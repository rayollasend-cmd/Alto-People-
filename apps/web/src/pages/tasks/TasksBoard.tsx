import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, Bot, Cpu, ListTodo, Plus, User } from 'lucide-react';
import { WORKER_CAPABILITIES, WORK_TASK_RISK_LABELS, WORK_TASK_STATUS_LABELS, type WorkTaskStatus, type WorkTaskView } from '@alto-people/shared';
import { useAuth, useTerm } from '@/lib/auth';
import { useOrgSites } from '@/lib/useOrgSites';
import { listTasks, getTaskSummary } from '@/lib/tasksApi';
import { fmtDateTz, fmtShiftRangeTz } from '@/lib/format';
import { ListTemplate } from '@/components/templates';
import { Badge, Button, MetricCard, SegmentedControl, Select } from '@/components/ui';
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

const STATUS_OPTIONS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'live', label: 'Live' },
  { value: 'queued', label: 'Waiting for a person' },
  { value: 'exceptions', label: 'Exceptions' },
  { value: 'done', label: 'Done' },
  { value: 'all', label: 'All' },
];

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

const dayKey = (d: Date) => d.toISOString().slice(0, 10);

export function TasksBoard() {
  const { can } = useAuth();
  const term = useTerm();
  const canManage = can('manage:scheduling');
  const sites = useOrgSites(true);
  const [params, setParams] = useSearchParams();
  const openId = params.get('task');
  const [locationId, setLocationId] = useState('');
  const [status, setStatus] = useState<StatusFilter>('live');
  const [day, setDay] = useState(() => dayKey(new Date()));
  const [creating, setCreating] = useState(false);
  const qc = useQueryClient();

  const from = `${day}T00:00:00.000Z`;
  const to = `${day}T23:59:59.999Z`;
  const tasksQuery = useQuery({
    queryKey: ['tasks', 'list', { locationId, from, to }],
    queryFn: () => listTasks({ locationId: locationId || null, from, to }),
    refetchInterval: 30_000,
  });
  const summaryQuery = useQuery({
    queryKey: ['tasks', 'summary', { locationId }],
    queryFn: () => getTaskSummary(locationId || null),
    refetchInterval: 30_000,
  });

  const rows = useMemo(() => {
    const all = tasksQuery.data?.tasks ?? [];
    switch (status) {
      case 'live':
        return all.filter((t) => LIVE.includes(t.status));
      case 'queued':
        return all.filter((t) => t.status === 'QUEUED');
      case 'exceptions':
        return all.filter((t) => EXCEPTIONS.includes(t.status));
      case 'done':
        return all.filter((t) => t.status === 'DONE' || t.status === 'CANCELLED');
      default:
        return all;
    }
  }, [tasksQuery.data, status]);

  const setOpen = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('task', id);
    else next.delete('task');
    setParams(next, { replace: true });
  };

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['tasks'] });
  };

  const s = summaryQuery.data;
  const siteLabel = term('site');

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
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <MetricCard label="Live" value={s ? s.assigned + s.inProgress + s.open : '…'} hint="Assigned or in progress" />
          <MetricCard label="Waiting for a person" value={s ? s.queued : '…'} hint="The engine could not decide alone" accent={!!s && s.queued > 0} />
          <MetricCard label="Exceptions" value={s ? s.exceptions : '…'} hint="Stalled or failed" accent={!!s && s.exceptions > 0} deltaPositiveIsGood={false} />
          <MetricCard label="Done · 24h" value={s ? s.doneToday : '…'} hint="Closed in the last day" />
        </div>
      }
      filters={
        <div className="flex flex-wrap items-center gap-2">
          <Select size="sm" aria-label={`${siteLabel}`} value={locationId} onChange={(e) => setLocationId(e.target.value)} className="w-56">
            <option value="">Every {siteLabel.toLowerCase()}</option>
            {(sites ?? []).map((site) => (
              <option key={site.id} value={site.id}>
                {site.name}
              </option>
            ))}
          </Select>
          <input
            type="date"
            aria-label="Day"
            value={day}
            onChange={(e) => e.target.value && setDay(e.target.value)}
            className="h-8 coarse:h-11 rounded-md border border-line bg-surface px-2 text-xs coarse:text-base text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <SegmentedControl options={STATUS_OPTIONS} value={status} onChange={setStatus} ariaLabel="Task state" className="flex-wrap" />
        </div>
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
          title: status === 'live' ? 'Nothing live on this day' : 'Nothing here',
          description: status === 'live' ? 'Tasks appear as they are created; the engine assigns each one as it arrives.' : 'Change the day or the state to see more.',
          action: canManage ? (
            <Button onClick={() => setCreating(true)}>
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
                <span>{fmtShiftRangeTz(t.windowStart, t.windowEnd, 'UTC')}</span>
                <span className="text-xs2 text-ink-muted">{fmtDateTz(t.windowStart, 'UTC')} · {t.estimatedMinutes} min</span>
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
          day={day}
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
