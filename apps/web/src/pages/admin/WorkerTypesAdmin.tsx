import * as React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookUser, Bot, Plus, Users } from '@/components/ui/icons';
import { toast } from 'sonner';
import {
  WORK_STATUSES,
  WORKER_CAPABILITIES,
  WORKER_STATUS_LABELS,
  WORKER_TYPE_LABELS,
  type WorkStatus,
  type WorkStatusCounts,
  type WorkerStatus,
  type WorkerSummary,
  type WorkerType,
  capabilityDef,
} from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth, useTenant, useTerm } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { useUrlParam, useUrlWriter } from '@/lib/useUrlState';
import { fmtDate } from '@/lib/format';
import { associatePhotoUrl, userPhotoUrl } from '@/lib/photoUrl';
import { listAdminUsers } from '@/lib/usersAdminApi';
import { getAgentScorecard } from '@/lib/agentsApi';
import { listClientLocations, listClients } from '@/lib/clientsApi';
import {
  assignWorkerSite,
  createWorker,
  ensurePersonWorkers,
  listWorkers,
  updateWorker,
} from '@/lib/workersApi';
import { PageHeader, type PageAction } from '@/components/ui/PageHeader';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { PeopleStatusBadge, isWorkStatus, workStatusKeys } from '@/components/ui/PeopleStatusBadge';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { QueryError } from '@/components/ui/QueryError';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import '@/lib/i18n/en/people';

/**
 * The workforce roster (Brief 1D-1; UX upgrade step 5) — people, agents and
 * robots in one list, each row opening its record: a person in People, an
 * agent in Agents, a robot in Robots. A person answers to their manager; an
 * agent or a robot has an owner (a user who answers for it). People are
 * mirrored from the associate record by the server's sweep; robots are
 * added here; an agent is registered on the Agents page, the one form that
 * takes its profile (vendor, model, scopes, limits) — the roster's create
 * schema has none of that.
 */

type TypeFilter = 'ALL' | WorkerType;
const TYPE_OPTIONS: { value: TypeFilter; label: string }[] = [
  { value: 'PERSON', label: 'People' },
  { value: 'AGENT', label: 'Agents' },
  { value: 'ROBOT', label: 'Robots' },
  { value: 'ALL', label: 'All' },
];
const STATUSES: WorkerStatus[] = ['ONBOARDING', 'ACTIVE', 'SUSPENDED', 'OFFBOARDED'];
const STATUS_VARIANT: Record<WorkerStatus, 'pending' | 'success' | 'destructive' | 'outline'> = {
  ONBOARDING: 'pending',
  ACTIVE: 'success',
  SUSPENDED: 'destructive',
  OFFBOARDED: 'outline',
};
const TYPE_VARIANT: Record<WorkerType, 'default' | 'info' | 'accent'> = { PERSON: 'default', AGENT: 'info', ROBOT: 'accent' };
const CAP_LABEL = new Map<string, string>(WORKER_CAPABILITIES.map((c) => [c.code, c.label]));
/** A worker-type capability by its code, else an agent catalog capability by its key; the raw key only when neither knows it. */
const capLabel = (c: string): string => CAP_LABEL.get(c) ?? capabilityDef(c)?.label ?? c;

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    const code = (err as { code?: string }).code ?? '';
    if (code === 'owner_not_eligible') return 'A client portal account cannot own a worker.';
    if (code === 'owner_not_found') return 'That owner no longer exists.';
    if (code === 'person_follows_associate') return 'A person follows their associate record. Edit the associate instead.';
    if (code === 'site_not_found') return 'That site no longer exists.';
    return err.message || fallback;
  }
  return fallback;
}

function currentSites(w: WorkerSummary) {
  return w.sites.filter((s) => s.endedAt === null);
}

type GroupBy = 'none' | 'client' | 'store' | 'type';
const GROUP_NONE = '\u0000none';

/** "2 onboarding · 1 suspended" — everything that is not ACTIVE and not zero. */
function otherStatusesHint(counts: Record<WorkerStatus, number> | undefined): string {
  if (!counts) return '';
  const parts = STATUSES.filter((s) => s !== 'ACTIVE' && counts[s] > 0).map((s) => `${counts[s]} ${WORKER_STATUS_LABELS[s].toLowerCase()}`);
  return parts.length ? parts.join(' · ') : 'All active';
}

/**
 * The photo the API says is on file (null: none — initials, no request for a
 * photo that isn't there); an older response without the field falls back
 * to guessing the URL.
 */
function photoOf(fromApi: string | null | undefined, guess: () => string | undefined): string | undefined {
  if (fromApi === undefined) return guess();
  return fromApi ?? undefined;
}

