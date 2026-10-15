import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { FLEET_PROVIDERS, type RobotRow } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDateTime } from '@/lib/format';
import { listRobots, sampleFleetNow } from '@/lib/robotsApi';
import { ListTemplate } from '@/components/templates';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { MetricCard } from '@/components/ui/MetricCard';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryError } from '@/components/ui/QueryError';
import { Skeleton } from '@/components/ui/Skeleton';
import { BatteryMeter, RobotStatusBadge, sampleLine } from './robotUi';

/**
 * Brief 3-1 — the fleet. Every robot in the registry with the fleet's
 * last reading: status, battery, task, where it is placed, whether its
 * site commissioning is signed and its checklist done. A row opens the
 * robot's record.
 */
export function RobotsHome() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const canManage = can('manage:org');
  const q = useQuery({ queryKey: ['robots', 'list'], queryFn: listRobots, refetchInterval: 60_000 });
  const sample = useMutation({
    mutationFn: sampleFleetNow,
    onSuccess: (r) => {
      toast.success(r.sampled === 1 ? 'Read 1 robot from the fleet.' : `Read ${r.sampled} robots from the fleet.`);
      void qc.invalidateQueries({ queryKey: ['robots'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not read the fleet.'),
  });

  const columns = useMemo<GridColumn<RobotRow>[]>(
    () => [
      {
        key: 'name',
        header: 'Robot',
        accessor: (r) => r.name,
        primary: true,
        sortable: true,
        searchable: true,
        cell: (r) => (
          <span className="flex flex-col">
            <Link to={`/robots/${r.id}`} className="inline-block py-0.5 font-medium text-ink underline decoration-line underline-offset-2 hover:text-accent">
              {r.name}
            </Link>
            <span className="text-xs2 text-ink-muted">{r.profile ? `${r.profile.manufacturer} ${r.profile.model} · ${r.profile.serial}` : 'No profile yet'}</span>
          </span>
        ),
      },
      {
        key: 'status',
        header: 'Status',
        accessor: (r) => r.latest?.status ?? '',
        sortable: true,
        cardMeta: true,
        cell: (r) => (
          <span className="flex flex-col gap-1">
            <RobotStatusBadge status={r.latest?.status} />
            <span className="text-xs2 text-ink-muted">{r.latest ? sampleLine(r.latest) : 'No reading yet'}</span>
          </span>
        ),
      },
      {
        key: 'battery',
        header: 'Battery',
        accessor: (r) => r.latest?.batteryPct ?? null,
        sortable: true,
        cell: (r) => <BatteryMeter pct={r.latest?.batteryPct} />,
      },
      {
        key: 'site',
        header: 'Site',
        accessor: (r) => r.site?.name ?? '',
        sortable: true,
        searchable: true,
        cell: (r) => (r.site ? r.site.name : <span className="text-ink-muted">Not placed</span>),
      },
      {
        key: 'readiness',
        header: 'Ready for a shift',
        accessor: (r) => (r.commissioned && r.checklistReady ? 'yes' : 'no'),
        cell: (r) => (
          <span className="flex flex-wrap gap-1">
            <Badge variant={r.commissioned ? 'success' : 'pending'} size="sm">
              {r.commissioned ? 'Commissioned' : 'Not commissioned'}
            </Badge>
            <Badge variant={r.checklistReady ? 'success' : 'outline'} size="sm">
              {r.checklistReady ? 'Checklist done' : 'Checklist due'}
            </Badge>
          </span>
        ),
      },
      {
        key: 'owner',
        header: 'Owner',
        accessor: (r) => r.owner?.name ?? '',
        sortable: true,
        cell: (r) => r.owner?.name ?? <span className="text-ink-muted">—</span>,
      },
      {
        key: 'lastSeen',
        header: 'Last reading',
        accessor: (r) => r.latest?.at ?? '',
        sortable: true,
        cell: (r) => (r.latest ? fmtDateTime(r.latest.at) : '—'),
      },
    ],
    [],
  );

  const providerLabel = FLEET_PROVIDERS.find((p) => p.key === q.data?.provider)?.label ?? 'Simulated fleet';

  return (
    // Design system §4.2: the List template. The fleet's numbers are the summary; the grid is the list.
    <ListTemplate
      title="Robots"
      subtitle={`Every robot in the registry with its fleet reading. Connected to ${providerLabel}.`}
      breadcrumbs={[{ label: 'Workforce', to: '/workers' }, { label: 'Robots' }]}
      secondaryActions={
        canManage ? (
          <Button variant="ghost" size="sm" onClick={() => sample.mutate()} loading={sample.isPending}>
            <RefreshCw className="h-4 w-4" />
            Read the fleet now
          </Button>
        ) : undefined
      }
      primaryAction={
        canManage ? (
          <Button asChild>
            <Link to="/workers?type=ROBOT">
              <Bot className="h-4 w-4" />
              Add a robot
            </Link>
          </Button>
        ) : undefined
      }
      summary={
        q.data ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <MetricCard label="Robots" value={q.data.counts.total} />
            <MetricCard label="Working" value={q.data.counts.working} />
            <MetricCard label="Charging" value={q.data.counts.charging} />
            <MetricCard label="Idle" value={q.data.counts.idle} />
            <MetricCard label="Errors or stopped" value={q.data.counts.errors + q.data.counts.stopped} accent={q.data.counts.errors + q.data.counts.stopped > 0} />
            <MetricCard label="Average battery" value={q.data.counts.avgBatteryPct === null ? '—' : `${q.data.counts.avgBatteryPct}%`} />
          </div>
        ) : null
      }
    >
      {q.isError ? (
        <QueryError what="the robots" query={q} />
      ) : q.isPending ? (
        <Skeleton className="h-64" />
      ) : q.data.robots.length === 0 ? (
        <EmptyState icon={Bot} title="No robots yet" description="Add a robot on the Workforce roster; its profile, commissioning and checklist live here." />
      ) : (
        <DataGrid id="robots" caption="Robots" rows={q.data.robots} rowKey={(r) => r.id} columns={columns} onRowClick={(r) => navigate(`/robots/${r.id}`)} rowActionLabel={(r) => `Open ${r.name}`} />
      )}
    </ListTemplate>
  );
}
