import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { sanitizeReturnPath } from '@/lib/returnPath';
import { Building2, Check, MapPin, Search, UserMinus, UserPlus, Users } from '@/components/ui/icons';
import type { MembershipChangeInput, ScheduleCandidate } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useTenant } from '@/lib/auth';
import { applyMembership, listScheduleCandidates, previewMembership, type CandidateFilters } from '@/lib/paySchedulesApi';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Drawer, DrawerBody, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/Drawer';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { toast } from '@/components/ui/Toaster';
import { cn } from '@/lib/cn';
import { ImpactPeople, impactLine } from './MoveDialog';
import { payDay } from './scheduleKit';

type Add = MembershipChangeInput['add'][number];

export interface BuilderSchedule {
  id: string | null;
  name: string;
  nextPeriodStart: string;
  /** The payday of the period starting nextPeriodStart, when known. */
  nextPayDate: string | null;
  /** Clients a rule on this schedule already covers. */
  coveredClientIds?: string[];
}

/** The choices the builder holds; turned into rules on apply. */
export interface BuilderSelection {
  clientIds: string[];
  siteIds: string[];
  departmentIds: string[];
  payType: 'HOURLY' | 'SALARY' | null;
  include: Map<string, ScheduleCandidate>;
  exclude: Map<string, ScheduleCandidate>;
  effectiveFrom: string;
}

export function emptySelection(effectiveFrom: string): BuilderSelection {
  return { clientIds: [], siteIds: [], departmentIds: [], payType: null, include: new Map(), exclude: new Map(), effectiveFrom };
}

/** The rules a selection makes: whole clients, sites, departments, a pay type, individuals and exclusions. */
export function toMembershipInput(s: BuilderSelection): MembershipChangeInput {
  const add: Add[] = [
    ...s.clientIds.map((clientId) => ({ kind: 'CLIENT' as const, clientId })),
    ...s.siteIds.map((siteId) => ({ kind: 'SITE' as const, siteId })),
    ...s.departmentIds.map((departmentId) => ({ kind: 'DEPARTMENT' as const, departmentId })),
    ...(s.payType ? [{ kind: 'PAY_TYPE' as const, payType: s.payType }] : []),
    ...[...s.include.keys()].map((associateId) => ({ kind: 'INDIVIDUAL' as const, associateId })),
    ...[...s.exclude.keys()].map((associateId) => ({ kind: 'EXCLUDE' as const, associateId })),
  ];
  return { add, endRuleIds: [], effectiveFrom: s.effectiveFrom || undefined };
}

export function selectionCount(s: BuilderSelection): number {
  return s.clientIds.length + s.siteIds.length + s.departmentIds.length + (s.payType ? 1 : 0) + s.include.size + s.exclude.size;
}

/**
 * Who's on a schedule, chosen the way payroll thinks about it: whole clients
 * (including everyone hired there later), sites or departments within them,
 * a pay type, named individuals, and exceptions — from a date.
 */