/** A person's face and name, opening their record when they have one. */
function Person({ name, email, photo, to }: { name: string; email?: string | null; photo: string | undefined; to: string | null }) {
  const inner = (
    <>
      <Avatar src={photo} name={name} email={email} size="xs" />
      <span className="truncate">{name}</span>
    </>
  );
  return to ? (
    <Link to={to} className="inline-flex min-w-0 items-center gap-2 hover:text-accent" onClick={(e) => e.stopPropagation()} title={email ?? undefined}>
      {inner}
    </Link>
  ) : (
    <span className="inline-flex min-w-0 items-center gap-2" title={email ?? undefined}>
      {inner}
    </span>
  );
}

const TYPE_KEYS = ['PERSON', 'AGENT', 'ROBOT', 'ALL'] as const satisfies readonly TypeFilter[];
const GROUP_KEYS = ['store', 'client', 'type', 'none'] as const satisfies readonly GroupBy[];
/** One `?status=` param: a person's work status on People, an account status on Agents / Robots / All. */
const STATUS_KEYS: readonly string[] = [...new Set<string>([...WORK_STATUSES, ...STATUSES])];

/**
 * "0 working · 8 paused" — the part of "on the books" worth a glance, in the
 * People page's words. Both are inside the on-the-books number; onboarding
 * people are not (they aren't hired yet), so they stay out of this line.
 */
function peopleHint(p: WorkStatusCounts | undefined, t: (k: MessageKey) => string): string {
  if (!p) return '';
  const parts = [`${p.ACTIVE.toLocaleString()} ${t('people.ws.ACTIVE').toLowerCase()}`];
  if (p.DEACTIVATED > 0) parts.push(`${p.DEACTIVATED.toLocaleString()} ${t('people.ws.DEACTIVATED').toLowerCase()}`);
  return parts.join(' · ');
}

/** Every worker of a type, any status — 0 means the type has none at all (not "0 active"). */
function totalOf(counts: Record<WorkerStatus, number> | undefined): number {
  return counts ? STATUSES.reduce((n, s) => n + counts[s], 0) : 0;
}

