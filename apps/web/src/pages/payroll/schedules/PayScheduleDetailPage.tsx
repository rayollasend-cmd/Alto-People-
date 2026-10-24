import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, ChevronDown, ChevronRight, LayoutGrid, List, MoreHorizontal, MoveRight, Pencil, Power, Star, UserMinus, UserPlus } from '@/components/ui/icons';
import { becauseSentence, type PayFrequencyKind, type PayScheduleDetail, type PayScheduleHistoryResponse, type PayScheduleSummary, type RosterPerson, type ScheduleRule } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useTenant } from '@/lib/auth';
import { fmtDateTime, fmtMoney, ymdLocal } from '@/lib/format';
import {
  applyMembership,
  endScheduleRule,
  getPayCalendar,
  getPaySchedule,
  getPayScheduleHistory,
  getPayScheduleRoster,
  listPaySchedules,
  previewPattern,
  updatePaySchedule,
} from '@/lib/paySchedulesApi';
import { useConfirm } from '@/lib/confirm';
import { RecordTemplate } from '@/components/templates';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/DropdownMenu';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { toast } from '@/components/ui/Toaster';
import { ViewToggle, useViewMode } from '@/components/ui/ViewToggle';
import { cn } from '@/lib/cn';
import { AddPeopleBuilder } from './AddPeopleBuilder';
import { MoveDialog } from './MoveDialog';
import { AvatarStack, PayCalendar, issuesByWeight, useChangeDate, patternSentence, periodRange, shortDay, weekdayOf, PersonTile, READINESS_LABEL, ReadinessBadge, ReadinessRing, payDay } from './scheduleKit';

type Filter = 'all' | 'blocked' | 'attention' | 'new' | 'joining' | 'leaving';
const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'all', label: 'Everyone' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'attention', label: 'Needs a look' },
  { key: 'new', label: 'New hires' },
  { key: 'joining', label: 'Joining' },
  { key: 'leaving', label: 'Leaving' },
];
/** Joining = on it from a future date (the roster's `all` view carries them). */
const matches = (p: RosterPerson, f: Filter, today: string) =>
  f === 'all'
    ? true
    : f === 'blocked'
      ? p.readiness === 'BLOCKED'
      : f === 'attention'
        ? p.readiness === 'ATTENTION'
        : f === 'new'
          ? p.isNewHire
          : f === 'joining'
            ? p.onScheduleSince > today
            : !!p.pendingMove;

/** A group larger than this starts collapsed; an open group draws this many tiles at a time. */
const GROUP_OPEN_LIMIT = 60;
const TILE_PAGE = 120;

/**
 * One pay schedule: the people on it (faces with a readiness ring, grouped
 * by client), the rules that put them there, the year of paydays and what
 * changed when.
 */
