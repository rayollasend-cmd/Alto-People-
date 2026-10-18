import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Store, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useAuth, useTerm } from '@/lib/auth';
import { hasCapability } from '@/lib/roles';
import { ROLE_LABELS } from '@alto-people/shared';
import {
  BENCH_READINESS_LABELS,
  addToBench,
  getNineBox,
  listStoreBench,
  ratePotential,
  removeFromBench,
  updateBench,
  type BenchReadiness,
  type NineBoxPerson,
  type StoreBench,
} from '@/lib/successionBenchApi';
import { AssociateLink } from '@/components/ui/AssociateLink';
import { AssociatePicker, type PickedAssociate } from '@/components/ui/AssociatePicker';
import { Avatar } from '@/components/ui/Avatar';
import { QueryError } from '@/components/ui/QueryError';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  FilterChip,
  MetricCard,
  Select,
  SectionTitle,
  SkeletonRows,
} from '@/components/ui';
import { cn } from '@/lib/cn';

/**
 * Succession for the seats that run a store, and the 9-box.
 *
 *   By store — each store's leads today and the people who could take a
 *   lead seat next (ready now, in six months, in a year), with the bench's
 *   strength called out: covered, thin, or empty.
 *
 *   9-box — performance (the latest shared review) against potential
 *   (rated here by HR), with the people still missing one of the two.
 */

const READINESS_ORDER: BenchReadiness[] = ['READY_NOW', 'READY_6_MONTHS', 'READY_12_MONTHS'];
const READINESS_VARIANT: Record<BenchReadiness, 'success' | 'pending' | 'outline'> = { READY_NOW: 'success', READY_6_MONTHS: 'pending', READY_12_MONTHS: 'outline' };
const STRENGTH: Record<StoreBench['strength'], { label: string; variant: 'success' | 'pending' | 'destructive' }> = {
  covered: { label: 'Covered', variant: 'success' },
  thin: { label: 'Thin', variant: 'pending' },
  empty: { label: 'No bench', variant: 'destructive' },
};