export function PeoplePicker({ value, onChange, schedule }: { value: BuilderSelection; onChange: (next: BuilderSelection) => void; schedule: BuilderSchedule }) {
  const facets = useQuery({ queryKey: ['paySchedules', 'candidates', 'facets'], queryFn: () => listScheduleCandidates({}) });
  // A direct employer has no clients: its people are chosen by site, pay type and name.
  const hasClients = useTenant().moduleOn('clientPortal');
  const [filters, setFilters] = useState<CandidateFilters>({});
  const [q, setQ] = useState('');
  const dq = useDebouncedValue(q, 250);
  const list = useQuery({
    queryKey: ['paySchedules', 'candidates', filters, dq],
    queryFn: () => listScheduleCandidates({ ...filters, q: dq || undefined }),
  });
  const [selectingAll, setSelectingAll] = useState(false);
  const f = facets.data?.facets;
  const set = (patch: Partial<BuilderSelection>) => onChange({ ...value, ...patch });
  const toggle = (arr: string[], id: string) => (arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id]);
  const toggleInclude = (p: ScheduleCandidate) => {
    const include = new Map(value.include);
    const exclude = new Map(value.exclude);
    if (include.has(p.associateId)) include.delete(p.associateId);
    else {
      include.set(p.associateId, p);
      exclude.delete(p.associateId);
    }
    set({ include, exclude });
  };
  const toggleExclude = (p: ScheduleCandidate) => {
    const include = new Map(value.include);
    const exclude = new Map(value.exclude);
    if (exclude.has(p.associateId)) exclude.delete(p.associateId);
    else {
      exclude.set(p.associateId, p);
      include.delete(p.associateId);
    }
    set({ include, exclude });
  };
  // "Select all N matching": walk every page of the current filters.
  const selectAllMatching = async () => {
    setSelectingAll(true);
    try {
      const include = new Map(value.include);
      let cursor: string | undefined;
      for (let i = 0; i < 20; i++) {
        const page = await listScheduleCandidates({ ...filters, q: dq || undefined, cursor, limit: 500 });
        for (const p of page.people) if (!value.exclude.has(p.associateId)) include.set(p.associateId, p);
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      set({ include });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not select them all.');
    } finally {
      setSelectingAll(false);
    }
  };
  // Sites with the same name (two "The Grand Hotel"s) say whose they are.
  const siteLabel = (site: { name: string; clientId: string | null }) => {
    if ((f?.sites ?? []).filter((x) => x.name === site.name).length < 2) return site.name;
    const client = f?.clients.find((c) => c.id === site.clientId)?.name;
    return client ? `${site.name} · ${client}` : site.name;
  };
  const sitesForChosen = (f?.sites ?? []).filter((s) => !s.clientId || value.clientIds.length === 0 || !value.clientIds.includes(s.clientId));

  return (
    <div className="space-y-7">
      {hasClients && (
      <section aria-labelledby="pp-clients">
        <h3 id="pp-clients" className="flex items-center gap-2 text-sm font-semibold text-ink">
          <Building2 className="h-4 w-4 text-ink-muted" aria-hidden="true" />
          Whole clients
        </h3>
        <p className="mt-0.5 text-xs text-ink-muted">Everyone who works there — including people hired there later.</p>
        {facets.isLoading ? (
          <Skeleton className="mt-3 h-20" />
        ) : (
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {(f?.clients ?? []).map((c) => {
              const covered = schedule.coveredClientIds?.includes(c.id) ?? false;
              const on = covered || value.clientIds.includes(c.id);
              return (
                <button
                  key={c.id}
                  type="button"
                  aria-pressed={on}
                  disabled={covered}
                  onClick={() => set({ clientIds: toggle(value.clientIds, c.id) })}
                  className={cn(
                    'flex min-h-14 items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default',
                    covered ? 'border-line bg-surface-sunken/60' : on ? 'border-accent bg-accent-fill/10' : 'border-line hover:border-accent/40',
                  )}
                >
                  <span className={cn('grid h-5 w-5 shrink-0 place-items-center rounded border', covered ? 'border-line bg-surface-sunken text-ink-muted' : on ? 'border-accent bg-accent text-on-accent' : 'border-line')}>
                    {on && <Check className="h-3.5 w-3.5" aria-hidden="true" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-ink">Everyone at {c.name}</span>
                    <span className="block text-xs tabular-nums text-ink-muted">{covered ? `Already on ${schedule.name}` : `${c.count} ${c.count === 1 ? 'person' : 'people'} today`}</span>
                  </span>
                </button>
              );
            })}
            {(f?.clients ?? []).length === 0 && <p className="text-sm text-ink-muted">No clients.</p>}
          </div>
        )}
      </section>
      )}

      {(sitesForChosen.length > 0 || (f?.departments ?? []).length > 0) && (
        <section aria-labelledby="pp-sites">
          <h3 id="pp-sites" className="flex items-center gap-2 text-sm font-semibold text-ink">
            <MapPin className="h-4 w-4 text-ink-muted" aria-hidden="true" />
            {hasClients ? 'Only some sites or departments' : 'Sites or departments'}
          </h3>
          <p className="mt-0.5 text-xs text-ink-muted">{hasClients ? 'For a client whose sites are paid on different schedules.' : 'Everyone who works there — including people hired there later.'}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {sitesForChosen.map((s) => {
              const on = value.siteIds.includes(s.id);
              return (
                <button key={s.id} type="button" aria-pressed={on} onClick={() => set({ siteIds: toggle(value.siteIds, s.id) })} className={chip(on)}>
                  {siteLabel(s)} <span className="tabular-nums text-ink-muted">{s.count}</span>
                </button>
              );
            })}
            {(f?.departments ?? []).map((d) => {
              const on = value.departmentIds.includes(d.id);
              return (
                <button key={d.id} type="button" aria-pressed={on} onClick={() => set({ departmentIds: toggle(value.departmentIds, d.id) })} className={chip(on)}>
                  {d.name} <span className="tabular-nums text-ink-muted">{d.count}</span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      <section aria-labelledby="pp-paytype">
        <h3 id="pp-paytype" className="text-sm font-semibold text-ink">
          By pay type
        </h3>
        <SegmentedControl<'ANY' | 'HOURLY' | 'SALARY'>
          className="mt-2"
          ariaLabel="By pay type"
          value={value.payType ?? 'ANY'}
          onChange={(v) => set({ payType: v === 'ANY' ? null : v })}
          options={[
            { value: 'ANY', label: 'Not by pay type' },
            { value: 'HOURLY', label: 'All hourly' },
            { value: 'SALARY', label: 'All salaried' },
          ]}
        />
      </section>

      <section aria-labelledby="pp-people">
        <h3 id="pp-people" className="flex items-center gap-2 text-sm font-semibold text-ink">
          <Users className="h-4 w-4 text-ink-muted" aria-hidden="true" />
          People
        </h3>
        <p className="mt-0.5 text-xs text-ink-muted">Anyone, new hires included. Add them by name, or leave someone out of a group you chose.</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <div className="relative sm:col-span-2 lg:col-span-3">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" aria-hidden="true" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or email…" className="pl-9" aria-label="Search people" />
          </div>
          {hasClients && (
          <Select aria-label="Client" value={filters.clientId ?? ''} onChange={(e) => setFilters({ ...filters, clientId: e.target.value || undefined, siteId: undefined })}>
            <option value="">Any client</option>
            {(f?.clients ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          )}
          <Select aria-label="Site" value={filters.siteId ?? ''} onChange={(e) => setFilters({ ...filters, siteId: e.target.value || undefined })}>
            <option value="">Any site</option>
            {(f?.sites ?? []).filter((s) => !filters.clientId || s.clientId === filters.clientId).map((s) => (
              <option key={s.id} value={s.id}>
                {siteLabel(s)}
              </option>
            ))}
          </Select>
          <Select aria-label="Pay type" value={filters.payType ?? ''} onChange={(e) => setFilters({ ...filters, payType: (e.target.value || undefined) as CandidateFilters['payType'] })}>
            <option value="">Any pay type</option>
            <option value="HOURLY">Hourly</option>
            <option value="SALARY">Salaried</option>
          </Select>
          <Select aria-label="Status" value={filters.status ?? ''} onChange={(e) => setFilters({ ...filters, status: (e.target.value || undefined) as CandidateFilters['status'] })}>
            <option value="">Everyone</option>
            <option value="NEW_HIRE">New hires</option>
            <option value="ACTIVE">Working</option>
            <option value="INACTIVE">Not working now</option>
          </Select>
          <Select aria-label="Pay schedule now" value={filters.scheduleId ?? ''} onChange={(e) => setFilters({ ...filters, scheduleId: e.target.value || undefined })}>
            <option value="">Any schedule or none</option>
            <option value="none">On no schedule</option>
            {schedule.id && <option value={schedule.id}>Already on {schedule.name}</option>}
          </Select>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-ink-muted">
          <span className="tabular-nums">{list.data ? `${list.data.total} matching` : ' '}</span>
          <Button size="sm" variant="secondary" onClick={() => void selectAllMatching()} loading={selectingAll} disabled={!list.data || list.data.total === 0 || selectingAll}>
            Select all {list.data?.total ?? ''} matching
          </Button>
        </div>
        <div className="mt-2 max-h-[22rem] overflow-y-auto rounded-lg border border-line">
          {list.isLoading ? (
            <Skeleton className="m-3 h-40" />
          ) : list.isError ? (
            <p className="p-4 text-sm text-alert">Could not load people.</p>
          ) : (list.data?.people ?? []).length === 0 ? (
            <p className="p-4 text-sm text-ink-muted">No one matches.</p>
          ) : (
            <ul className="divide-y divide-line">
              {list.data!.people.map((p) => {
                const inc = value.include.has(p.associateId);
                const exc = value.exclude.has(p.associateId);
                const onThis = schedule.id && p.currentScheduleId === schedule.id;
                return (
                  <li key={p.associateId} className={cn('flex items-center gap-3 px-3 py-2', inc && 'bg-accent-fill/10', exc && 'bg-alert/5')}>
                    <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                      <input type="checkbox" className="h-4 w-4 shrink-0 accent-gold" checked={inc} onChange={() => toggleInclude(p)} aria-label={`Add ${p.name}`} />
                      <Avatar src={p.photoUrl} name={p.name} size="sm" />
                      <span className="min-w-0">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="truncate text-sm font-medium text-ink">{p.name}</span>
                          {p.status === 'NEW_HIRE' && (
                            <Badge size="sm" withDot={false} variant="info">
                              New hire
                            </Badge>
                          )}
                        </span>
                        <span className="block truncate text-xs text-ink-muted">
                          {[p.clientName, p.siteName].filter(Boolean).join(' · ') || 'Not placed yet'} · {onThis ? 'already on this schedule' : p.currentScheduleName ? `on ${p.currentScheduleName}` : 'on no schedule'}
                        </span>
                      </span>
                    </label>
                    <Button size="xs" variant={exc ? 'destructive' : 'ghost'} onClick={() => toggleExclude(p)} aria-pressed={exc} aria-label={`${exc ? 'Stop leaving out' : 'Leave out'} ${p.name}`}>
                      <UserMinus className="h-3.5 w-3.5" aria-hidden="true" />
                      {exc ? 'Left out' : 'Leave out'}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      <section aria-labelledby="pp-date">
        <h3 id="pp-date" className="text-sm font-semibold text-ink">
          Starting
        </h3>
        <Field
          className="mt-2 max-w-xs"
          label="First day on this schedule"
          hint={value.effectiveFrom === schedule.nextPeriodStart ? `The start of the next pay period${schedule.nextPayDate ? ` — their first check here is ${payDay(schedule.nextPayDate)}` : ''}. Pay for the days before stays on their current schedule.` : 'Pay for the days before this stays on their current schedule.'}
        >
          {(p) => <Input type="date" value={value.effectiveFrom} onChange={(e) => set({ effectiveFrom: e.target.value })} {...p} />}
        </Field>
      </section>
    </div>
  );
}

const chip = (on: boolean) =>
  cn(
    'inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
    on ? 'border-accent bg-accent-fill/15 text-ink' : 'border-line text-ink-muted hover:text-ink',
  );

/** The chosen rules in plain words, for review screens. */
export function SelectionSummary({ value, clientName, siteName, departmentName }: { value: BuilderSelection; clientName: (id: string) => string; siteName: (id: string) => string; departmentName: (id: string) => string }) {
  const lines = [
    ...value.clientIds.map((id) => `Everyone at ${clientName(id)}`),
    ...value.siteIds.map((id) => `${siteName(id)} site`),
    ...value.departmentIds.map((id) => `${departmentName(id)} department`),
    ...(value.payType ? [value.payType === 'HOURLY' ? 'All hourly people' : 'All salaried people'] : []),
    ...(value.include.size ? [`${value.include.size} ${value.include.size === 1 ? 'person' : 'people'} by name`] : []),
    ...(value.exclude.size ? [`Leaving out ${[...value.exclude.values()].map((p) => p.name).slice(0, 3).join(', ')}${value.exclude.size > 3 ? ` and ${value.exclude.size - 3} more` : ''}`] : []),
  ];
  if (lines.length === 0) return <p className="text-sm text-ink-muted">Choose who joins: groups, a pay type or people by name.</p>;
  return (
    <ul className="space-y-1 text-sm text-ink">
      {lines.map((l) => (
        <li key={l} className="flex items-start gap-2">
          <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
          {l}
        </li>
      ))}
    </ul>
  );
}

/**
 * The add-people builder for an existing schedule: choose, see the effect
 * live, review every move, apply.
 */
export function AddPeopleBuilder({
  open,
  onOpenChange,
  schedule,
  initialInclude,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  schedule: BuilderSchedule & { id: string };
  /** People already chosen when the builder opens (the unassigned bucket's fix). */
  initialInclude?: ScheduleCandidate[];
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const hasClients = useTenant().moduleOn('clientPortal');
  const [step, setStep] = useState<'choose' | 'review'>('choose');
  const [sel, setSel] = useState<BuilderSelection>(() => emptySelection(schedule.nextPeriodStart));
  // The default date firms up once the schedule's calendar loads; follow it until someone picks a day.
  const defaultDate = useRef(schedule.nextPeriodStart);
  useEffect(() => {
    const was = defaultDate.current;
    defaultDate.current = schedule.nextPeriodStart;
    setSel((cur) => (cur.effectiveFrom === was ? { ...cur, effectiveFrom: schedule.nextPeriodStart } : cur));
  }, [schedule.nextPeriodStart]);
  useEffect(() => {
    if (open) {
      setStep('choose');
      const next = emptySelection(schedule.nextPeriodStart);
      for (const p of initialInclude ?? []) next.include.set(p.associateId, p);
      setSel(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only when the drawer opens
  }, [open, initialInclude]);
  const input = useMemo(() => toMembershipInput(sel), [sel]);
  const debounced = useDebouncedValue(input, 400);
  const count = selectionCount(sel);
  const preview = useQuery({
    queryKey: ['paySchedules', 'membershipPreview', schedule.id, debounced],
    queryFn: () => previewMembership(schedule.id, debounced),
    enabled: open && debounced.add.length > 0,
  });
  const apply = useMutation({
    mutationFn: () => applyMembership(schedule.id, input),
    onSuccess: (r) => {
      toast.success(`${r.impact.joins} ${r.impact.joins === 1 ? 'person joins' : 'people join'} ${schedule.name} from ${payDay(r.impact.effectiveFrom, false)}. Payroll was told.`);
      void qc.invalidateQueries({ queryKey: ['paySchedules'] });
      onOpenChange(false);
      // Sent here from the run-payroll wizard (?return=): the people are on
      // the schedule now, so go straight back to the run.
      const back = sanitizeReturnPath(params.get('return'));
      if (back) navigate(back);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not add them.'),
  });
  return (
    <Drawer open={open} onOpenChange={onOpenChange} width="max-w-3xl" confirmDiscard={count > 0 && !apply.isSuccess}>
      <DrawerHeader>
        <DrawerTitle>Add people to {schedule.name}</DrawerTitle>
        <DrawerDescription>{step === 'choose' ? hasClients ? 'Whole clients, some sites, a pay type, or people by name — from a date.' : 'Sites, departments, a pay type, or people by name — from a date.' : 'Everyone who moves, and from where. Nothing changes until you apply.'}</DrawerDescription>
      </DrawerHeader>
      <DrawerBody>
        {step === 'choose' ? (
          <PeoplePicker value={sel} onChange={setSel} schedule={schedule} />
        ) : preview.data ? (
          <div className="space-y-4">
            <p className="text-sm font-medium text-ink">{impactLine(preview.data)}</p>
            <ImpactPeople impact={preview.data} />
          </div>
        ) : (
          <Skeleton className="h-40" />
        )}
      </DrawerBody>
      <DrawerFooter className="flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-ink-muted" aria-live="polite">
          {count === 0 ? 'Choose who joins.' : preview.isFetching && !preview.data ? 'Working out who moves…' : preview.data ? impactLine(preview.data) : ' '}
        </p>
        <div className="flex justify-end gap-2">
          {step === 'review' ? (
            <>
              <Button variant="secondary" onClick={() => setStep('choose')}>
                Back
              </Button>
              <Button onClick={() => apply.mutate()} loading={apply.isPending} disabled={!preview.data || apply.isPending}>
                <UserPlus className="h-4 w-4" aria-hidden="true" />
                Apply
              </Button>
            </>
          ) : (
            <Button onClick={() => setStep('review')} disabled={count === 0 || !preview.data}>
              Review {preview.data ? preview.data.joins + preview.data.leaves : ''} {preview.data && preview.data.joins + preview.data.leaves === 1 ? 'change' : 'changes'}
            </Button>
          )}
        </div>
      </DrawerFooter>
    </Drawer>
  );
}
