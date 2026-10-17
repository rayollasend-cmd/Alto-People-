import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, Bot, Hand, OctagonX, Play, ShieldAlert, ShieldCheck, Users } from 'lucide-react';
import { ROBOT_STATUS_LABELS, WORKER_STATUS_LABELS, type ControlRoomException, type ControlRoomResponse, type ControlRoomRobot, type ControlRoomWaiting } from '@alto-people/shared';
import { DeskTemplate } from '@/components/templates';
import { AgentGlyph } from '@/components/agents/AgentGlyph';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { MetricCard } from '@/components/ui/MetricCard';
import { QueryError } from '@/components/ui/QueryError';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { ApiError } from '@/lib/api';
import { useAuth, useTenant } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { usePrompt } from '@/lib/confirm';
import { fmtRelativeDate, fmtTime } from '@/lib/format';
import { associatePhotoUrl } from '@/lib/photoUrl';
import { resumeAllAgents } from '@/lib/agentsApi';
import { getControlRoom, listControlRoomSites } from '@/lib/controlRoomApi';
import { resumeRobot, stopRobot } from '@/lib/robotsApi';
import { handOffTask } from '@/lib/tasksApi';
import { SuspendAllDialog } from '@/pages/admin/AgentRegistryAdmin';
import { BatteryMeter, RobotStatusBadge } from '@/pages/robots/robotUi';

const POLL_MS = 15_000;

/**
 * Brief 3-3 — the control room (design system §4.5, a Desk): one screen per
 * site of every worker on shift, person, agent and robot, with the
 * exceptions and what waits for a person. The queue column is the live
 * strip, the map and the exceptions; the item column is the workers. On a
 * tablet the two stack; every action has a 44px target and a confirmation.
 */