export function PayScheduleDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const q = useQuery({ queryKey: ['paySchedules', 'detail', id], queryFn: () => getPaySchedule(id), enabled: !!id });
  // The same roster the People tab shows (today's people plus everyone joining), so the counts agree.
  const roster = useQuery({ queryKey: ['paySchedules', 'roster', id], queryFn: () => getPayScheduleRoster(id), enabled: !!id });
  const start = useChangeDate(q.data?.schedule ?? null);
  const [tab, setTab] = useState('people');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [patternOpen, setPatternOpen] = useState(false);
  const qc = useQueryClient();
  const confirm = useConfirm();
  const setActive = useMutation({
    mutationFn: (isActive: boolean) => updatePaySchedule(id, { isActive }),
    onSuccess: (r) => {
      toast.success(r.schedule.isActive ? 'Schedule reactivated.' : 'Schedule deactivated.');
      void qc.invalidateQueries({ queryKey: ['paySchedules'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not change it.'),
  });
  const crumbs = [{ label: 'Payroll', to: '/payroll' }, { label: 'Pay schedules', to: '/payroll/schedules' }];
  if (q.isError) {
    return <EmptyState title="We couldn’t load this schedule" description={q.error instanceof ApiError ? q.error.message : undefined} action={<Button asChild variant="secondary"><Link to="/payroll/schedules">All schedules</Link></Button>} />;
  }
  const s = q.data?.schedule;
  if (!s) return <Skeleton className="h-96" />;
  // Counted from the roster itself: the API's totals cover today's people, the faces include joiners.
  const everyone = roster.data?.groups.flatMap((g) => g.people);
  const blocked = everyone ? everyone.filter((p) => p.readiness === 'BLOCKED').length : s.blocked;
  const attention = everyone ? everyone.filter((p) => p.readiness === 'ATTENTION').length : s.attention;
  return (
    <>
      <RecordTemplate
        breadcrumbs={[...crumbs, { label: s.name }]}
        identity={
          <span className="grid h-14 w-14 place-items-center rounded-2xl bg-accent-fill/15 text-accent">
            <CalendarClock className="h-8 w-8" aria-hidden="true" />
          </span>
        }
        title={s.name}
        subtitle={s.pattern}
        status={
          <>
            {s.isDefault && (
              <Badge withDot={false} variant="accent">
                <Star className="h-3 w-3" aria-hidden="true" /> Company default
              </Badge>
            )}
            {!s.isActive && (
              <Badge withDot={false} variant="default">
                Inactive
              </Badge>
            )}
          </>
        }
        actions={
          <>
            <Button onClick={() => setAdding(true)} disabled={!s.isActive}>
              <UserPlus className="h-4 w-4" aria-hidden="true" />
              Add people
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="secondary" aria-label="More actions">
                  <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setEditing(true)}>
                  <Pencil className="mr-2 h-4 w-4" aria-hidden="true" /> Edit name and settings
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setPatternOpen(true)}>
                  <CalendarClock className="mr-2 h-4 w-4" aria-hidden="true" /> Change the pay pattern from a date
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() =>
                    void (async () => {
                      if (!s.isActive) return setActive.mutate(true);
                      if (await confirm({ title: `Deactivate ${s.name}?`, description: s.people ? `${s.people} people are on it. Move them first — a run can’t pay people on an inactive schedule.` : 'No run can be started on it until it is reactivated.', confirmLabel: 'Deactivate', destructive: true })) setActive.mutate(false);
                    })()
                  }
                >
                  <Power className="mr-2 h-4 w-4" aria-hidden="true" /> {s.isActive ? 'Deactivate' : 'Reactivate'}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
        summary={
          // No hint that only repeats a zero ("0 · none", F500 G3); a zero is a plain zero.
          <MetricStrip label={`${s.name} at a glance`}>
            <MetricCard label="Next payday" value={shortDay(s.nextPeriod.payDate)} hint={`${weekdayOf(s.nextPeriod.payDate)} · ${s.nextPeriod.adjustedFor ? `moved for ${s.nextPeriod.adjustedFor}` : `for ${periodRange(s.nextPeriod.periodStart, s.nextPeriod.periodEnd)}`}`} />
            <MetricCard label="People" value={String(s.people)} hint={s.pendingJoins || s.pendingLeaves ? [s.pendingJoins && `${s.pendingJoins} joining`, s.pendingLeaves && `${s.pendingLeaves} leaving`].filter(Boolean).join(' · ') : s.people ? 'on it today' : undefined} />
            <MetricCard label="Won’t be paid correctly" value={String(blocked)} hint={blocked ? 'fix before their first check here' : undefined} tone={blocked > 0 ? 'alert' : 'default'} />
            <MetricCard label="Need a look" value={String(attention)} hint={attention ? 'new hires, rate changes…' : undefined} />
          </MetricStrip>
        }
        activeTab={tab}
        onTabChange={setTab}
        tabs={[
          { key: 'people', label: 'People', count: everyone?.length ?? s.people + s.pendingJoins, content: <PeopleTab schedule={s} onAdd={() => setAdding(true)} /> },
          // "Rules": "People" and "Who’s on it" read as the same thing; this tab counts the rules (F500 G3).
          { key: 'rules', label: 'Rules', count: s.rules.length, content: <RulesTab schedule={s} onAdd={() => setAdding(true)} /> },
          { key: 'calendar', label: 'Calendar', content: <CalendarTab schedule={s} /> },
          { key: 'history', label: 'History', content: <HistoryTab id={s.id} /> },
        ]}
      />
      <AddPeopleBuilder open={adding} onOpenChange={setAdding} schedule={{ id: s.id, name: s.name, nextPeriodStart: start.date, nextPayDate: start.payDate, coveredClientIds: s.rules.filter((r) => r.kind === 'CLIENT' && !r.effectiveTo && r.clientId).map((r) => r.clientId!) }} />
      <EditDialog open={editing} onOpenChange={setEditing} schedule={s} />
      <PatternDialog open={patternOpen} onOpenChange={setPatternOpen} schedule={s} />
    </>
  );
}

/* ---- People ------------------------------------------------------------ */

function PeopleTab({ schedule, onAdd }: { schedule: PayScheduleDetail; onAdd: () => void }) {
  const hasClients = useTenant().moduleOn('clientPortal');
  const roster = useQuery({ queryKey: ['paySchedules', 'roster', schedule.id], queryFn: () => getPayScheduleRoster(schedule.id) });
  const all = useQuery({ queryKey: ['paySchedules', 'list'], queryFn: listPaySchedules });
  const [view, setView] = useViewMode<'tiles' | 'list'>('payScheduleRoster', 'tiles', ['tiles', 'list']);
  const [filter, setFilter] = useState<Filter>('all');
  const today = ymdLocal();
  const [card, setCard] = useState<RosterPerson | null>(null);
  const [move, setMove] = useState<{ ids: string[]; label: string; to: PayScheduleSummary } | null>(null);
  const [removing, setRemoving] = useState<string[] | null>(null);
  const others = (all.data?.schedules ?? []).filter((x) => x.id !== schedule.id && x.isActive);
  const groups = useMemo(
    () => (roster.data?.groups ?? []).map((g) => ({ ...g, people: g.people.filter((p) => matches(p, filter, today)) })).filter((g) => g.people.length > 0),
    [roster.data, filter, today],
  );
  const people = useMemo(() => groups.flatMap((g) => g.people), [groups]);
  const counts = useMemo(() => {
    const ps = (roster.data?.groups ?? []).flatMap((g) => g.people);
    return Object.fromEntries(FILTERS.map((f) => [f.key, ps.filter((p) => matches(p, f.key, today)).length])) as Record<Filter, number>;
  }, [roster.data, today]);

  if (roster.isLoading) return <Skeleton className="h-64" />;
  if (roster.isError) return <EmptyState title="We couldn’t load the people on this schedule" action={<Button size="sm" variant="secondary" onClick={() => void roster.refetch()}>Retry</Button>} />;
  if ((roster.data?.totals.total ?? 0) === 0) {
    return (
      <EmptyState
        icon={UserPlus}
        title="No one is on this schedule yet"
        description={hasClients ? 'Add whole clients (everyone hired there later joins too), sites, a pay type or people by name.' : 'Add sites (everyone hired there later joins too), departments, a pay type or people by name.'}
        action={<Button onClick={onAdd}>Add people</Button>}
      />
    );
  }
  const moveMenu = (ids: string[], label: string) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon" variant="ghost" className="h-7 w-7 bg-surface-raised/80" aria-label={`Move ${label}`}>
          <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Move {label} to…</DropdownMenuLabel>
        {others.map((o) => (
          <DropdownMenuItem key={o.id} onSelect={() => setMove({ ids, label, to: o })}>
            {o.name}
          </DropdownMenuItem>
        ))}
        {others.length === 0 && <DropdownMenuItem disabled>No other schedule</DropdownMenuItem>}
        <DropdownMenuItem onSelect={() => setRemoving(ids)}>
          <UserMinus className="mr-2 h-4 w-4" aria-hidden="true" /> Take off this schedule
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="group" aria-label="Show" className="flex flex-wrap gap-1.5">
          {FILTERS.filter((f) => f.key === 'all' || counts[f.key] > 0 || filter === f.key).map((f) => (
            <button
              key={f.key}
              type="button"
              aria-pressed={filter === f.key}
              onClick={() => setFilter(f.key)}
              className={cn(
                'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent coarse:h-10',
                filter === f.key ? 'border-accent bg-accent-fill/15 font-semibold text-ink' : 'border-line text-ink-muted hover:text-ink',
              )}
            >
              {f.label}
              <span className="tabular-nums">{counts[f.key]}</span>
            </button>
          ))}
        </div>
        <ViewToggle<'tiles' | 'list'>
          value={view}
          onChange={setView}
          ariaLabel="View"
          options={[
            { value: 'tiles', label: 'Faces', icon: LayoutGrid },
            { value: 'list', label: 'List', icon: List },
          ]}
        />
      </div>

      {people.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line p-6 text-center text-sm text-ink-muted">No one here matches “{FILTERS.find((f) => f.key === filter)?.label}”.</p>
      ) : view === 'tiles' ? (
        <div className="space-y-4">
          {groups.map((g) => (
            <ClientGroup key={g.clientId ?? 'none'} group={g} defaultOpen={g.people.length <= GROUP_OPEN_LIMIT && groups.length <= 6} onOpen={setCard} moveMenu={moveMenu} />
          ))}
        </div>
      ) : (
        <RosterList people={people} onOpen={setCard} onMove={(ids, to) => setMove({ ids, label: `${ids.length} ${ids.length === 1 ? 'person' : 'people'}`, to })} onRemove={setRemoving} others={others} />
      )}

      <QuickCard person={card} schedule={schedule} others={others} onClose={() => setCard(null)} onMove={(p, to) => setMove({ ids: [p.associateId], label: p.name, to })} />
      <MoveDialog
        open={!!move}
        onOpenChange={(o) => !o && setMove(null)}
        target={move?.to ?? null}
        title={move ? `Move ${move.label} to ${move.to.name}` : ''}
        input={move ? { toScheduleId: move.to.id, fromScheduleId: schedule.id, associateIds: move.ids, clientIds: [] } : null}
      />
      <RemoveDialog ids={removing} schedule={schedule} onClose={() => setRemoving(null)} />
    </div>
  );
}

