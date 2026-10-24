import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CalendarClock, ChevronDown, Columns3, MoreHorizontal, Plus, Star, Table2, UserPlus } from '@/components/ui/icons';
import type { PayScheduleSummary, RosterPerson } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useTenant } from '@/lib/auth';
import { getPayScheduleRoster, listPaySchedules, listUnassigned, updatePaySchedule } from '@/lib/paySchedulesApi';
import { useMediaQuery } from '@/lib/useViewport';
import { ListTemplate } from '@/components/templates';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/DropdownMenu';
import { EmptyState } from '@/components/ui/EmptyState';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { Skeleton } from '@/components/ui/Skeleton';
import { toast } from '@/components/ui/Toaster';
import { ViewToggle, useViewMode } from '@/components/ui/ViewToggle';
import { useConfirm } from '@/lib/confirm';
import { cn } from '@/lib/cn';
import { AddPeopleBuilder } from './AddPeopleBuilder';
import { MoveDialog } from './MoveDialog';
import { AvatarStack, ReadinessRing, payDay, periodRange, shortDay, useChangeDate, weekdayOf } from './scheduleKit';

/**
 * Pay schedules: who is paid when. A table of every schedule (or, on a desk,
 * a board where people and whole client groups are dragged between them),
 * with anyone on no schedule pinned at the top — they can't be paid by any run.
 */
export function PaySchedulesPage() {
  const navigate = useNavigate();
  // The inbox links here with ?view=unassigned: open on the people no schedule covers.
  const [params] = useSearchParams();
  const hasClients = useTenant().moduleOn('clientPortal');
  const desktop = useMediaQuery('(min-width: 1024px)');
  const [mode, setMode] = useViewMode<'table' | 'board'>('paySchedules', 'table', ['table', 'board']);
  const view = desktop ? mode : 'table';
  const list = useQuery({ queryKey: ['paySchedules', 'list'], queryFn: listPaySchedules });
  const schedules = list.data?.schedules ?? [];
  const active = schedules.filter((s) => s.isActive);
  const soonest = [...active].sort((a, b) => a.nextPeriod.payDate.localeCompare(b.nextPeriod.payDate))[0];
  const onSchedule = active.reduce((n, s) => n + s.people, 0);
  const blocked = active.reduce((n, s) => n + s.blocked, 0);
  const joining = active.reduce((n, s) => n + s.pendingJoins, 0);

  return (
    <ListTemplate
      title="Pay schedules"
      subtitle={hasClients ? 'Who is paid when — by client, site, pay type or name — and anyone not on a schedule yet.' : 'Who is paid when — by site, department, pay type or name — and anyone not on a schedule yet.'}
      primaryAction={
        <Button asChild>
          <Link to="/payroll/schedules/new">
            <Plus className="h-4 w-4" aria-hidden="true" />
            New schedule
          </Link>
        </Button>
      }
      secondaryActions={
        desktop ? (
          <ViewToggle<'table' | 'board'>
            value={mode}
            onChange={setMode}
            ariaLabel="View"
            options={[
              { value: 'table', label: 'Table', icon: Table2 },
              { value: 'board', label: 'Board', icon: Columns3 },
            ]}
          />
        ) : undefined
      }
      summary={
        list.data ? (
          // MetricStrip: two compact tiles a row on a phone, so the schedules start on the first screen (F500 G3).
          <MetricStrip label="Pay schedules at a glance">
            <MetricCard label="Schedules" value={String(active.length)} hint={schedules.length > active.length ? `${schedules.length - active.length} inactive` : undefined} />
            <MetricCard
              label="People on a schedule"
              value={String(onSchedule)}
              nothing={onSchedule === 0 ? 'No one on a schedule yet' : undefined}
              hint={blocked ? `${blocked} won’t be paid correctly` : joining ? `${joining} joining from their next period` : undefined}
              tone={blocked > 0 ? 'alert' : 'default'}
            />
            <MetricCard
              label="Next payday"
              value={soonest ? shortDay(soonest.nextPeriod.payDate) : '—'}
              nothing={soonest ? undefined : 'No schedules yet'}
              hint={soonest ? `${weekdayOf(soonest.nextPeriod.payDate)} · ${soonest.name}` : undefined}
              href={soonest ? `/payroll/schedules/${soonest.id}` : undefined}
            />
            <MetricCard
              label="On no schedule"
              value={String(list.data.unassigned)}
              nothing={list.data.unassigned === 0 ? 'Everyone is covered' : undefined}
              hint={list.data.unassigned ? 'can’t be paid by any run' : undefined}
              tone={list.data.unassigned > 0 ? 'warning' : 'default'}
              href={list.data.unassigned > 0 ? '/payroll/schedules?view=unassigned' : undefined}
            />
          </MetricStrip>
        ) : list.isLoading ? (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-28" />
            ))}
          </div>
        ) : null
      }
    >
      {list.data && list.data.unassigned > 0 && <UnassignedBucket schedules={active} focus={params.get('view') === 'unassigned'} only={params.get('people')?.split(',').filter(Boolean) ?? null} />}
      {list.isError ? (
        <EmptyState
          icon={AlertTriangle}
          title="We couldn’t load the pay schedules"
          description={list.error instanceof ApiError ? list.error.message : undefined}
          action={
            <Button variant="secondary" size="sm" onClick={() => void list.refetch()}>
              Retry
            </Button>
          }
        />
      ) : list.data && schedules.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title="No pay schedules yet"
          description="A schedule says when people are paid. Start with how often you pay, then choose who is on it."
          action={
            <Button asChild>
              <Link to="/payroll/schedules/new">
                <Plus className="h-4 w-4" aria-hidden="true" />
                Set up the first schedule
              </Link>
            </Button>
          }
        />
      ) : view === 'board' ? (
        <ScheduleBoard schedules={active} />
      ) : (
        <ScheduleTable schedules={schedules} loading={list.isLoading} onOpen={(s) => navigate(`/payroll/schedules/${s.id}`)} />
      )}
    </ListTemplate>
  );
}