export function ControlRoomPage() {
  const { can } = useAuth();
  const { moduleOn } = useTenant();
  const canAct = can('manage:scheduling');
  const canSuspendAll = can('manage:org');
  const [searchParams, setSearchParams] = useSearchParams();
  const sites = useQuery({ queryKey: ['control-room', 'sites'], queryFn: listControlRoomSites, staleTime: 5 * 60_000 });
  const siteParam = searchParams.get('site') ?? '';
  const locationId = siteParam || sites.data?.sites[0]?.id || '';
  // The first site is the default once the list arrives; the URL carries the choice.
  useEffect(() => {
    if (!siteParam && sites.data?.sites[0]) {
      const next = new URLSearchParams(searchParams);
      next.set('site', sites.data.sites[0].id);
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteParam, sites.data]);
  const pickSite = (id: string) => {
    const next = new URLSearchParams(searchParams);
    next.set('site', id);
    setSearchParams(next);
  };
  const [crew, setCrew] = useState<'all' | 'people' | 'robots' | 'agents'>('all');

  const room = useQuery({
    queryKey: ['control-room', locationId],
    queryFn: () => getControlRoom(locationId),
    enabled: locationId.length > 0,
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
  });
  const data = room.data;
  const [suspending, setSuspending] = useState(false);
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ['control-room'] });

  const counts = data ? (
    <span className="text-xs text-ink-muted" aria-live="polite">
      Live · as of {fmtTime(data.asOf)} · every 15 s
    </span>
  ) : undefined;

  const filters = (
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor="control-room-site" className="sr-only">
        Site
      </label>
      <Select id="control-room-site" size="sm" value={locationId} onChange={(e) => pickSite(e.target.value)} className="w-64" disabled={!sites.data}>
        {(sites.data?.sites ?? []).map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
            {s.clientName ? ` · ${s.clientName}` : ''}
          </option>
        ))}
      </Select>
      <div role="radiogroup" aria-label="Crew" className="inline-flex gap-0.5 rounded-md border border-line bg-navy-secondary/30 p-0.5">
        {(
          [
            ['all', 'Everyone'],
            ['people', 'People'],
            ['robots', 'Robots'],
            ['agents', 'Agents'],
          ] as const
        ).map(([key, label]) => (
          <Button key={key} size="xs" variant={crew === key ? 'secondary' : 'ghost'} role="radio" aria-checked={crew === key} onClick={() => setCrew(key)} className="coarse:h-11 coarse:px-4">
            {label}
          </Button>
        ))}
      </div>
    </div>
  );

  const actions =
    canSuspendAll && data ? (
      data.agentsSuspended ? (
        <ResumeAllButton onDone={refresh} />
      ) : (
        <Button variant="outline" className="border-alert/50 text-alert hover:border-alert hover:text-alert coarse:h-11" onClick={() => setSuspending(true)}>
          <ShieldAlert className="h-4 w-4" aria-hidden="true" /> Suspend all agents
        </Button>
      )
    ) : undefined;

  const queue = !data ? (
    room.error ? (
      <QueryError what="the control room" query={room} />
    ) : (
      <div className="space-y-3" aria-busy="true" aria-label="Loading the control room">
        <Skeleton className="h-24" />
        <Skeleton className="h-64" />
      </div>
    )
  ) : (
    <div className="space-y-[var(--d-stack)]">
      <div className="grid grid-cols-2 gap-[var(--d-stack)] xl:grid-cols-4">
        <MetricCard label="On the floor" value={String(data.strip.onFloor)} hint={`of ${data.strip.expectedNow} on shift now`} accent={data.strip.onFloor < data.strip.expectedNow} />
        {data.roboticsOn && <MetricCard label="Robots working" value={String(data.strip.robotsRunning)} hint={`${data.strip.robotsOnShift} on shift`} />}
        <MetricCard label="Exceptions" value={String(data.strip.exceptions)} accent={data.strip.exceptions > 0} hint={data.strip.exceptions ? 'Need a hand' : 'None right now'} />
        <MetricCard label="Waiting for a person" value={String(data.strip.waiting)} accent={data.strip.waiting > 0} hint={data.strip.waiting ? 'Decisions queued' : 'Nothing queued'} />
      </div>

      {data.agentsSuspended && (
        <p role="alert" className="flex items-center gap-2 rounded-md border border-alert/40 bg-alert/10 px-3 py-2 text-sm text-ink">
          <ShieldAlert className="h-4 w-4 shrink-0 text-alert" aria-hidden="true" />
          Every agent is suspended. Nothing below is automated until a person lifts the switch.
        </p>
      )}

      {data.roboticsOn && (
        <section aria-labelledby="control-room-span" className={cn('rounded-md border px-3 py-2 text-sm', data.span.exceeded || (data.span.robots > 0 && data.span.leads === 0) ? 'border-caution/50 bg-caution/10' : 'border-line bg-surface')}>
          <div id="control-room-span" className="text-xs2 font-medium uppercase tracking-[0.14em] text-ink-muted">
            Span of control
          </div>
          <div className="mt-0.5 text-ink">{data.span.text}</div>
        </section>
      )}

      {data.roboticsOn && <SiteMap data={data} />}

      <section aria-labelledby="control-room-exceptions">
        <SectionTitle title="Exceptions" />
        {data.exceptions.length === 0 ? (
          <EmptyState icon={ShieldCheck} title="Nothing is wrong" description="No exception on the floor right now." className="mt-2" />
        ) : (
          <ul className="mt-2 divide-y divide-line rounded-md border border-line">
            {data.exceptions.map((e) => (
              <ExceptionRow key={e.id} e={e} canAct={canAct} onChanged={refresh} />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="control-room-waiting">
        <SectionTitle title="Waiting for a person" />
        {data.waiting.length === 0 ? (
          <EmptyState icon={Hand} title="Nothing waits" description="No decision is queued for a person." className="mt-2" />
        ) : (
          <ul className="mt-2 divide-y divide-line rounded-md border border-line">
            {data.waiting.map((w) => (
              <WaitingRow key={w.id} w={w} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );

  const item = !data ? null : (
    <div className="space-y-[var(--d-stack)]">
      {(crew === 'all' || crew === 'people') && (
        <section aria-labelledby="control-room-people">
          <SectionTitle title={`People on shift (${data.people.length})`} />
          {data.people.length === 0 ? (
            <EmptyState icon={Users} title="No one is on shift" description="Nobody is scheduled at this site right now." className="mt-2" />
          ) : (
            <ul className="mt-2 divide-y divide-line rounded-md border border-line">
              {data.people.map((p) => (
                <li key={p.associateId} className="flex flex-wrap items-center gap-3 px-3 py-2">
                  <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', p.clockedIn ? 'bg-positive' : p.late ? 'bg-negative' : 'bg-ink-subtle')} aria-hidden="true" />
                  <Avatar src={associatePhotoUrl(p.associateId)} name={p.name} size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link to={p.workerId ? `/people?associateId=${p.associateId}` : '/people'} className="font-medium text-ink hover:text-accent">
                        {p.name}
                      </Link>
                      {p.crewLead && (
                        <Badge variant="accent" size="sm" withDot={false}>
                          Crew lead
                        </Badge>
                      )}
                      <Badge variant={p.clockedIn ? 'success' : p.late ? 'destructive' : 'outline'} size="sm">
                        {p.clockedIn ? 'On the floor' : p.late ? 'Late' : 'Not punched in yet'}
                      </Badge>
                    </div>
                    <div className="text-xs text-ink-muted">
                      {p.position} · {fmtTime(p.shiftStart)}–{fmtTime(p.shiftEnd)}
                      {p.clockInAt ? ` · in at ${fmtTime(p.clockInAt)}` : ''}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {data.roboticsOn && (crew === 'all' || crew === 'robots') && (
        <section aria-labelledby="control-room-robots">
          <SectionTitle title={`Robots (${data.robots.length})`} />
          {data.robots.length === 0 ? (
            <EmptyState icon={Bot} title="No robots here" description="No robot is placed at this site or on shift here." className="mt-2" />
          ) : (
            <ul className="mt-2 divide-y divide-line rounded-md border border-line">
              {data.robots.map((r) => (
                <RobotRow key={r.id} r={r} canAct={canAct} onChanged={refresh} />
              ))}
            </ul>
          )}
        </section>
      )}

      {(crew === 'all' || crew === 'agents') && (
        <section aria-labelledby="control-room-agents">
          <SectionTitle title={`Agents (${data.agents.length})`} />
          {data.agents.length === 0 ? (
            <EmptyState icon={Bot} title="No agents" description="No agent is registered for this organization." className="mt-2" />
          ) : (
            <ul className="mt-2 divide-y divide-line rounded-md border border-line">
              {data.agents.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                  <AgentGlyph family={a.family} status={a.status} size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link to={`/agents/${a.id}`} className="font-medium text-ink hover:text-accent">
                        {a.name}
                      </Link>
                      <Badge variant={a.status === 'ACTIVE' ? 'success' : a.status === 'SUSPENDED' ? 'destructive' : 'pending'} size="sm">
                        {WORKER_STATUS_LABELS[a.status]}
                      </Badge>
                      {a.pendingApprovals > 0 && (
                        <Badge variant="pending" size="sm" withDot={false}>
                          {a.pendingApprovals} waiting
                        </Badge>
                      )}
                    </div>
                    <div className="truncate text-xs text-ink-muted">
                      {a.capability ?? 'No capability named'} · {a.lastActiveAt ? `active ${fmtRelativeDate(a.lastActiveAt)}` : 'never active'}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );

  return (
    <>
      <DeskTemplate
        title="Control room"
        topbarTitle="Control room"
        subtitle={data ? `${data.site.name}${data.site.clientName ? ` · ${data.site.clientName}` : ''}: people, robots and agents on one screen.` : 'People, robots and agents on one screen, per site.'}
        breadcrumbs={[{ label: 'Operations' }, { label: 'Control room' }]}
        counts={counts}
        actions={actions}
        filters={filters}
        queue={queue}
        item={item}
        itemOpen={!!data && !!moduleOn}
      />
      {suspending && data && (
        <SuspendAllDialog
          agents={data.agents.filter((a) => a.status !== 'SUSPENDED').length}
          onClose={() => setSuspending(false)}
          onSuspended={async () => {
            setSuspending(false);
            await refresh();
          }}
        />
      )}
    </>
  );
}

function ResumeAllButton({ onDone }: { onDone: () => Promise<unknown> }) {
  const m = useMutation({
    mutationFn: resumeAllAgents,
    onSuccess: async () => {
      toast.success('Agents resumed. No credential was restored — issue new ones per agent.');
      await onDone();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not resume the agents.'),
  });
  return (
    <Button variant="secondary" className="coarse:h-11" loading={m.isPending} onClick={() => m.mutate()}>
      Resume all agents
    </Button>
  );
}

function RobotRow({ r, canAct, onChanged }: { r: ControlRoomRobot; canAct: boolean; onChanged: () => Promise<unknown> }) {
  const prompt = usePrompt();
  const act = useMutation({
    mutationFn: async (kind: 'stop' | 'resume') => {
      const note = await prompt({
        title: kind === 'stop' ? `Emergency stop ${r.name}?` : `Resume ${r.name}?`,
        reasonLabel: kind === 'stop' ? 'Why (goes on the log)' : 'Note (optional)',
        confirmLabel: kind === 'stop' ? 'Stop now' : 'Resume',
        required: kind === 'stop',
      });
      if (note === null) return null;
      return kind === 'stop' ? stopRobot(r.id, note || undefined) : resumeRobot(r.id, note || undefined);
    },
    onSuccess: async (res, kind) => {
      if (res === null) return;
      toast.success(kind === 'stop' ? `${r.name} stopped. Every task it held goes to a person.` : `${r.name} is back.`);
      await onChanged();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'That did not go through.'),
  });
  const stopped = r.status === 'SUSPENDED';
  return (
    <li className="flex flex-wrap items-center gap-3 px-3 py-2">
      <Bot className={cn('h-4 w-4 shrink-0', stopped ? 'text-negative' : 'text-ink-muted')} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link to={`/robots/${r.id}`} className="font-medium text-ink hover:text-accent">
            {r.name}
          </Link>
          {stopped ? (
            <Badge variant="destructive" size="sm">
              Emergency stop
            </Badge>
          ) : (
            <RobotStatusBadge status={r.fleetStatus} />
          )}
          {r.onShift && (
            <Badge variant="outline" size="sm" withDot={false}>
              On shift
            </Badge>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
          <BatteryMeter pct={r.batteryPct} className="w-20" />
          <span>{r.currentTask ?? (r.fleetStatus ? ROBOT_STATUS_LABELS[r.fleetStatus] : 'No reading')}</span>
          {r.readAt && <span>read {fmtRelativeDate(r.readAt)}</span>}
          {!r.commissioned && <span className="text-caution">Not commissioned here</span>}
          {r.onShift && !r.checklistReady && <span className="text-caution">Checklist not done</span>}
        </div>
      </div>
      {canAct && (
        <Button size="sm" variant={stopped ? 'secondary' : 'destructive'} className="coarse:h-11 coarse:min-w-11" loading={act.isPending} onClick={() => act.mutate(stopped ? 'resume' : 'stop')}>
          {stopped ? (
            <>
              <Play className="h-4 w-4" aria-hidden="true" /> Resume
            </>
          ) : (
            <>
              <OctagonX className="h-4 w-4" aria-hidden="true" /> Stop
            </>
          )}
        </Button>
      )}
    </li>
  );
}

function ExceptionRow({ e, canAct, onChanged }: { e: ControlRoomException; canAct: boolean; onChanged: () => Promise<unknown> }) {
  const hand = useMutation({
    mutationFn: () => handOffTask(e.taskId!),
    onSuccess: async () => {
      toast.success('Handed to a person.');
      await onChanged();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'That did not go through.'),
  });
  const tone = e.kind === 'TASK_HANDED_OFF' || e.kind === 'UNCONFIRMED_SHIFT' ? 'text-caution' : 'text-negative';
  return (
    <li className="flex flex-wrap items-center gap-3 px-3 py-2">
      <AlertTriangle className={cn('h-4 w-4 shrink-0', tone)} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          {e.link ? (
            <Link to={e.link} className="font-medium text-ink hover:text-accent">
              {e.title}
            </Link>
          ) : (
            <span className="font-medium text-ink">{e.title}</span>
          )}
          <Badge variant={tone === 'text-negative' ? 'destructive' : 'pending'} size="sm" withDot={false}>
            {EXCEPTION_LABEL[e.kind]}
          </Badge>
        </div>
        <div className="text-xs text-ink-muted">
          {e.detail}
          {e.at ? ` · ${fmtRelativeDate(e.at)}` : ''}
        </div>
      </div>
      {canAct && e.taskId && (e.kind === 'TASK_STALLED' || e.kind === 'TASK_FAILED') && (
        <Button size="sm" variant="secondary" className="coarse:h-11" loading={hand.isPending} onClick={() => hand.mutate()}>
          <Hand className="h-4 w-4" aria-hidden="true" /> Hand to a person
        </Button>
      )}
    </li>
  );
}

const EXCEPTION_LABEL: Record<ControlRoomException['kind'], string> = {
  TASK_STALLED: 'Task stalled',
  TASK_FAILED: 'Task failed',
  TASK_HANDED_OFF: 'Handed off',
  ROBOT_ERROR: 'Robot error',
  ROBOT_STOPPED: 'Emergency stop',
  ROBOT_OFFLINE: 'Robot offline',
  UNCONFIRMED_SHIFT: 'Not confirmed',
  NO_SHOW: 'No show',
  ZONE_OCCUPIED: 'Zone occupied',
};

function WaitingRow({ w }: { w: ControlRoomWaiting }) {
  return (
    <li className="flex flex-wrap items-center gap-3 px-3 py-2">
      <Hand className="h-4 w-4 shrink-0 text-caution" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <Link to={w.link} className="font-medium text-ink hover:text-accent">
          {w.title}
        </Link>
        <div className="text-xs text-ink-muted">
          {w.detail} · {fmtRelativeDate(w.at)}
        </div>
      </div>
      <Badge variant="pending" size="sm" withDot={false}>
        {w.kind === 'AGENT_APPROVAL' ? 'Agent asks' : 'Task queued'}
      </Badge>
    </li>
  );
}

/**
 * The site's map: its safety zones as the rectangles the zones editor
 * draws, with each robot's last known position. People carry no position
 * (a punch says they are on the floor, not where), so they sit in a rail
 * beside the map and the map says so.
 */
function SiteMap({ data }: { data: ControlRoomResponse }) {
  const box = useMemo(() => {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const z of data.zones) {
      if (z.shape.type === 'rect') {
        xs.push(z.shape.x, z.shape.x + z.shape.w);
        ys.push(z.shape.y, z.shape.y + z.shape.h);
      } else for (const [x, y] of z.shape.points) {
        xs.push(x);
        ys.push(y);
      }
    }
    for (const r of data.robots) {
      if (r.x !== null && r.y !== null) {
        xs.push(r.x);
        ys.push(r.y);
      }
    }
    if (xs.length === 0) return null;
    const pad = 4;
    const minX = Math.min(...xs) - pad;
    const minY = Math.min(...ys) - pad;
    const w = Math.max(10, Math.max(...xs) - minX + pad);
    const h = Math.max(10, Math.max(...ys) - minY + pad);
    return { minX, minY, w, h };
  }, [data.zones, data.robots]);
  const onFloor = data.people.filter((p) => p.clockedIn);
  return (
    <section aria-labelledby="control-room-map" className="rounded-md border border-line bg-surface p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionTitle title="The floor" />
        <span className="text-xs text-ink-muted">Zones from the site map · robots at their last reading</span>
      </div>
      <div className="mt-2 grid gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        {box ? (
          <svg viewBox={`${box.minX} ${box.minY} ${box.w} ${box.h}`} role="img" aria-label={`Site map with ${data.zones.length} zones and ${data.robots.length} robots`} className="h-56 w-full rounded-md bg-navy-secondary/30 md:h-72">
            {data.zones.map((z) =>
              z.shape.type === 'rect' ? (
                <g key={z.id}>
                  <rect x={z.shape.x} y={z.shape.y} width={z.shape.w} height={z.shape.h} rx={1} className={z.guestOccupied ? 'fill-negative/20 stroke-negative' : 'fill-info/10 stroke-info/60'} strokeWidth={0.4} />
                  <text x={z.shape.x + 1} y={z.shape.y + 3} className="fill-ink" style={{ fontSize: 2.6 }}>
                    {z.name}
                    {z.guestOccupied ? ' · occupied' : ''}
                  </text>
                </g>
              ) : (
                <g key={z.id}>
                  <polygon points={z.shape.points.map((p) => p.join(',')).join(' ')} className={z.guestOccupied ? 'fill-negative/20 stroke-negative' : 'fill-info/10 stroke-info/60'} strokeWidth={0.4} />
                  <text x={z.shape.points[0]?.[0] ?? 0} y={(z.shape.points[0]?.[1] ?? 0) + 3} className="fill-ink" style={{ fontSize: 2.6 }}>
                    {z.name}
                  </text>
                </g>
              ),
            )}
            {data.robots
              .filter((r) => r.x !== null && r.y !== null)
              .map((r) => (
                <g key={r.id}>
                  <circle cx={r.x!} cy={r.y!} r={1.8} className={r.status === 'SUSPENDED' || r.fleetStatus === 'ERROR' ? 'fill-negative' : r.fleetStatus === 'WORKING' ? 'fill-positive' : 'fill-accent'} />
                  <text x={r.x! + 2.4} y={r.y! + 1} className="fill-ink" style={{ fontSize: 2.6 }}>
                    {r.name}
                  </text>
                </g>
              ))}
          </svg>
        ) : (
          <EmptyState icon={Bot} title="No map yet" description="Draw the site's safety zones, or wait for a robot's first reading." className="h-40" />
        )}
        <div className="text-sm">
          <div className="text-xs2 font-medium uppercase tracking-[0.14em] text-ink-muted">On the floor, no position</div>
          <p className="mt-1 text-xs text-ink-muted">A punch says a person is here, not where. {onFloor.length} on the floor now.</p>
          <ul className="mt-2 flex flex-wrap gap-1">
            {onFloor.slice(0, 12).map((p) => (
              <li key={p.associateId}>
                <Badge variant={p.crewLead ? 'accent' : 'outline'} size="sm" withDot={false}>
                  {p.name}
                </Badge>
              </li>
            ))}
            {onFloor.length > 12 && (
              <li>
                <Badge variant="outline" size="sm" withDot={false}>
                  +{onFloor.length - 12}
                </Badge>
              </li>
            )}
          </ul>
        </div>
      </div>
    </section>
  );
}