export function WorkerTypesAdmin() {
  const { can } = useAuth();
  const { t } = useI18n();
  const tenant = useTenant();
  const term = useTerm();
  const canManage = can('manage:org');
  const canInvite = can('manage:onboarding') || can('invite:onboarding');
  const robotics = !!tenant.modules.robotics;
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  // People › Workforce roster opens on people: ?type=AGENT / ROBOT (the Agents
  // and Robots pages link here) or ALL shows the rest. Agents and robots are
  // created only from their own type, so the header never offers "Add robot"
  // over a list of people.
  const typeKeys = robotics ? TYPE_KEYS : TYPE_KEYS.filter((k) => k !== 'ROBOT');
  const [typeFilter] = useUrlParam<TypeFilter>('type', 'PERSON', typeKeys);
  // A staffing roster reads by where people work: group by client or store.
  const hasClients = tenant.modules.clientPortal;
  const [groupBy, setGroupBy] = useUrlParam<GroupBy>('group', 'store', GROUP_KEYS);
  const [statusParam, setStatusParam] = useUrlParam<string>('status', '', STATUS_KEYS);
  const writeUrl = useUrlWriter();
  /** A new type clears the status: the two types read different status words. */
  const setTypeFilter = (next: TypeFilter) =>
    writeUrl((p) => {
      if (next === 'PERSON') p.delete('type');
      else p.set('type', next);
      p.delete('status');
    });
  const personView = typeFilter === 'PERSON';
  const statusFilter = personView
    ? ((WORK_STATUSES as readonly string[]).includes(statusParam) ? (statusParam as WorkStatus) : '')
    : ((STATUSES as readonly string[]).includes(statusParam) ? (statusParam as WorkerStatus) : '');
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [ensuring, setEnsuring] = useState(false);
  const addTarget = searchParams.get('add');
  useEffect(() => {
    if (!addTarget) return;
    const next = new URLSearchParams(searchParams);
    next.delete('add');
    setSearchParams(next, { replace: true });
    if (canManage) setCreating(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addTarget, canManage]);

  // One read: the roster is capped server-side and the counts, the tiles and
  // every filter below come from it (a second, filtered read fetched the
  // same rows again).
  const roster = useQuery({ queryKey: ['workers', 'list', {}], queryFn: () => listWorkers({}) });

  const withoutOwner = roster.data?.withoutOwner.length ?? 0;
  const counts = roster.data?.counts;
  const people = roster.data?.people;
  const peopleMissing = roster.data?.associatesWithoutWorker ?? 0;
  const allRows = roster.data?.workers;
  const rows = useMemo(
    () =>
      (allRows ?? []).filter((w) => {
        if (typeFilter !== 'ALL' && w.type !== typeFilter) return false;
        if (!statusFilter) return true;
        return personView ? w.workStatus === statusFilter : w.status === statusFilter;
      }),
    [allRows, typeFilter, statusFilter, personView],
  );
  // UX upgrade §5.6: the roster carries each agent's scorecard (the last seven days)
  // the way its record does. Agents are few; one small read each.
  const agentRows = rows.filter((w) => w.type === 'AGENT' && w.status !== 'OFFBOARDED');
  const scorecards = useQueries({
    queries: agentRows.map((w) => ({ queryKey: ['agents', 'scorecard', w.id, 7], queryFn: () => getAgentScorecard(w.id, 7), staleTime: 60_000 })),
  });
  const scorecardById = new Map(agentRows.map((w, i) => [w.id, scorecards[i]?.data ?? null]));
  const editing = editingId ? (allRows?.find((w) => w.id === editingId) ?? null) : null;

  const refetchAll = () => qc.invalidateQueries({ queryKey: ['workers'] });

  const onEnsure = async () => {
    setEnsuring(true);
    try {
      const { made } = await ensurePersonWorkers();
      toast.success(made === 1 ? '1 person record created.' : `${made} person records created.`);
      await refetchAll();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not create the person records.'));
    } finally {
      setEnsuring(false);
    }
  };

  const showsAgents = typeFilter === 'AGENT' || typeFilter === 'ALL';
  const hasAgents = rows.some((w) => w.type === 'AGENT');
  const windowDays = people?.windowDays ?? 14;

  const columns = useMemo<GridColumn<WorkerSummary>[]>(
    () => [
      {
        key: 'name',
        header: typeFilter === 'PERSON' ? term('worker') : 'Worker',
        accessor: (w) => w.name,
        primary: true,
        sortable: true,
        searchable: true,
        width: '15rem',
        // The row opens the record behind it: a person in People, an agent in
        // Agents (UX upgrade step 5: one roster, the records where they live).
        cell: (w) => {
          const to = w.type === 'PERSON' && w.associateId ? `/people/${w.associateId}` : w.type === 'AGENT' ? `/agents/${w.id}` : w.type === 'ROBOT' ? `/robots/${w.id}` : null;
          return (
            <span className="inline-flex min-w-0 items-center gap-2 whitespace-nowrap">
              {to ? (
                <Link to={to} className="inline-block truncate py-0.5 font-medium text-ink underline decoration-line underline-offset-2 hover:text-accent">
                  {w.name}
                </Link>
              ) : (
                <span className="truncate font-medium text-ink">{w.name}</span>
              )}
              {/* The type only says something when the list mixes them. */}
              {typeFilter === 'ALL' && (
                <Badge variant={TYPE_VARIANT[w.type]} size="sm">
                  {WORKER_TYPE_LABELS[w.type]}
                </Badge>
              )}
            </span>
          );
        },
        csv: (w) => `${w.name} (${WORKER_TYPE_LABELS[w.type]})`,
      },
      {
        key: 'owner',
        // A person answers to their manager; an agent or a robot to its owner. The
        // header says which when the type chip has picked one, both otherwise.
        header: typeFilter === 'PERSON' ? term('manager') : typeFilter === 'ALL' ? `${term('manager')} or owner` : 'Owner',
        accessor: (w) => (w.type === 'PERSON' ? w.manager?.name ?? '' : w.owner?.name ?? w.owner?.email ?? ''),
        sortable: true,
        searchable: true,
        cardMeta: true,
        width: '13rem',
        cell: (w) => {
          if (w.type === 'PERSON') {
            return w.manager ? <Person name={w.manager.name} photo={photoOf(w.manager.photoUrl, () => associatePhotoUrl(w.manager!.associateId))} to={`/people/${w.manager.associateId}`} /> : <span className="text-silver/60">—</span>;
          }
          return w.owner ? (
            <Person name={w.owner.name || w.owner.email} email={w.owner.email} photo={photoOf(w.owner.photoUrl, () => userPhotoUrl(w.owner!.id))} to={w.owner.associateId ? `/people/${w.owner.associateId}` : null} />
          ) : (
            <Badge variant="destructive" size="sm">No owner</Badge>
          );
        },
        csv: (w) => (w.type === 'PERSON' ? w.manager?.name ?? '' : w.owner ? `${w.owner.name} <${w.owner.email}>` : ''),
      },
      {
        key: 'status',
        // A person's status is where they stand at work — the People
        // directory's word (Working, No recent shifts, Paused…; one rule,
        // apps/api/src/lib/peopleStatus.ts), never their worker account,
        // which only mirrors the record. An agent's or a robot's status is
        // its account (Active, Suspended…).
        header: typeFilter === 'AGENT' || typeFilter === 'ROBOT' ? 'Account' : 'Status',
        accessor: (w) => (w.type === 'PERSON' && isWorkStatus(w.workStatus) ? t(workStatusKeys(w.workStatus).label) : WORKER_STATUS_LABELS[w.status]),
        sortable: true,
        cardMeta: true,
        width: '10rem',
        cell: (w) =>
          w.type === 'PERSON' && isWorkStatus(w.workStatus) ? (
            <PeopleStatusBadge status={w.workStatus} windowDays={windowDays} />
          ) : (
            <Badge variant={STATUS_VARIANT[w.status]}>{WORKER_STATUS_LABELS[w.status]}</Badge>
          ),
      },
      {
        key: 'capabilities',
        header: 'Capabilities',
        accessor: (w) => w.capabilities.map(capLabel).join(', '),
        searchable: true,
        // Most people have none: shown on request (the column chooser).
        defaultHidden: true,
        cell: (w) =>
          w.capabilities.length ? (
            <span className="flex flex-wrap gap-1">
              {w.capabilities.map((c) => (
                <Badge key={c} variant="outline" size="sm">
                  {capLabel(c)}
                </Badge>
              ))}
            </span>
          ) : (
            <span className="text-silver/60">—</span>
          ),
      },
      // Grouped by store, the group heading already names the store.
      ...(groupBy === 'store'
        ? []
        : [
            {
              key: 'sites',
              header: `Current ${term('label.stores').toLowerCase()}`,
              accessor: (w: WorkerSummary) => currentSites(w).map((s) => (hasClients ? `${s.clientName} — ${s.siteName}` : s.siteName)).join(', '),
              searchable: true,
              width: '16rem',
              cell: (w: WorkerSummary) => {
                const sites = currentSites(w);
                if (!sites.length) return <span className="text-silver/60">—</span>;
                const first = sites[0]!;
                const title = sites.map((s) => (hasClients ? `${s.siteName} · ${s.clientName}` : s.siteName)).join('\n');
                return (
                  <span className="block truncate whitespace-nowrap" title={title}>
                    {first.siteName}
                    {hasClients && groupBy !== 'client' && <span className="text-xs text-silver"> · {first.clientName}</span>}
                    {sites.length > 1 && <span className="text-xs text-silver"> +{sites.length - 1}</span>}
                  </span>
                );
              },
            } satisfies GridColumn<WorkerSummary>,
          ]),
      { key: 'upcoming', header: 'Upcoming shifts', accessor: (w) => w.upcomingShifts, sortable: true, align: 'right', width: '9rem', className: 'tabular-nums' },
      // An agent's last seven days — only where agents are listed.
      ...(showsAgents && hasAgents
        ? [
            {
              key: 'scorecard',
              header: 'Scorecard (7 days)',
              accessor: (w: WorkerSummary) => scorecardById.get(w.id)?.tasksCompleted ?? -1,
              sortable: true,
              align: 'right',
              width: '12rem',
              csv: (w: WorkerSummary) => {
                const s = scorecardById.get(w.id);
                return s ? `${s.tasksCompleted} tasks, ${s.errors} errors, ${s.exceptionsEscalated} escalated` : '';
              },
              cell: (w: WorkerSummary) => {
                if (w.type !== 'AGENT') return <span className="text-silver/60">—</span>;
                const s = scorecardById.get(w.id);
                if (!s) return <span className="text-silver/60">…</span>;
                return (
                  <Link to={`/agents/${w.id}?tab=scorecard`} className="inline-flex items-center gap-1.5 whitespace-nowrap tabular-nums hover:text-accent" onClick={(e) => e.stopPropagation()} title={`${s.tasksCompleted} tasks, ${s.errors} errors, ${s.exceptionsEscalated} escalated`}>
                    <span>{s.tasksCompleted} tasks</span>
                    <Badge variant={s.errorRatePct == null ? 'outline' : s.errorRatePct > 10 ? 'destructive' : 'success'} size="sm">
                      {s.errorRatePct == null ? 'no errors measured' : `${s.errorRatePct}% errors`}
                    </Badge>
                  </Link>
                );
              },
            } satisfies GridColumn<WorkerSummary>,
          ]
        : []),
      { key: 'created', header: 'Created', accessor: (w) => w.createdAt, sortable: true, defaultHidden: true, width: '8rem', cell: (w) => fmtDate(w.createdAt) },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [typeFilter, groupBy, term, t, hasClients, showsAgents, hasAgents, windowDays, scorecards.map((q) => q.dataUpdatedAt).join(',')],
  );

  // Where a row sits when grouped: its first current site (or "not placed"), or its type.
  const groupKey = (w: WorkerSummary): string => {
    if (groupBy === 'type') return w.type;
    const site = currentSites(w)[0];
    if (!site) return GROUP_NONE;
    return groupBy === 'client' && hasClients ? `c:${site.clientId}` : `s:${site.locationId}`;
  };
  const groupHeader = (key: string, list: WorkerSummary[]) => {
    const n = `${list.length} ${list.length === 1 ? 'worker' : 'workers'}`;
    // Not "Not placed": that is a people status (hired, placed nowhere), and
    // someone hired through an application with no store assignment yet
    // reads "No recent shifts" on the People page. This heading only says
    // the roster has no store on record for them.
    if (key === GROUP_NONE) return <span>No {term('label.store').toLowerCase()} assignment · {n}</span>;
    if (groupBy === 'type') return <span>{key === 'PERSON' ? 'People' : key === 'AGENT' ? 'Agents' : 'Robots'} · {n}</span>;
    const site = currentSites(list[0]!)[0]!;
    return groupBy === 'client' ? (
      <span>
        {site.clientName} · {n}
      </span>
    ) : (
      <span>
        {site.siteName}
        {hasClients && <span className="font-normal text-silver"> · {site.clientName}</span>} · {n}
      </span>
    );
  };

  // One primary, and only the create that fits the list on screen.
  const inviteAction: PageAction | null = canInvite ? { label: `Invite ${term('workers').toLowerCase()}`, icon: Plus, to: '/onboarding?new=invite', primary: true } : null;
  const registerAction: PageAction | null = canManage ? { label: 'Register agent', icon: Bot, to: '/agents?register=1', primary: true } : null;
  const robotAction: PageAction | null = canManage && robotics ? { label: 'Add robot', icon: Plus, onSelect: () => setCreating(true), primary: true } : null;
  const createAction = typeFilter === 'AGENT' ? registerAction : typeFilter === 'ROBOT' ? robotAction : inviteAction;

  const statusOptions = personView
    ? WORK_STATUSES.map((s) => ({ value: s as string, label: t(workStatusKeys(s).label) }))
    : STATUSES.map((s) => ({ value: s as string, label: WORKER_STATUS_LABELS[s] }));

  const emptyFor: { title: string; description: string; action?: React.ReactNode } =
    typeFilter === 'AGENT'
      ? { title: 'No agents registered', description: 'Register an agent on the Agents page to see it here, with the owner who answers for it.', action: registerAction ? <Button asChild><Link to="/agents?register=1"><Bot className="h-4 w-4" aria-hidden="true" /> Register agent</Link></Button> : undefined }
      : typeFilter === 'ROBOT'
        ? { title: 'No robots yet', description: 'Add a robot with the owner who answers for it and the site it works.', action: robotAction ? <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" aria-hidden="true" /> Add robot</Button> : undefined }
        : { title: `No ${term('workers').toLowerCase()} on the roster yet`, description: `Everyone you invite gets a row here once their record exists.`, action: inviteAction ? <Button asChild><Link to="/onboarding?new=invite"><Plus className="h-4 w-4" aria-hidden="true" /> Invite {term('workers').toLowerCase()}</Link></Button> : undefined };

  /** A tile that is the type filter: tapping the selected one goes back to people. */
  const pickType = (next: TypeFilter) => setTypeFilter(typeFilter === next ? 'PERSON' : next);
  const loading = roster.isLoading;

  return (
    <div className="space-y-6" data-template="list">
      <PageHeader
        title="Workforce roster"
        subtitle="People, agents and robots, grouped by where they work. Agents and robots show the owner who answers for them. Each row opens the record behind it."
        actions={createAction ? [createAction] : undefined}
      />

      {roster.error && <QueryError what="workers" query={roster} />}

      <MetricStrip label="The roster at a glance">
        {/* People: the People page's own number (on the books — hired and
            not separated), so this roster, /people and Headcount agree. */}
        <MetricCard
          key="people"
          label={`${term('nav.people')} on the books`}
          value={loading || !people ? '—' : people.onTheBooks}
          hint={peopleHint(people, t)}
          valueTitle={t('people.onTheBooksDef')}
          onClick={() => setTypeFilter('PERSON')}
          selected={typeFilter === 'PERSON'}
        />
        <MetricCard
          key="agents"
          label="Agents"
          value={loading ? '—' : (counts?.AGENT.ACTIVE ?? 0)}
          hint={otherStatusesHint(counts?.AGENT)}
          nothing={!loading && counts && totalOf(counts.AGENT) === 0 ? 'No agents registered' : undefined}
          onClick={() => pickType('AGENT')}
          selected={typeFilter === 'AGENT'}
        />
        {robotics && (
          <MetricCard
            key="robots"
            label="Robots"
            value={loading ? '—' : (counts?.ROBOT.ACTIVE ?? 0)}
            hint={otherStatusesHint(counts?.ROBOT)}
            nothing={!loading && counts && totalOf(counts.ROBOT) === 0 ? 'No robots yet' : undefined}
            onClick={() => pickType('ROBOT')}
            selected={typeFilter === 'ROBOT'}
          />
        )}
        <MetricCard
          key="owner"
          label="Without an owner"
          value={loading ? '—' : withoutOwner}
          tone={withoutOwner > 0 ? 'alert' : undefined}
          hint={withoutOwner > 0 ? 'Must be zero — every worker needs an owner' : 'Every worker is owned'}
        />
      </MetricStrip>

      {peopleMissing > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-warning/30 bg-warning/10 px-4 py-3 text-sm">
          <Users className="h-4 w-4 text-warning" aria-hidden="true" />
          <span>
            People without a worker record: <strong className="tabular-nums">{peopleMissing}</strong>. The server creates them every 15 minutes.
          </span>
          {canManage && (
            <Button size="sm" variant="secondary" onClick={onEnsure} disabled={ensuring}>
              {ensuring ? 'Creating…' : 'Create them now'}
            </Button>
          )}
        </div>
      )}

      <DataGrid
        id="workers"
        caption="Workers"
        noun={typeFilter === 'AGENT' ? { one: 'agent', many: 'agents' } : typeFilter === 'ROBOT' ? { one: 'robot', many: 'robots' } : typeFilter === 'PERSON' ? { one: term('worker').toLowerCase(), many: term('workers').toLowerCase() } : { one: 'worker', many: 'workers' }}
        rows={allRows ? rows : undefined}
        rowKey={(w) => w.id}
        loading={loading}
        error={roster.error ? errorMessage(roster.error, 'Could not load workers.') : null}
        onRetry={() => roster.refetch()}
        search={{ placeholder: 'Search names, owners, sites…' }}
        urlState
        exportCsv={{ filename: 'workers' }}
        columnChooser
        columns={columns}
        onRowClick={(w) => setEditingId(w.id)}
        rowActionLabel={(w) => `Open ${w.name}`}
        defaultSort={{ key: 'name', direction: 'asc' }}
        groupBy={groupBy === 'none' ? undefined : { key: groupKey, header: groupHeader }}
        activeFilters={statusFilter ? 1 : 0}
        onClearFilters={() => setStatusParam('')}
        filters={
          <div className="flex flex-wrap items-center gap-3">
            <SegmentedControl ariaLabel="Worker type" options={TYPE_OPTIONS.filter((o) => robotics || o.value !== 'ROBOT')} value={typeFilter} onChange={setTypeFilter} />
            <label className="flex items-center gap-2 text-sm text-silver">
              <span className="sr-only">Status</span>
              <Select size="sm" value={statusFilter} onChange={(e) => setStatusParam(e.target.value)} aria-label="Status">
                <option value="">Any status</option>
                {statusOptions.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex items-center gap-2 text-sm text-silver">
              <span className="sr-only">Group by</span>
              <Select size="sm" value={groupBy} aria-label="Group by" onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
                <option value="store">Group by {term('label.store').toLowerCase()}</option>
                {hasClients && <option value="client">Group by {term('label.client').toLowerCase()}</option>}
                <option value="type">Group by type</option>
                <option value="none">No grouping</option>
              </Select>
            </label>
          </div>
        }
        empty={{ icon: BookUser, ...emptyFor }}
      />

      {creating && (
        <CreateRobotDialog
          onClose={() => setCreating(false)}
          onCreated={async () => {
            setCreating(false);
            await refetchAll();
          }}
        />
      )}
      {editing && (
        <EditWorkerDialog
          worker={editing}
          canManage={canManage}
          onClose={() => setEditingId(null)}
          onSaved={async () => {
            await refetchAll();
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------ owners */

function useOwnerOptions() {
  // Every internal account; the portal accounts are excluded because the
  // server refuses them as owners (owner_not_eligible).
  return useQuery({
    queryKey: ['admin', 'users', 'worker-owners'],
    queryFn: () => listAdminUsers({ status: 'ACTIVE' }),
    select: (d) => d.users.filter((u) => u.role !== 'CLIENT_PORTAL').sort((a, b) => (a.associateName ?? a.email).localeCompare(b.associateName ?? b.email)),
  });
}

function OwnerSelect({ value, onChange, id, ...aria }: { value: string; onChange: (v: string) => void; id?: string; 'aria-describedby'?: string; 'aria-invalid'?: true }) {
  const owners = useOwnerOptions();
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} required {...aria}>
      <option value="">{owners.isLoading ? 'Loading owners…' : 'Choose an owner'}</option>
      {(owners.data ?? []).map((u) => (
        <option key={u.id} value={u.id}>
          {u.associateName ? `${u.associateName} — ${u.email}` : u.email}
        </option>
      ))}
    </Select>
  );
}

/* ------------------------------------------------------ capabilities */

function CapabilityPicker({ type, value, onChange }: { type: WorkerType; value: string[]; onChange: (next: string[]) => void }) {
  const options = WORKER_CAPABILITIES.filter((c) => (c.types as readonly string[]).includes(type));
  const toggle = (code: string, on: boolean) => onChange(on ? Array.from(new Set([...value, code])) : value.filter((v) => v !== code));
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-sm font-medium text-silver">Capabilities</legend>
      {options.length === 0 && <p className="text-xs2 text-silver/70">No capabilities apply to this type.</p>}
      <div className="grid gap-1.5 sm:grid-cols-2">
        {options.map((c) => (
          <label key={c.code} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={value.includes(c.code)} onChange={(e) => toggle(c.code, e.target.checked)} />
            {c.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/* -------------------------------------------------------------- sites */

/** Flat "Client — Site" list across the active clients. */
function useSiteOptions() {
  const clients = useQuery({ queryKey: ['clients', 'names', 'workers'], queryFn: () => listClients({ status: 'ACTIVE', limit: 200 }) });
  const clientList = clients.data?.clients ?? [];
  const ids = clientList.map((c) => c.id);
  const locations = useQuery({
    queryKey: ['clients', 'locations', 'workers', ids],
    queryFn: async () => {
      const all = await Promise.all(clientList.map((c) => listClientLocations(c.id).then((r) => r.locations.map((l) => ({ ...l, clientName: c.name })))));
      return all.flat().filter((l) => l.isActive);
    },
    enabled: ids.length > 0,
  });
  return {
    loading: clients.isLoading || locations.isLoading,
    options: (locations.data ?? []).map((l) => ({ id: l.id, label: `${l.clientName} — ${l.name}` })).sort((a, b) => a.label.localeCompare(b.label)),
  };
}

function SiteSelect({ value, onChange, id, ...aria }: { value: string; onChange: (v: string) => void; id?: string; 'aria-describedby'?: string; 'aria-invalid'?: true }) {
  const sites = useSiteOptions();
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} {...aria}>
      <option value="">{sites.loading ? 'Loading sites…' : 'No site yet'}</option>
      {sites.options.map((s) => (
        <option key={s.id} value={s.id}>
          {s.label}
        </option>
      ))}
    </Select>
  );
}

/* ------------------------------------------------------------- create */

/**
 * Robots only: the roster's create schema is a worker (name, owner, status,
 * capabilities, site). An agent needs its profile too — vendor, model and
 * version, purpose, scopes, limits — so it is registered on the Agents page,
 * the one form that takes all of it.
 */
function CreateRobotDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => Promise<void> }) {
  const type = 'ROBOT' as const;
  const [name, setName] = useState('');
  const [ownerUserId, setOwnerUserId] = useState('');
  const [status, setStatus] = useState<WorkerStatus>('ONBOARDING');
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [notes, setNotes] = useState('');
  const [locationId, setLocationId] = useState('');
  const [saving, setSaving] = useState(false);
  const dirty = name !== '' || ownerUserId !== '' || capabilities.length > 0 || notes !== '';
  const valid = name.trim().length >= 2 && ownerUserId !== '';

  const submit = async () => {
    if (!valid) return;
    setSaving(true);
    try {
      await createWorker({
        type,
        name: name.trim(),
        ownerUserId,
        status,
        capabilities: capabilities as never,
        notes: notes.trim() || undefined,
        locationId: locationId || undefined,
      });
      toast.success(`${name.trim()} added.`);
      await onCreated();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not add the worker.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} confirmDiscard={dirty && !saving}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add robot</DialogTitle>
          <DialogDescription>
            People are mirrored from the associate record; an agent is registered on the{' '}
            <Link to="/agents?register=1" className="underline underline-offset-2">
              Agents page
            </Link>
            . A robot is added here, and needs an owner who answers for it.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Field label="Name" required hint="How it appears on schedules and in audit.">
            {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={160} autoFocus />}
          </Field>
          <Field label="Owner" required hint="The person who answers for what this robot does.">
            {(p) => <OwnerSelect {...p} value={ownerUserId} onChange={setOwnerUserId} />}
          </Field>
          <Field label="Status">
            {(p) => (
              <Select {...p} value={status} onChange={(e) => setStatus(e.target.value as WorkerStatus)}>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {WORKER_STATUS_LABELS[s]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <CapabilityPicker type={type} value={capabilities} onChange={setCapabilities} />
          <Field label="Initial site" hint="Optional. Where it works first.">
            {(p) => <SiteSelect {...p} value={locationId} onChange={setLocationId} />}
          </Field>
          <Field label="Notes">
            {(p) => <Textarea {...p} value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />}
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || saving}>
              {saving ? 'Creating…' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* --------------------------------------------------------------- edit */

function EditWorkerDialog({ worker, canManage, onClose, onSaved }: { worker: WorkerSummary; canManage: boolean; onClose: () => void; onSaved: () => Promise<void> }) {
  const confirm = useConfirm();
  const isPerson = worker.type === 'PERSON';
  const [name, setName] = useState(worker.name);
  const [ownerUserId, setOwnerUserId] = useState(worker.owner?.id ?? '');
  const [status, setStatus] = useState<WorkerStatus>(worker.status);
  const [capabilities, setCapabilities] = useState<string[]>(worker.capabilities);
  const [notes, setNotes] = useState(worker.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [siteId, setSiteId] = useState('');
  const [assigning, setAssigning] = useState(false);

  const dirty =
    name !== worker.name ||
    ownerUserId !== (worker.owner?.id ?? '') ||
    status !== worker.status ||
    notes !== (worker.notes ?? '') ||
    capabilities.join() !== worker.capabilities.join();
  const valid = ownerUserId !== '' && (isPerson || name.trim().length >= 2);

  const save = async () => {
    if (!valid || !canManage) return;
    if (!isPerson && status === 'OFFBOARDED' && worker.status !== 'OFFBOARDED') {
      const ok = await confirm({
        title: `Offboard ${worker.name}?`,
        description: 'It leaves every site and stops being scheduled. The record stays for audit.',
        confirmLabel: 'Offboard',
        destructive: true,
      });
      if (!ok) return;
    }
    setSaving(true);
    try {
      await updateWorker(worker.id, {
        ownerUserId: ownerUserId !== (worker.owner?.id ?? '') ? ownerUserId : undefined,
        capabilities: capabilities as never,
        notes: notes.trim() || null,
        ...(isPerson ? {} : { name: name.trim(), status }),
      });
      toast.success('Saved.');
      await onSaved();
      onClose();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not save the worker.'));
    } finally {
      setSaving(false);
    }
  };

  const assign = async () => {
    if (!siteId || !canManage) return;
    setAssigning(true);
    try {
      await assignWorkerSite(worker.id, { locationId: siteId });
      toast.success('Assigned to the site.');
      setSiteId('');
      await onSaved();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not assign the site.'));
    } finally {
      setAssigning(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} confirmDiscard={dirty && !saving}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <span className="inline-flex items-center gap-2">
              {worker.name}
              <Badge variant={TYPE_VARIANT[worker.type]} size="sm">
                {WORKER_TYPE_LABELS[worker.type]}
              </Badge>
              {/* A person: where they stand at work (the People page's word), not the account it mirrors. */}
              {isPerson && isWorkStatus(worker.workStatus) ? (
                <PeopleStatusBadge status={worker.workStatus} size="sm" />
              ) : (
                <Badge variant={STATUS_VARIANT[worker.status]} size="sm">
                  {WORKER_STATUS_LABELS[worker.status]}
                </Badge>
              )}
            </span>
          </DialogTitle>
          <DialogDescription>
            {isPerson
              ? 'A person follows their associate record: name, status and sites come from there. Only the owner, capabilities and notes are edited here.'
              : `Created ${fmtDate(worker.createdAt)} · ${worker.upcomingShifts} upcoming ${worker.upcomingShifts === 1 ? 'shift' : 'shifts'}`}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {!isPerson && (
            <Field label="Name" required>
              {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={160} disabled={!canManage} />}
            </Field>
          )}
          <Field label="Owner" required>
            {(p) => (canManage ? <OwnerSelect {...p} value={ownerUserId} onChange={setOwnerUserId} /> : <Input {...p} value={worker.owner ? `${worker.owner.name} — ${worker.owner.email}` : 'No owner'} readOnly />)}
          </Field>
          {!isPerson && (
            <Field label="Status">
              {(p) => (
                <Select {...p} value={status} onChange={(e) => setStatus(e.target.value as WorkerStatus)} disabled={!canManage}>
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {WORKER_STATUS_LABELS[s]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          {canManage ? (
            <CapabilityPicker type={worker.type} value={capabilities} onChange={setCapabilities} />
          ) : (
            <div className="space-y-1">
              <div className="text-sm font-medium text-silver">Capabilities</div>
              <div className="flex flex-wrap gap-1">
                {worker.capabilities.length ? worker.capabilities.map((c) => <Badge key={c} variant="outline" size="sm">{CAP_LABEL.get(c) ?? c}</Badge>) : <span className="text-silver/60">—</span>}
              </div>
            </div>
          )}
          <Field label="Notes">
            {(p) => <Textarea {...p} value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} disabled={!canManage} />}
          </Field>

          <section className="space-y-2 rounded-md border border-navy-secondary p-3">
            <h3 className="text-sm font-medium text-silver">Sites</h3>
            {worker.sites.length === 0 ? (
              <p className="text-sm text-silver/70">Not at any site.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {worker.sites.map((s) => (
                  <li key={`${s.locationId}-${s.startedAt}`} className="flex flex-wrap items-center gap-2">
                    <span>
                      {s.clientName} — {s.siteName}
                    </span>
                    <span className="text-xs2 text-silver/70">
                      {fmtDate(s.startedAt)}
                      {s.endedAt ? ` → ${fmtDate(s.endedAt)}` : ' → now'}
                    </span>
                    <Badge variant="outline" size="sm">
                      {s.source === 'associate' ? 'From the associate record' : 'Assigned here'}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
            {canManage && !isPerson && (
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-[14rem] flex-1">
                  <Field label="Assign to site">{(p) => <SiteSelect {...p} value={siteId} onChange={setSiteId} />}</Field>
                </div>
                <Button type="button" variant="secondary" onClick={assign} disabled={!siteId || assigning}>
                  {assigning ? 'Assigning…' : 'Assign'}
                </Button>
              </div>
            )}
            {canManage && isPerson && <p className="text-xs2 text-silver/70">A person's sites follow their associate assignments.</p>}
          </section>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
              {canManage ? 'Cancel' : 'Close'}
            </Button>
            {canManage && (
              <Button type="submit" disabled={!valid || !dirty || saving}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