/* ---- The table --------------------------------------------------------- */

function ScheduleTable({ schedules, loading, onOpen }: { schedules: PayScheduleSummary[]; loading: boolean; onOpen: (s: PayScheduleSummary) => void }) {
  const hasClients = useTenant().moduleOn('clientPortal');
  const columns: GridColumn<PayScheduleSummary>[] = [
    {
      key: 'name',
      header: 'Schedule',
      primary: true,
      sortable: true,
      accessor: (s) => s.name,
      cell: (s) => (
        <span className="block min-w-0">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium text-ink">{s.name}</span>
            {s.isDefault && (
              <Badge size="sm" withDot={false} variant="accent">
                <Star className="h-3 w-3" aria-hidden="true" /> Default
              </Badge>
            )}
            {!s.isActive && (
              <Badge size="sm" withDot={false} variant="default">
                Inactive
              </Badge>
            )}
          </span>
          <span className="block text-xs text-ink-muted">{s.pattern}</span>
        </span>
      ),
    },
    {
      key: 'payday',
      header: 'Next payday',
      sortable: true,
      accessor: (s) => s.nextPeriod.payDate,
      cardMeta: true,
      cell: (s) => (
        <span className="block">
          <span className="font-medium tabular-nums text-ink">{payDay(s.nextPeriod.payDate)}</span>
          {s.nextPeriod.adjustedFor && <span className="block text-xs text-warning">moved for {s.nextPeriod.adjustedFor}</span>}
        </span>
      ),
    },
    { key: 'period', header: 'Pays for', accessor: (s) => s.nextPeriod.periodStart, cell: (s) => <span className="tabular-nums text-ink-muted">{periodRange(s.nextPeriod.periodStart, s.nextPeriod.periodEnd)}</span> },
    {
      key: 'people',
      header: 'People',
      align: 'right',
      sortable: true,
      searchable: false,
      accessor: (s) => s.people,
      cell: (s) => (
        <span className="block tabular-nums">
          <span className="font-medium text-ink">{s.people}</span>
          {(s.blocked > 0 || s.attention > 0) && (
            <span className="block text-xs">
              {s.blocked > 0 && <span className="text-alert">{s.blocked} blocked</span>}
              {s.blocked > 0 && s.attention > 0 && <span className="text-ink-muted"> · </span>}
              {s.attention > 0 && <span className="text-warning">{s.attention} to check</span>}
            </span>
          )}
        </span>
      ),
    },
    { key: 'clients', header: hasClients ? 'Clients' : 'Covers', accessor: (s) => s.clients.map((c) => c.name).join(', '), cell: (s) => <span className="text-ink-muted">{s.clients.length === 0 ? (s.isDefault ? 'Anyone not covered elsewhere' : 'By name only') : s.clients.map((c) => c.name).join(', ')}</span> },
    {
      key: 'pending',
      header: 'Coming up',
      accessor: (s) => (s.pendingVersion ? 1 : 0) + s.pendingJoins + s.pendingLeaves,
      searchable: false,
      cell: (s) => (
        <span className="text-xs text-ink-muted">
          {s.pendingVersion && <span className="block text-accent">Pattern changes {payDay(s.pendingVersion.effectiveFrom, false)}</span>}
          {s.pendingJoins > 0 && <span className="block">{s.pendingJoins} joining</span>}
          {s.pendingLeaves > 0 && <span className="block">{s.pendingLeaves} leaving</span>}
          {!s.pendingVersion && !s.pendingJoins && !s.pendingLeaves && '—'}
        </span>
      ),
    },
  ];
  return (
    <DataGrid
      id="pay-schedules"
      caption="Pay schedules"
      rows={schedules}
      columns={columns}
      rowKey={(s) => s.id}
      loading={loading}
      onRowClick={onOpen}
      rowActionLabel={(s) => `Open ${s.name}`}
      noun={{ one: 'schedule', many: 'schedules' }}
      defaultSort={{ key: 'payday', direction: 'asc' }}
      search={{ placeholder: hasClients ? 'Schedule or client…' : 'Schedule…' }}
    />
  );
}