function ClientGroup({
  group,
  defaultOpen,
  onOpen,
  moveMenu,
}: {
  group: { clientId: string | null; clientName: string; people: RosterPerson[]; counts: { total: number; attention: number; blocked: number } };
  defaultOpen: boolean;
  onOpen: (p: RosterPerson) => void;
  moveMenu: (ids: string[], label: string) => React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [shown, setShown] = useState(TILE_PAGE);
  const need = group.people.filter((p) => p.readiness !== 'READY').length;
  return (
    <section className="rounded-xl border border-line">
      <div className="flex items-center gap-3 p-3">
        <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="flex min-w-0 flex-1 items-center gap-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          {open ? <ChevronDown className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden="true" /> : <ChevronRight className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden="true" />}
          {!open && <AvatarStack people={group.people.map((p) => ({ name: p.name, photoUrl: p.photoUrl }))} max={5} />}
          <span className="min-w-0">
            <span className="block truncate font-medium text-ink">{group.clientName}</span>
            <span className="block text-xs tabular-nums text-ink-muted">
              {group.people.length} {group.people.length === 1 ? 'person' : 'people'}
              {need > 0 ? <span className={cn(group.people.some((p) => p.readiness === 'BLOCKED') ? 'text-alert' : 'text-warning')}> · {need} need attention</span> : ' · all ready'}
            </span>
          </span>
        </button>
        {group.clientId && moveMenu(group.people.map((p) => p.associateId), `everyone at ${group.clientName}`)}
      </div>
      {open && (
        <div className="border-t border-line p-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
            {group.people.slice(0, shown).map((p) => (
              <PersonTile key={p.associateId} person={p} onOpen={() => onOpen(p)} menu={moveMenu([p.associateId], p.name)} />
            ))}
          </div>
          {group.people.length > shown && (
            <div className="mt-3 text-center">
              <Button variant="secondary" size="sm" onClick={() => setShown((n) => n + TILE_PAGE)}>
                Show {Math.min(TILE_PAGE, group.people.length - shown)} more of {group.people.length - shown}
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function RosterList({ people, onOpen, onMove, onRemove, others }: { people: RosterPerson[]; onOpen: (p: RosterPerson) => void; onMove: (ids: string[], to: PayScheduleSummary) => void; onRemove: (ids: string[]) => void; others: PayScheduleSummary[] }) {
  const hasClients = useTenant().moduleOn('clientPortal');
  const columns: GridColumn<RosterPerson>[] = [
    {
      key: 'name',
      header: 'Person',
      primary: true,
      sortable: true,
      accessor: (p) => p.name,
      cell: (p) => (
        <span className="flex min-w-0 items-center gap-2.5">
          <ReadinessRing src={p.photoUrl} name={p.name} level={p.readiness} size="sm" />
          <span className="truncate font-medium text-ink">{p.name}</span>
        </span>
      ),
    },
    ...(hasClients ? [{ key: 'client', header: 'Client', sortable: true, accessor: (p: RosterPerson) => p.clientName ?? '—', cardMeta: true }] : []),
    { key: 'site', header: 'Site', sortable: true, accessor: (p) => p.siteName ?? '—', defaultHidden: true },
    { key: 'payType', header: 'Pay type', sortable: true, accessor: (p) => (p.payType === 'SALARY' ? 'Salaried' : p.payType === 'HOURLY' ? 'Hourly' : '—') },
    { key: 'rate', header: 'Rate', accessor: (p) => p.rateLabel ?? '—', searchable: false },
    {
      key: 'ready',
      header: 'This payday',
      sortable: true,
      accessor: (p) => ({ BLOCKED: 0, ATTENTION: 1, READY: 2 })[p.readiness],
      cell: (p) => (
        <span className="block">
          <ReadinessBadge level={p.readiness} />
          {p.issues.length > 0 && <span className="mt-0.5 block text-xs text-ink-muted">{p.issues.map((i) => i.label).join(' · ')}</span>}
        </span>
      ),
    },
    { key: 'since', header: 'On it since', sortable: true, accessor: (p) => p.onScheduleSince, cell: (p) => <span className="tabular-nums">{payDay(p.onScheduleSince, false)}</span>, defaultHidden: true },
    { key: 'because', header: 'Because', accessor: (p) => becauseSentence(p.because), defaultHidden: true },
    { key: 'moving', header: 'Moving', accessor: (p) => p.pendingMove?.effectiveFrom ?? '', cell: (p) => (p.pendingMove ? <span className="text-xs">{p.pendingMove.toScheduleName ?? 'Off'} · {payDay(p.pendingMove.effectiveFrom, false)}</span> : '—') },
  ];
  return (
    <DataGrid
      id="pay-schedule-roster"
      caption="People on this schedule"
      rows={people}
      columns={columns}
      rowKey={(p) => p.associateId}
      onRowClick={onOpen}
      rowActionLabel={(p) => `Open ${p.name}`}
      noun={{ one: 'person', many: 'people' }}
      search={{ placeholder: hasClients ? 'Name, client or site…' : 'Name or site…' }}
      urlState={false}
      exportCsv={{ filename: 'pay-schedule-people' }}
      selectable={{
        actions: (ids, clear) => (
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="secondary" disabled={others.length === 0}>
                  <MoveRight className="h-4 w-4" aria-hidden="true" /> Move to…
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {others.map((o) => (
                  <DropdownMenuItem
                    key={o.id}
                    onSelect={() => {
                      onMove(ids, o);
                      clear();
                    }}
                  >
                    {o.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                onRemove(ids);
                clear();
              }}
            >
              <UserMinus className="h-4 w-4" aria-hidden="true" /> Take off
            </Button>
          </>
        ),
      }}
    />
  );
}

/** One person, close up: the paycheck facts, why they're on this schedule, and the one thing to fix. */
function QuickCard({ person, schedule, others, onClose, onMove }: { person: RosterPerson | null; schedule: PayScheduleDetail; others: PayScheduleSummary[]; onClose: () => void; onMove: (p: RosterPerson, to: PayScheduleSummary) => void }) {
  const p = person;
  return (
    <Dialog open={!!p} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        {p && (
          <>
            <DialogHeader>
              <div className="flex items-center gap-4">
                <ReadinessRing src={p.photoUrl} name={p.name} level={p.readiness} size="xl" />
                <div className="min-w-0">
                  <DialogTitle className="truncate">{p.name}</DialogTitle>
                  <DialogDescription>{[p.jobTitle, p.siteName ?? p.clientName].filter(Boolean).join(' · ') || '—'}</DialogDescription>
                  <p className={cn('mt-1 text-xs font-medium', p.readiness === 'READY' ? 'text-success' : p.readiness === 'ATTENTION' ? 'text-warning' : 'text-alert')}>{READINESS_LABEL[p.readiness]}</p>
                </div>
              </div>
            </DialogHeader>
            <dl className="grid grid-cols-3 gap-3 rounded-lg border border-line p-3 text-sm">
              <div>
                <dt className="text-2xs uppercase tracking-widest text-ink-muted">Rate</dt>
                <dd className="mt-0.5 font-medium text-ink">{p.rateLabel ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-2xs uppercase tracking-widest text-ink-muted">Last check</dt>
                <dd className="mt-0.5 font-medium tabular-nums text-ink">{p.lastPay ? fmtMoney(p.lastPay.net) : 'None yet'}</dd>
                {p.lastPay && <dd className="text-2xs text-ink-muted">{payDay(p.lastPay.payDate, false)}</dd>}
              </div>
              <div>
                <dt className="text-2xs uppercase tracking-widest text-ink-muted">Year to date</dt>
                <dd className="mt-0.5 font-medium tabular-nums text-ink">{fmtMoney(p.ytdGross)}</dd>
              </div>
            </dl>
            <p className="text-sm text-ink-muted">
              {p.onScheduleSince > ymdLocal() ? 'Joins' : 'On'} {schedule.name} {p.onScheduleSince > ymdLocal() ? 'on' : 'since'} {payDay(p.onScheduleSince, false)} — {lowerFirst(becauseSentence(p.because))}.
              {p.pendingMove && ` Moves to ${p.pendingMove.toScheduleName ?? 'no schedule'} on ${payDay(p.pendingMove.effectiveFrom, false)}.`}
            </p>
            {p.issues.length > 0 && (
              <ul className="space-y-2">
                {issuesByWeight(p.issues).map((i) => (
                  <li key={i.code} className={cn('flex flex-col gap-2 rounded-lg border p-2.5 text-sm sm:flex-row sm:items-center sm:justify-between sm:gap-3', i.level === 'BLOCKED' ? 'border-alert/40 bg-alert/5' : 'border-warning/40 bg-warning/5')}>
                    <span className="min-w-0 text-ink">{i.label}</span>
                    {i.fixPath && (
                      <Button asChild size="sm" variant={i.level === 'BLOCKED' ? 'primary' : 'secondary'} className="shrink-0 self-start sm:self-auto">
                        <Link to={i.fixPath} onClick={onClose}>
                          {i.fixLabel ?? 'Fix'}
                        </Link>
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <DialogFooter>
              <Button asChild variant="secondary">
                <Link to={`/people/${p.associateId}`} onClick={onClose}>
                  Open profile
                </Link>
              </Button>
              {others.length > 0 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button>
                      <MoveRight className="h-4 w-4" aria-hidden="true" /> Move to another schedule
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {others.map((o) => (
                      <DropdownMenuItem
                        key={o.id}
                        onSelect={() => {
                          onMove(p, o);
                          onClose();
                        }}
                      >
                        {o.name}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Taking people off: an exception on this schedule from a date — they fall to the next rule (or the company default). */
function RemoveDialog({ ids, schedule, onClose }: { ids: string[] | null; schedule: PayScheduleDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const first = useChangeDate(schedule);
  const [picked, setDate] = useState<string | null>(null);
  const date = picked ?? first.date;
  const apply = useMutation({
    mutationFn: () => applyMembership(schedule.id, { add: (ids ?? []).map((associateId) => ({ kind: 'EXCLUDE' as const, associateId })), endRuleIds: [], effectiveFrom: date }),
    onSuccess: (r) => {
      toast.success(`${r.impact.leaves} ${r.impact.leaves === 1 ? 'person leaves' : 'people leave'} ${schedule.name} from ${payDay(r.impact.effectiveFrom, false)}.`);
      void qc.invalidateQueries({ queryKey: ['paySchedules'] });
      onClose();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not take them off.'),
  });
  return (
    <Dialog open={!!ids} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Take {ids?.length === 1 ? 'this person' : `${ids?.length ?? 0} people`} off {schedule.name}?</DialogTitle>
          <DialogDescription>From the date you choose they’re paid on whatever schedule covers them next — another rule’s, or the company default. Anyone no schedule covers shows as unassigned.</DialogDescription>
        </DialogHeader>
        <Field label="Last day on this schedule is the day before">{(p) => <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} {...p} />}</Field>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => apply.mutate()} loading={apply.isPending}>
            Take off
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ---- Who's on it ------------------------------------------------------- */

function ruleWords(r: ScheduleRule): string {
  switch (r.kind) {
    case 'CLIENT':
      return `Everyone at ${r.clientName ?? '—'}`;
    case 'SITE':
      return `${r.siteName ?? 'A site'}${r.clientName ? ` (${r.clientName})` : ''} — this site only`;
    case 'DEPARTMENT':
      return `${r.departmentName ?? 'A department'} department`;
    case 'PAY_TYPE':
      return r.payType === 'SALARY' ? 'All salaried people' : 'All hourly people';
    case 'INDIVIDUAL':
      return r.associateName ?? 'A person';
    case 'EXCLUDE':
      return `Except ${r.associateName ?? 'a person'}`;
  }
}

function RulesTab({ schedule, onAdd }: { schedule: PayScheduleDetail; onAdd: () => void }) {
  const hasClients = useTenant().moduleOn('clientPortal');
  const today = ymdLocal();
  const [ending, setEnding] = useState<ScheduleRule | null>(null);
  const groups: Array<{ title: string; rules: ScheduleRule[] }> = [
    { title: hasClients ? 'Whole clients' : 'Whole groups', rules: schedule.rules.filter((r) => r.kind === 'CLIENT') },
    { title: 'Sites and departments', rules: schedule.rules.filter((r) => r.kind === 'SITE' || r.kind === 'DEPARTMENT') },
    { title: 'By pay type', rules: schedule.rules.filter((r) => r.kind === 'PAY_TYPE') },
    { title: `People by name (${schedule.rules.filter((r) => r.kind === 'INDIVIDUAL').length})`, rules: schedule.rules.filter((r) => r.kind === 'INDIVIDUAL') },
    { title: `Except (${schedule.rules.filter((r) => r.kind === 'EXCLUDE').length})`, rules: schedule.rules.filter((r) => r.kind === 'EXCLUDE') },
  ].filter((g) => g.rules.length > 0);
  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-2xl text-sm text-ink-muted">
            The most specific rule wins: a person by name beats a site or department, which beats {hasClients ? 'a whole client' : 'a whole group'}, which beats a pay type
            {schedule.isDefault ? ' — and anyone none of them covers is paid here, as the company default.' : '.'} A transfer to a place covered here moves the person from their next full pay period, and payroll is told.
          </p>
          <Button onClick={onAdd}>
            <UserPlus className="h-4 w-4" aria-hidden="true" /> Add people
          </Button>
        </CardContent>
      </Card>
      {groups.length === 0 ? (
        <EmptyState icon={UserPlus} title="No rules yet" description={schedule.isDefault ? 'As the company default, it pays everyone no other schedule covers.' : hasClients ? 'Add clients, sites, a pay type or people by name.' : 'Add sites, departments, a pay type or people by name.'} />
      ) : (
        groups.map((g) => (
          <section key={g.title}>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-ink-muted">{g.title}</h3>
            <ul className="divide-y divide-line rounded-xl border border-line">
              {g.rules.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <span className="min-w-0">
                    <span className="block font-medium text-ink">{ruleWords(r)}</span>
                    <span className="block text-xs text-ink-muted">
                      {r.effectiveFrom > today
                        ? `Starts ${payDay(r.effectiveFrom, false)}`
                        : `${r.kind === 'EXCLUDE' ? 'Not paid on this schedule' : `${r.matches} ${r.matches === 1 ? 'person' : 'people'}`} · since ${payDay(r.effectiveFrom, false)}`}
                      {r.effectiveTo && ` · ends ${payDay(r.effectiveTo, false)}`}
                      {r.createdByName && ` · added by ${r.createdByName}`}
                    </span>
                  </span>
                  {!r.effectiveTo && (
                    <Button size="sm" variant="ghost" onClick={() => setEnding(r)}>
                      End from a date
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
      <EndRuleDialog rule={ending} schedule={schedule} onClose={() => setEnding(null)} />
    </div>
  );
}

function EndRuleDialog({ rule, schedule, onClose }: { rule: ScheduleRule | null; schedule: PayScheduleDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const first = useChangeDate(schedule);
  const [picked, setDate] = useState<string | null>(null);
  const date = picked ?? first.date;
  const end = useMutation({
    mutationFn: () => endScheduleRule(schedule.id, rule!.id, date),
    onSuccess: (r) => {
      toast.success(`${r.impact.leaves} ${r.impact.leaves === 1 ? 'person leaves' : 'people leave'} from ${payDay(r.impact.effectiveFrom, false)}. Payroll was told.`);
      void qc.invalidateQueries({ queryKey: ['paySchedules'] });
      onClose();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not end the rule.'),
  });
  return (
    <Dialog open={!!rule} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>End “{rule ? ruleWords(rule) : ''}”</DialogTitle>
          <DialogDescription>From this date, the people it covers are paid on whatever schedule covers them next. Pay before it stays here.</DialogDescription>
        </DialogHeader>
        <Field label="Stop from" hint={`${schedule.name}’s next pay period starts ${payDay(first.date)}.`}>{(p) => <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} {...p} />}</Field>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => end.mutate()} loading={end.isPending}>
            End rule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ---- Calendar and history ---------------------------------------------- */

function CalendarTab({ schedule }: { schedule: PayScheduleDetail }) {
  const q = useQuery({ queryKey: ['paySchedules', 'calendar', schedule.id], queryFn: () => getPayCalendar(schedule.id, 12) });
  return (
    <div className="space-y-3">
      {schedule.pendingVersion && (
        <Card className="border-accent/40">
          <CardContent className="text-sm text-ink">
            From {payDay(schedule.pendingVersion.effectiveFrom)} the pattern becomes: <span className="font-medium">{schedule.pendingVersion.pattern}</span>.
          </CardContent>
        </Card>
      )}
      {q.isLoading ? <Skeleton className="h-64" /> : q.isError ? <p className="text-sm text-alert">Could not load the calendar.</p> : <PayCalendar periods={q.data?.periods ?? []} linkRun={(id) => `/payroll/runs/${id}/close`} />}
    </div>
  );
}

function HistoryTab({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['paySchedules', 'history', id], queryFn: () => getPayScheduleHistory(id) });
  if (q.isLoading) return <Skeleton className="h-40" />;
  const events = q.data?.events ?? [];
  if (events.length === 0) return <EmptyState icon={CalendarClock} title="Nothing has changed yet" description="Rules added or ended, pattern changes and people joining or leaving show up here." />;
  return (
    <ol className="relative space-y-4 border-l border-line pl-5">
      {groupHistory(events).map((g, i) => (
        <HistoryItem key={`${g.at}-${i}`} group={g} />
      ))}
    </ol>
  );
}

type HistoryEvent = PayScheduleHistoryResponse['events'][number];
type HistoryGroup = HistoryEvent & { more: HistoryEvent[] };

/** One change that moved many people reads as one line ("9 people join"), names on demand. */
export function groupHistory(events: HistoryEvent[]): HistoryGroup[] {
  const out: HistoryGroup[] = [];
  for (const e of events) {
    const last = out[out.length - 1];
    const people = e.kind === 'PERSON_JOINED' || e.kind === 'PERSON_LEFT';
    if (people && last && last.kind === e.kind && last.at.slice(0, 16) === e.at.slice(0, 16) && last.actorName === e.actorName) last.more.push(e);
    else out.push({ ...e, more: [] });
  }
  return out;
}

function HistoryItem({ group: g }: { group: HistoryGroup }) {
  const [open, setOpen] = useState(false);
  const n = g.more.length + 1;
  return (
    <li className="relative">
      <span className={cn('absolute -left-[26px] top-1 h-3 w-3 rounded-full border-2 border-surface', g.kind === 'PERSON_JOINED' ? 'bg-success' : g.kind === 'PERSON_LEFT' ? 'bg-warning' : g.kind === 'PATTERN_CHANGED' ? 'bg-accent' : 'bg-ink-muted')} aria-hidden="true" />
      {n === 1 ? (
        <p className="text-sm text-ink">{g.summary}</p>
      ) : (
        <>
          <p className="text-sm text-ink">
            {n} people {g.kind === 'PERSON_JOINED' ? 'join' : 'leave'}{' '}
            <button type="button" className="text-accent underline-offset-2 hover:underline" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              {open ? 'Hide names' : 'See who'}
            </button>
          </p>
          {open && (
            <ul className="mt-1 space-y-0.5 text-sm text-ink-muted">
              {[g, ...g.more].map((e, i) => (
                <li key={i}>{e.summary}</li>
              ))}
            </ul>
          )}
        </>
      )}
      <p className="text-xs text-ink-muted">
        {fmtDateTime(g.at)}
        {g.actorName ? ` · ${g.actorName}` : ' · automatic'}
      </p>
    </li>
  );
}

/* ---- Edit and change the pattern --------------------------------------- */

function EditDialog({ open, onOpenChange, schedule }: { open: boolean; onOpenChange: (o: boolean) => void; schedule: PayScheduleDetail }) {
  const qc = useQueryClient();
  const [name, setName] = useState(schedule.name);
  const [notes, setNotes] = useState(schedule.notes ?? '');
  const [isDefault, setIsDefault] = useState(schedule.isDefault);
  const save = useMutation({
    mutationFn: () => updatePaySchedule(schedule.id, { name: name.trim(), notes: notes.trim() || null, isDefault }),
    onSuccess: () => {
      toast.success('Saved.');
      void qc.invalidateQueries({ queryKey: ['paySchedules'] });
      onOpenChange(false);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save.'),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit {schedule.name}</DialogTitle>
          <DialogDescription>To change when people are paid, use “Change the pay pattern from a date”.</DialogDescription>
        </DialogHeader>
        <Field label="Name">{(p) => <Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} {...p} />}</Field>
        <Field label="Notes">{(p) => <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} {...p} />}</Field>
        <label className="flex cursor-pointer items-start gap-3 text-sm">
          <input type="checkbox" className="mt-0.5 h-4 w-4 accent-gold" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
          <span>
            <span className="block font-medium text-ink">Company default</span>
            <span className="block text-ink-muted">Pays everyone no other rule covers, including new hires.</span>
          </span>
        </label>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!name.trim()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const lowerFirst = (t: string) => (t ? t[0]!.toLowerCase() + t.slice(1) : t);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The date a refusal suggests ("…The next one starts Nov 14."), as the next such day after today. */
export function suggestedDate(message: string, today = ymdLocal()): string | null {
  const m = /(?:starts|is) ([A-Z][a-z]{2}) (\d{1,2})\.?\s*$/.exec(message.trim());
  const month = m ? MONTHS.indexOf(m[1]!) : -1;
  if (!m || month < 0) return null;
  const year = Number(today.slice(0, 4));
  for (const y of [year, year + 1]) {
    const d = `${y}-${String(month + 1).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
    if (d > today) return d;
  }
  return null;
}

const PATTERN_REFUSALS = new Set(['effective_from_required', 'effective_in_past', 'not_a_period_start']);

function PatternDialog({ open, onOpenChange, schedule }: { open: boolean; onOpenChange: (o: boolean) => void; schedule: PayScheduleDetail }) {
  const qc = useQueryClient();
  const today = ymdLocal();
  const cal = useQuery({ queryKey: ['paySchedules', 'calendar', schedule.id], queryFn: () => getPayCalendar(schedule.id, 12), enabled: open });
  const [frequency, setFrequency] = useState<PayFrequencyKind>(schedule.frequency);
  const [offset, setOffset] = useState(schedule.payDateOffsetDays);
  const [from, setFrom] = useState('');
  const [refusal, setRefusal] = useState<{ message: string; suggestion: string | null } | null>(null);
  const starts = (cal.data?.periods ?? []).map((p) => p.periodStart).filter((d) => d > today);
  const effectiveFrom = from || starts[0] || '';
  const changed = frequency !== schedule.frequency || offset !== schedule.payDateOffsetDays;
  // Week-based periods count from the first new period; calendar-based ones ignore the anchor.
  const preview = useQuery({
    queryKey: ['paySchedules', 'previewPattern', schedule.id, frequency, effectiveFrom, offset],
    queryFn: () => previewPattern({ frequency, anchorDate: effectiveFrom, payDateOffsetDays: offset, months: 3, scheduleId: schedule.id, effectiveFrom }),
    enabled: open && changed && !!effectiveFrom,
  });
  const bridge = preview.data?.periods.find((p) => p.bridge && p.periodStart === effectiveFrom) ?? null;
  const save = useMutation({
    mutationFn: () => updatePaySchedule(schedule.id, { frequency, payDateOffsetDays: offset, effectiveFrom }),
    onSuccess: () => {
      toast.success(`The new pattern starts ${payDay(effectiveFrom)}. Earlier periods keep the old one; the change is in this schedule’s history.`);
      void qc.invalidateQueries({ queryKey: ['paySchedules'] });
      setRefusal(null);
      onOpenChange(false);
    },
    onError: (err) => {
      if (err instanceof ApiError && PATTERN_REFUSALS.has(err.code)) setRefusal({ message: err.message, suggestion: suggestedDate(err.message, today) });
      else toast.error(err instanceof ApiError ? err.message : 'Could not change the pattern.');
    },
  });
  const pick = (d: string) => {
    setFrom(d);
    setRefusal(null);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Change the pay pattern</DialogTitle>
          <DialogDescription>Today: {schedule.pattern.charAt(0).toLowerCase() + schedule.pattern.slice(1)}. The change starts with a future pay period; periods before it, and every paycheck already made, stay as they are.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="How often">
            {(p) => (
              <Select value={frequency} onChange={(e) => { setFrequency(e.target.value as PayFrequencyKind); setRefusal(null); }} {...p}>
                <option value="WEEKLY">Every week</option>
                <option value="BIWEEKLY">Every other week</option>
                <option value="SEMIMONTHLY">Twice a month</option>
                <option value="MONTHLY">Once a month</option>
                <option value="DAILY">Every day</option>
              </Select>
            )}
          </Field>
          <Field label="Payday">
            {(p) => (
              <Select value={String(offset)} onChange={(e) => { setOffset(Number(e.target.value)); setRefusal(null); }} {...p}>
                {Array.from({ length: 16 }, (_, n) => (
                  <option key={n} value={n}>
                    {n === 0 ? 'The period’s last day' : `${n} ${n === 1 ? 'day' : 'days'} after the period ends`}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Starting with the period of" className="sm:col-span-2">
            {(p) => (
              <Select value={effectiveFrom} onChange={(e) => pick(e.target.value)} {...p}>
                {from && !starts.includes(from) && <option value={from}>{payDay(from)}</option>}
                {starts.map((d) => (
                  <option key={d} value={d}>
                    {payDay(d)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        {refusal && (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm text-ink">
            <span className="min-w-0 flex-1">{refusal.message}</span>
            {refusal.suggestion && (
              <Button size="sm" variant="secondary" onClick={() => pick(refusal.suggestion!)}>
                Start {payDay(refusal.suggestion, false)} instead
              </Button>
            )}
          </div>
        )}
        {changed && preview.data && preview.data.periods.length > 0 && (
          <div className="rounded-lg border border-line p-3 text-sm">
            <p className="font-medium text-ink">{patternSentence(frequency, effectiveFrom, offset)}</p>
            {bridge && (
              <p className="mt-1 text-ink">
                The new periods don’t line up with {payDay(effectiveFrom, false)}, so one short period, {periodRange(bridge.periodStart, bridge.periodEnd)}, paid{' '}
                {payDay(bridge.payDate, false)}, joins the two. No day is paid twice or missed.
              </p>
            )}
            <p className="mt-1 text-ink-muted">
              First paydays: {preview.data.periods.slice(0, 3).map((p) => payDay(p.payDate, false)).join(' · ')}
            </p>
          </div>
        )}
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!changed || !effectiveFrom}>
            Schedule the change
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