export function SuccessionByStore() {
  const term = useTerm();
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:performance') : false;
  const qc = useQueryClient();
  const [filter, setFilter] = useState<'all' | StoreBench['strength']>('all');
  const [adding, setAdding] = useState<StoreBench | null>(null);
  const q = useQuery({ queryKey: ['succession', 'stores'], queryFn: () => listStoreBench() });
  const stores = useMemo(() => (q.data?.stores ?? []).filter((s) => filter === 'all' || s.strength === filter), [q.data, filter]);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['succession', 'stores'] });
  const change = useMutation({
    mutationFn: ({ id, readiness }: { id: string; readiness: BenchReadiness }) => updateBench(id, { readiness }),
    onSuccess: refresh,
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not change readiness.'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => removeFromBench(id),
    onSuccess: refresh,
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not remove them.'),
  });
  const storeWord = term('label.store').toLowerCase();

  if (q.isError) return <QueryError what="the bench by store" query={q} />;
  if (q.isPending) return <SkeletonRows count={5} />;
  const sum = q.data.summary;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard label={`Every ${storeWord}`} value={sum.stores} hint={sum.withoutLead ? `${sum.withoutLead} with no lead placed` : 'All have a lead'} />
        <MetricCard label="Covered" value={sum.covered} hint="Someone could step in today" />
        <MetricCard label="Thin" value={sum.thin} hint="Only someone in 6–12 months" />
        <MetricCard label="No bench" value={sum.empty} accent={sum.empty > 0} hint="Nobody named yet" />
      </div>
      <div className="flex flex-wrap gap-2">
        {(['all', 'empty', 'thin', 'covered'] as const).map((f) => (
          <FilterChip key={f} active={filter === f} onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : STRENGTH[f].label}
          </FilterChip>
        ))}
      </div>
      {stores.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState icon={Store} title={`No ${storeWord}s here`} description={`Change the filter, or add ${storeWord}s under Sites.`} />
          </CardContent>
        </Card>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {stores.map((s) => (
            <li key={s.id}>
              <Card className="h-full">
                <CardContent className="space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-ink">{s.name}</div>
                      {s.clientName && <div className="truncate text-xs text-ink-muted">{s.clientName}</div>}
                    </div>
                    <Badge size="sm" variant={STRENGTH[s.strength].variant}>
                      {STRENGTH[s.strength].label}
                    </Badge>
                  </div>
                  <div>
                    <div className="mb-1 text-2xs font-medium uppercase tracking-wider text-ink-muted">Leads today</div>
                    {s.leads.length === 0 ? (
                      <p className="text-xs text-warning">No lead placed at this {storeWord}.</p>
                    ) : (
                      <ul className="space-y-1">
                        {s.leads.map((l) => (
                          <li key={l.userId} className="flex items-center gap-2 text-sm">
                            <Avatar src={l.photoUrl} name={l.name} size="xs" />
                            <span className="truncate text-ink">{l.name}</span>
                            <span className="truncate text-xs text-ink-muted">{ROLE_LABELS[l.role]}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div>
                    <div className="mb-1 text-2xs font-medium uppercase tracking-wider text-ink-muted">Bench</div>
                    {s.bench.length === 0 ? (
                      <p className="text-xs text-ink-muted">Nobody named to step in.</p>
                    ) : (
                      <ul className="space-y-1.5">
                        {s.bench.map((b) => (
                          <li key={b.id} className="flex items-center gap-2 text-sm">
                            <Avatar src={b.photoUrl} name={b.name} size="xs" />
                            <AssociateLink associateId={b.associateId} className="min-w-0 flex-1 truncate text-ink">
                              {b.name}
                            </AssociateLink>
                            {canManage ? (
                              <>
                                <label htmlFor={`ready-${b.id}`} className="sr-only">
                                  Readiness for {b.name}
                                </label>
                                <Select id={`ready-${b.id}`} size="sm" value={b.readiness} onChange={(e) => change.mutate({ id: b.id, readiness: e.target.value as BenchReadiness })}>
                                  {READINESS_ORDER.map((r) => (
                                    <option key={r} value={r}>
                                      {BENCH_READINESS_LABELS[r]}
                                    </option>
                                  ))}
                                </Select>
                                <Button size="icon-sm" variant="ghost" aria-label={`Take ${b.name} off the bench`} onClick={() => remove.mutate(b.id)}>
                                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                                </Button>
                              </>
                            ) : (
                              <Badge size="sm" variant={READINESS_VARIANT[b.readiness]}>
                                {BENCH_READINESS_LABELS[b.readiness]}
                              </Badge>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  {canManage && (
                    <Button size="sm" variant="outline" onClick={() => setAdding(s)}>
                      <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                      Name someone
                    </Button>
                  )}
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
      <AddToBenchDialog store={adding} onClose={() => setAdding(null)} onDone={refresh} />
    </div>
  );
}

function AddToBenchDialog({ store, onClose, onDone }: { store: StoreBench | null; onClose: () => void; onDone: () => void }) {
  const [person, setPerson] = useState<PickedAssociate | null>(null);
  const [readiness, setReadiness] = useState<BenchReadiness>('READY_6_MONTHS');
  const save = useMutation({
    mutationFn: () => addToBench(store!.id, { associateId: person!.id, readiness }),
    onSuccess: () => {
      toast.success(`${person!.name} is on the bench for ${store!.name}.`);
      setPerson(null);
      onDone();
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not add them.'),
  });
  return (
    <Dialog open={!!store} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Who could lead {store?.name}?</DialogTitle>
          <DialogDescription>Name someone who could take a lead seat here, and how soon.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="Person">{(p) => <AssociatePicker id={p.id} value={person} onChange={setPerson} />}</Field>
          <Field label="Ready">
            {(p) => (
              <Select {...p} value={readiness} onChange={(e) => setReadiness(e.target.value as BenchReadiness)}>
                {READINESS_ORDER.map((r) => (
                  <option key={r} value={r}>
                    {BENCH_READINESS_LABELS[r]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={!person} loading={save.isPending}>
            Add to bench
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ----- 9-box ------------------------------------------------------------------ */

const PERF_LABEL = ['', 'Below expectations', 'Meets expectations', 'Exceeds expectations'];
const POT_LABEL = ['', 'Limited potential', 'Growing', 'High potential'];
/** The cell names HR uses, by [potential][performance]. */
const CELL_NAME: Record<string, string> = {
  '3-1': 'Rough diamond',
  '3-2': 'Future star',
  '3-3': 'Star',
  '2-1': 'Inconsistent',
  '2-2': 'Core player',
  '2-3': 'High performer',
  '1-1': 'Talent risk',
  '1-2': 'Effective',
  '1-3': 'Trusted professional',
};

export function NineBox() {
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:performance') : false;
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['succession', 'nine-box'], queryFn: () => getNineBox() });
  const [rating, setRating] = useState<NineBoxPerson | null>(null);

  if (q.isError) return <QueryError what="the 9-box" query={q} />;
  if (q.isPending) return <SkeletonRows count={6} />;
  const people = q.data.people;
  const placed = people.filter((p) => p.performance && p.potential);
  const missing = people.filter((p) => !p.performance || !p.potential);
  const cell = (pot: number, perf: number) => placed.filter((p) => p.potential === pot && p.performance === perf);

  return (
    <div className="space-y-4">
      {people.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState icon={Store} title="Nobody to place yet" description="The 9-box fills in as reviews are shared and potential is rated here." />
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="flex gap-3">
            <div className="hidden w-6 items-center justify-center sm:flex" aria-hidden="true">
              <span className="-rotate-90 whitespace-nowrap text-2xs uppercase tracking-wider text-ink-muted">Potential →</span>
            </div>
            <div className="flex-1">
              <div role="grid" aria-label="9-box: potential by performance" className="grid grid-cols-3 gap-2">
                {[3, 2, 1].map((pot) =>
                  [1, 2, 3].map((perf) => {
                    const here = cell(pot, perf);
                    return (
                      <div
                        key={`${pot}-${perf}`}
                        role="gridcell"
                        aria-label={`${CELL_NAME[`${pot}-${perf}`]}: ${POT_LABEL[pot]}, ${PERF_LABEL[perf]} — ${here.length} people`}
                        className={cn(
                          'min-h-[7rem] rounded-lg border p-2',
                          pot + perf >= 5 ? 'border-success/40 bg-success/5' : pot + perf <= 3 ? 'border-alert/30 bg-alert/5' : 'border-line bg-surface',
                        )}
                      >
                        <div className="mb-1 flex items-baseline justify-between gap-1">
                          <span className="text-xs font-medium text-ink">{CELL_NAME[`${pot}-${perf}`]}</span>
                          <span className="text-2xs tabular-nums text-ink-muted">{here.length}</span>
                        </div>
                        <ul className="flex flex-wrap gap-1">
                          {here.slice(0, 12).map((p) => (
                            <li key={p.associateId} title={p.name}>
                              <button type="button" onClick={() => canManage && setRating(p)} className="rounded-full" aria-label={canManage ? `Rate ${p.name}’s potential` : p.name} disabled={!canManage}>
                                <Avatar src={p.photoUrl} name={p.name} size="xs" />
                              </button>
                            </li>
                          ))}
                          {here.length > 12 && <li className="text-2xs text-ink-muted">+{here.length - 12}</li>}
                        </ul>
                      </div>
                    );
                  }),
                )}
              </div>
              <div className="mt-1 text-center text-2xs uppercase tracking-wider text-ink-muted" aria-hidden="true">
                Performance (latest review) →
              </div>
            </div>
          </div>
          {missing.length > 0 && (
            <section aria-labelledby="nb-missing" className="space-y-2">
              <SectionTitle as="h3" id="nb-missing" title={`Not on the grid yet (${missing.length})`} />
              <ul className="divide-y divide-line rounded-lg border border-line">
                {missing.map((p) => (
                  <li key={p.associateId} className="flex flex-wrap items-center gap-3 px-3 py-2">
                    <Avatar src={p.photoUrl} name={p.name} size="xs" />
                    <AssociateLink associateId={p.associateId} className="min-w-0 flex-1 truncate text-sm text-ink">
                      {p.name}
                    </AssociateLink>
                    <span className="text-xs text-ink-muted">
                      {!p.performance ? 'No shared review' : `Review ${p.reviewRating} of 5`} · {p.potential ? POT_LABEL[p.potential] : 'Potential not rated'}
                    </span>
                    {canManage && !p.potential && (
                      <Button size="sm" variant="outline" onClick={() => setRating(p)}>
                        Rate potential
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
      <RatePotentialDialog
        person={rating}
        onClose={() => setRating(null)}
        onDone={() => void qc.invalidateQueries({ queryKey: ['succession', 'nine-box'] })}
      />
    </div>
  );
}

function RatePotentialDialog({ person, onClose, onDone }: { person: NineBoxPerson | null; onClose: () => void; onDone: () => void }) {
  const [value, setValue] = useState<number>(2);
  const save = useMutation({
    mutationFn: () => ratePotential(person!.associateId, { potential: value }),
    onSuccess: () => {
      toast.success(`Potential saved for ${person!.name}.`);
      onDone();
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not save.'),
  });
  return (
    <Dialog open={!!person} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{person?.name}’s potential</DialogTitle>
          <DialogDescription>How far could they grow from here? Performance comes from their latest shared review.</DialogDescription>
        </DialogHeader>
        <fieldset>
          <legend className="sr-only">Potential</legend>
          <div className="flex flex-wrap gap-2">
            {[1, 2, 3].map((n) => (
              <FilterChip key={n} active={value === n} onClick={() => setValue(n)}>
                {POT_LABEL[n]}
              </FilterChip>
            ))}
          </div>
        </fieldset>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