/* ---- Everyone on no schedule ------------------------------------------- */

function UnassignedBucket({ schedules, focus, only }: { schedules: PayScheduleSummary[]; focus: boolean; only?: string[] | null }) {
  const qc = useQueryClient();
  const ref = useRef<HTMLDivElement>(null);
  const [showAll, setShowAll] = useState(focus);
  const confirm = useConfirm();
  const q = useQuery({ queryKey: ['paySchedules', 'unassigned'], queryFn: listUnassigned });
  const [target, setTarget] = useState<PayScheduleSummary | null>(null);
  const targetStart = useChangeDate(target);
  const makeDefault = useMutation({
    mutationFn: (s: PayScheduleSummary) => updatePaySchedule(s.id, { isDefault: true }),
    onSuccess: (_r, s) => {
      toast.success(`${s.name} is now the company default. Anyone no rule covers is paid on it — payroll was told.`);
      void qc.invalidateQueries({ queryKey: ['paySchedules'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not set the default.'),
  });
  const ready = !!q.data && q.data.total > 0;
  useEffect(() => {
    if (focus && ready) {
      ref.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
      ref.current?.focus({ preventScroll: true });
    }
  }, [focus, ready]);
  if (!q.data || q.data.total === 0) return null;
  // Readiness's "Cover with a schedule rule" hands its picked people here (?people=…, finance walk 4).
  const picked = only && only.length ? q.data.people.filter((p) => only.includes(p.associateId)) : null;
  const people = picked && picked.length ? picked : q.data.people;
  return (
    <Card ref={ref} tabIndex={-1} aria-label="People on no pay schedule" className={cn('scroll-mt-24 border-alert/40 bg-alert/5 focus:outline-none', focus && 'ring-2 ring-alert/40')}>
      <CardContent className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 flex-col items-start gap-3 sm:flex-row sm:items-center sm:gap-4">
          <AvatarStack people={people.map((p) => ({ name: p.name, photoUrl: p.photoUrl }))} max={6} />
          <div className="min-w-0">
            <p className="font-medium text-ink">
              {picked && picked.length ? `${picked.length} of the ${q.data.total} on no pay schedule, picked on Readiness` : `${q.data.total} ${q.data.total === 1 ? 'person is' : 'people are'} on no pay schedule`}
            </p>
            <p className="text-sm text-ink-muted">
              They won’t be paid by any run until a schedule covers them.{' '}
              <button type="button" className="font-medium text-accent underline-offset-2 hover:underline" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
                {showAll ? 'Hide names' : 'See who'}
              </button>
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button disabled={schedules.length === 0}>
                <UserPlus className="h-4 w-4" aria-hidden="true" />
                Add them to…
                <ChevronDown className="h-4 w-4" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {schedules.map((s) => (
                <DropdownMenuItem key={s.id} onSelect={() => setTarget(s)}>
                  {s.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="secondary" disabled={schedules.length === 0}>
                Make one the default
                <ChevronDown className="h-4 w-4" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Anyone no rule covers is paid on it</DropdownMenuLabel>
              {schedules.map((s) => (
                <DropdownMenuItem
                  key={s.id}
                  onSelect={() =>
                    void (async () => {
                      if (await confirm({ title: `Make ${s.name} the company default?`, description: `The ${q.data!.total} people on no schedule — and anyone hired later that no other rule covers — are paid on ${s.name} from its next pay period.`, confirmLabel: 'Make default' })) makeDefault.mutate(s);
                    })()
                  }
                >
                  {s.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardContent>
      {showAll && (
        <ul className="flex flex-wrap gap-2 border-t border-alert/20 px-5 py-4" aria-label="On no pay schedule">
          {people.map((p) => (
            <li key={p.associateId}>
              <Link to={`/people/${p.associateId}`} className="inline-flex items-center gap-2 rounded-full border border-line bg-surface-raised py-1 pl-1 pr-3 text-sm text-ink hover:border-accent/50">
                <Avatar src={p.photoUrl} name={p.name} size="xs" />
                {p.name}
                <span className="text-xs text-ink-muted">{p.status === 'NEW_HIRE' ? 'New hire' : (p.clientName ?? p.siteName ?? '')}</span>
              </Link>
            </li>
          ))}
          {q.data.total > people.length && <li className="self-center text-xs text-ink-muted">and {q.data.total - people.length} more</li>}
        </ul>
      )}
      {target && (
        <AddPeopleBuilder
          open={!!target}
          onOpenChange={(o) => !o && setTarget(null)}
          schedule={{ id: target.id, name: target.name, nextPeriodStart: targetStart.date, nextPayDate: targetStart.payDate, coveredClientIds: target.clients.map((c) => c.id) }}
          initialInclude={people}
        />
      )}
    </Card>
  );
}

/* ---- The board --------------------------------------------------------- */

type Drag = { kind: 'person'; associateId: string; name: string; fromScheduleId: string } | { kind: 'client'; clientId: string; name: string; count: number; fromScheduleId: string };

/**
 * Schedules side by side: client groups as avatar stacks, people as tiles.
 * Drag a person or a whole client group to another schedule — or use the
 * "Move to…" menu on any card (keyboard and touch).
 */
function ScheduleBoard({ schedules }: { schedules: PayScheduleSummary[] }) {
  const rosters = useQueries({ queries: schedules.map((s) => ({ queryKey: ['paySchedules', 'roster', s.id], queryFn: () => getPayScheduleRoster(s.id) })) });
  const [over, setOver] = useState<string | null>(null);
  const [move, setMove] = useState<{ drag: Drag; to: PayScheduleSummary } | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const begin = (drag: Drag, to: PayScheduleSummary) => {
    if (to.id === drag.fromScheduleId) return;
    setMove({ drag, to });
  };
  const moveMenu = (drag: Drag) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon" variant="ghost" aria-label={`Move ${drag.name} to another schedule`} className="h-7 w-7">
          <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Move {drag.kind === 'client' ? `everyone at ${drag.name}` : drag.name} to…</DropdownMenuLabel>
        {schedules
          .filter((s) => s.id !== drag.fromScheduleId)
          .map((s) => (
            <DropdownMenuItem key={s.id} onSelect={() => begin(drag, s)}>
              {s.name}
            </DropdownMenuItem>
          ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
  return (
    <>
      <div className="flex gap-4 overflow-x-auto pb-3" role="list" aria-label="Pay schedules board">
        {schedules.map((s, i) => {
          const roster = rosters[i]?.data;
          return (
            <section
              key={s.id}
              role="listitem"
              aria-label={s.name}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(s.id);
              }}
              onDragLeave={() => setOver((o) => (o === s.id ? null : o))}
              onDrop={(e) => {
                e.preventDefault();
                setOver(null);
                try {
                  begin(JSON.parse(e.dataTransfer.getData('application/x-alto-pay-move')) as Drag, s);
                } catch {
                  /* not ours */
                }
              }}
              className={cn('flex w-80 shrink-0 flex-col rounded-xl border bg-surface-sunken/40 transition-colors', over === s.id ? 'border-accent bg-accent-fill/10' : 'border-line')}
            >
              <header className="border-b border-line p-4">
                <Link to={`/payroll/schedules/${s.id}`} className="font-semibold text-ink hover:underline">
                  {s.name}
                </Link>
                <p className="mt-0.5 text-xs text-ink-muted">{s.pattern}</p>
                <p className="mt-2 flex items-center justify-between text-xs">
                  <span className="text-ink-muted">Next payday <span className="font-medium text-ink">{payDay(s.nextPeriod.payDate, false)}</span></span>
                  <span className="tabular-nums text-ink-muted">
                    {s.people} people{s.pendingJoins ? ` · ${s.pendingJoins} joining` : ''}
                  </span>
                </p>
              </header>
              <div className="flex-1 space-y-2 p-3">
                {!roster ? (
                  <Skeleton className="h-24" />
                ) : roster.groups.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-line p-4 text-center text-xs text-ink-muted">Drop people or a group here</p>
                ) : (
                  roster.groups.map((g) => {
                    const key = `${s.id}:${g.clientId ?? 'none'}`;
                    const expanded = open.has(key);
                    const drag: Drag | null = g.clientId ? { kind: 'client', clientId: g.clientId, name: g.clientName, count: g.counts.total, fromScheduleId: s.id } : null;
                    return (
                      <div
                        key={key}
                        draggable={!!drag}
                        onDragStart={(e) => drag && e.dataTransfer.setData('application/x-alto-pay-move', JSON.stringify(drag))}
                        className="rounded-lg border border-line bg-surface-raised"
                      >
                        <div className="flex items-center gap-2 p-2.5">
                          <button
                            type="button"
                            aria-expanded={expanded}
                            onClick={() =>
                              setOpen((prev) => {
                                const next = new Set(prev);
                                if (next.has(key)) next.delete(key);
                                else next.add(key);
                                return next;
                              })
                            }
                            className="flex min-w-0 flex-1 items-center gap-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                          >
                            <AvatarStack people={g.people.map((p) => ({ name: p.name, photoUrl: p.photoUrl }))} max={3} size="xs" />
                            <span className="min-w-0">
                              <span className="block truncate text-sm font-medium text-ink">{g.clientName}</span>
                              <span className="block text-2xs tabular-nums text-ink-muted">
                                {g.counts.total} people{g.counts.blocked + g.counts.attention > 0 ? ` · ${g.counts.blocked + g.counts.attention} need attention` : ''}
                              </span>
                            </span>
                          </button>
                          {drag && moveMenu(drag)}
                        </div>
                        {expanded && (
                          <ul className="space-y-1 border-t border-line p-2">
                            {g.people.slice(0, 60).map((p) => (
                              <BoardPerson key={p.associateId} person={p} scheduleId={s.id} menu={moveMenu({ kind: 'person', associateId: p.associateId, name: p.name, fromScheduleId: s.id })} />
                            ))}
                            {g.people.length > 60 && (
                              <li className="px-2 py-1 text-2xs text-ink-muted">
                                and {g.people.length - 60} more — <Link className="text-accent underline" to={`/payroll/schedules/${s.id}`}>open the schedule</Link>
                              </li>
                            )}
                          </ul>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </section>
          );
        })}
      </div>
      <MoveDialog
        open={!!move}
        onOpenChange={(o) => !o && setMove(null)}
        target={move?.to ?? null}
        title={move ? (move.drag.kind === 'client' ? `Move everyone at ${move.drag.name} to ${move.to.name}` : `Move ${move.drag.name} to ${move.to.name}`) : ''}
        input={
          move
            ? {
                toScheduleId: move.to.id,
                fromScheduleId: move.drag.fromScheduleId,
                associateIds: move.drag.kind === 'person' ? [move.drag.associateId] : [],
                clientIds: move.drag.kind === 'client' ? [move.drag.clientId] : [],
              }
            : null
        }
      />
    </>
  );
}

function BoardPerson({ person, scheduleId, menu }: { person: RosterPerson; scheduleId: string; menu: React.ReactNode }) {
  return (
    <li
      draggable
      onDragStart={(e) => e.dataTransfer.setData('application/x-alto-pay-move', JSON.stringify({ kind: 'person', associateId: person.associateId, name: person.name, fromScheduleId: scheduleId } satisfies Drag))}
      className="flex cursor-grab items-center gap-2 rounded-md px-1.5 py-1 hover:bg-surface-sunken/60 active:cursor-grabbing"
    >
      <ReadinessRing src={person.photoUrl} name={person.name} level={person.readiness} size="xs" />
      <span className="min-w-0 flex-1 truncate text-sm text-ink">{person.name}</span>
      {menu}
    </li>
  );
}

