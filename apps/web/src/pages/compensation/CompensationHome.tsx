import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { listClients } from '@/lib/clientsApi';
import type { ClientListItem } from '@alto-people/shared';
import {
  applyCycle,
  createBand,
  createCycle,
  deleteBand,
  listBands,
  listCycles,
  listProposals,
  seedCycle,
  updateBand,
  updateProposal,
  type CompBand,
  type MeritCycle,
  type MeritProposal,
  type MeritProposalStatus,
  type PayType,
} from '@/lib/compApi';
import { useAuth } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import { hasCapability } from '@/lib/roles';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Drawer,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  EmptyState,
  Input,
  PageHeader,
  SkeletonRows,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui';
import { Label } from '@/components/ui/Label';
import { toast } from 'sonner';

type Tab = 'bands' | 'cycles';

export function CompensationHome() {
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:comp') : false;

  const [clients, setClients] = useState<ClientListItem[]>([]);
  const [clientId, setClientId] = useState<string>('');
  const [tab, setTab] = useState<Tab>('bands');

  useEffect(() => {
    listClients()
      .then((res) => {
        setClients(res.clients);
        if (!clientId && res.clients.length > 0) {
          setClientId(res.clients[0].id);
        }
      })
      .catch(() => {});
  }, [clientId]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Compensation"
        subtitle="Pay bands tied to job profiles, effective-dated history, and merit-cycle planning."
        breadcrumbs={[{ label: 'Time & Pay' }, { label: 'Compensation' }]}
      />

      <Card>
        <CardContent className="p-4 flex items-center gap-3 flex-wrap">
          <span className="text-[11px] uppercase tracking-wider text-silver">
            Client
          </span>
          <select
            className="flex h-9 rounded-md border border-navy-secondary bg-navy-secondary/40 px-3 text-sm text-white"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
          >
            {clients.length === 0 && <option value="">—</option>}
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </CardContent>
      </Card>

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="bands">Pay bands</TabsTrigger>
          <TabsTrigger value="cycles">Merit cycles</TabsTrigger>
        </TabsList>

        <TabsContent value="bands">
          {clientId ? (
            <BandsTab clientId={clientId} canManage={canManage} />
          ) : (
            <Card>
              <CardContent className="p-6 text-sm text-silver">
                Choose a client to view its pay bands.
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="cycles">
          {clientId ? (
            <CyclesTab clientId={clientId} canManage={canManage} />
          ) : (
            <Card>
              <CardContent className="p-6 text-sm text-silver">
                Choose a client to view its merit cycles.
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ============ Bands ============

type BandDraft = {
  id?: string;
  name: string;
  level: string;
  payType: PayType;
  minAmount: string;
  midAmount: string;
  maxAmount: string;
};

function BandsTab({ clientId, canManage }: { clientId: string; canManage: boolean }) {
  const confirm = useConfirm();
  const [rows, setRows] = useState<CompBand[] | null>(null);
  const [draft, setDraft] = useState<BandDraft | null>(null);

  const refresh = async () => {
    setRows(null);
    try {
      const r = await listBands(clientId);
      setRows(r.bands);
    } catch {
      setRows([]);
    }
  };
  useEffect(() => {
    refresh();
  }, [clientId]);

  const onDelete = async (id: string) => {
    if (!(await confirm({ title: 'Delete this pay band?', destructive: true }))) return;
    try {
      await deleteBand(id);
      toast.success('Band deleted.');
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    }
  };

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="flex justify-end">
          <Button
            onClick={() =>
              setDraft({
                name: '',
                level: '',
                payType: 'HOURLY',
                minAmount: '',
                midAmount: '',
                maxAmount: '',
              })
            }
          >
            <Plus className="mr-2 h-4 w-4" /> New band
          </Button>
        </div>
      )}
      <Card>
        <CardContent className="p-0">
          {rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              title="No pay bands"
              description="Define minimum / midpoint / maximum pay for each role so HR can see where in band each associate sits."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Job profile</TableHead>
                  <TableHead>Level</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Range</TableHead>
                  <TableHead className="w-32 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((b) => (
                  <TableRow
                    key={b.id}
                    className="group cursor-pointer"
                    onClick={() => {
                      if (!canManage) return;
                      setDraft({
                        id: b.id,
                        name: b.name,
                        level: b.level ?? '',
                        payType: b.payType,
                        minAmount: b.minAmount,
                        midAmount: b.midAmount,
                        maxAmount: b.maxAmount,
                      });
                    }}
                  >
                    <TableCell className="font-medium text-white">{b.name}</TableCell>
                    <TableCell>{b.jobProfileTitle ?? '—'}</TableCell>
                    <TableCell>{b.level ?? '—'}</TableCell>
                    <TableCell>{b.payType}</TableCell>
                    <TableCell>
                      ${b.minAmount} / ${b.midAmount} / ${b.maxAmount}
                    </TableCell>
                    <TableCell className="text-right">
                      {canManage && (
                        <button
                          data-no-row-click
                          onClick={(e) => {
                            e.stopPropagation();
                            onDelete(b.id);
                          }}
                          className="opacity-0 group-hover:opacity-100 text-silver hover:text-alert transition"
                        >
                          <Trash2 className="h-4 w-4 inline" />
                        </button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <Drawer open={draft !== null} onOpenChange={(o) => !o && setDraft(null)}>
        {draft && (
          <BandDrawer
            clientId={clientId}
            draft={draft}
            setDraft={setDraft}
            onClose={() => setDraft(null)}
            onSaved={() => {
              setDraft(null);
              refresh();
            }}
          />
        )}
      </Drawer>
    </div>
  );
}

function BandDrawer({
  clientId,
  draft,
  setDraft,
  onClose,
  onSaved,
}: {
  clientId: string;
  draft: BandDraft;
  setDraft: (d: BandDraft) => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const onSubmit = async () => {
    if (!draft.name.trim()) {
      toast.error('Name required.');
      return;
    }
    const min = Number(draft.minAmount);
    const mid = Number(draft.midAmount);
    const max = Number(draft.maxAmount);
    if (!(min > 0 && mid > 0 && max > 0)) {
      toast.error('All amounts must be positive.');
      return;
    }
    if (!(min <= mid && mid <= max)) {
      toast.error('min ≤ mid ≤ max required.');
      return;
    }
    setSaving(true);
    try {
      const body = {
        clientId,
        name: draft.name.trim(),
        level: draft.level.trim() || null,
        payType: draft.payType,
        minAmount: min,
        midAmount: mid,
        maxAmount: max,
      };
      if (draft.id) await updateBand(draft.id, body);
      else await createBand(body);
      toast.success(draft.id ? 'Band updated.' : 'Band created.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <DrawerHeader>
        <DrawerTitle>{draft.id ? 'Edit band' : 'New band'}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Name</Label>
          <Input
            className="mt-1"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </div>
        <div>
          <Label>Level</Label>
          <Input
            className="mt-1"
            value={draft.level}
            onChange={(e) => setDraft({ ...draft, level: e.target.value })}
            placeholder="L3, IC4, Senior, …"
          />
        </div>
        <div>
          <Label>Pay type</Label>
          <select
            className="mt-1 flex h-10 w-full rounded-md border border-navy-secondary bg-navy-secondary/40 px-3 text-sm text-white"
            value={draft.payType}
            onChange={(e) =>
              setDraft({ ...draft, payType: e.target.value as PayType })
            }
          >
            <option value="HOURLY">Hourly</option>
            <option value="SALARY">Salary</option>
          </select>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <Label>Min</Label>
            <Input
              className="mt-1"
              type="number"
              value={draft.minAmount}
              onChange={(e) => setDraft({ ...draft, minAmount: e.target.value })}
            />
          </div>
          <div>
            <Label>Mid</Label>
            <Input
              className="mt-1"
              type="number"
              value={draft.midAmount}
              onChange={(e) => setDraft({ ...draft, midAmount: e.target.value })}
            />
          </div>
          <div>
            <Label>Max</Label>
            <Input
              className="mt-1"
              type="number"
              value={draft.maxAmount}
              onChange={(e) => setDraft({ ...draft, maxAmount: e.target.value })}
            />
          </div>
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={onSubmit} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </DrawerFooter>
    </>
  );
}

// ============ Cycles ============

function CyclesTab({ clientId, canManage }: { clientId: string; canManage: boolean }) {
  const [cycles, setCycles] = useState<MeritCycle[] | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [active, setActive] = useState<MeritCycle | null>(null);

  const refresh = async () => {
    setCycles(null);
    try {
      const r = await listCycles(clientId);
      setCycles(r.cycles);
    } catch {
      setCycles([]);
    }
  };
  useEffect(() => {
    refresh();
  }, [clientId]);

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="flex justify-end">
          <Button onClick={() => setShowNew(true)}>
            <Plus className="mr-2 h-4 w-4" /> New cycle
          </Button>
        </div>
      )}
      <Card>
        <CardContent className="p-0">
          {cycles === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : cycles.length === 0 ? (
            <EmptyState
              title="No merit cycles"
              description="Create a merit cycle to plan and apply pay changes for an entire population at once."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead>Effective</TableHead>
                  <TableHead>Budget</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {cycles.map((c) => (
                  <TableRow
                    key={c.id}
                    className="cursor-pointer"
                    onClick={() => setActive(c)}
                  >
                    <TableCell className="font-medium text-white">{c.name}</TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          c.status === 'APPLIED' || c.status === 'CLOSED'
                            ? 'success'
                            : c.status === 'OPEN'
                              ? 'pending'
                              : 'default'
                        }
                      >
                        {c.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {c.reviewPeriodStart} – {c.reviewPeriodEnd}
                    </TableCell>
                    <TableCell>{c.effectiveDate}</TableCell>
                    <TableCell>{c.budget ? `$${c.budget}` : '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {showNew && (
        <NewCycleDrawer
          clientId={clientId}
          onClose={() => setShowNew(false)}
          onSaved={() => {
            setShowNew(false);
            refresh();
          }}
        />
      )}
      {active && (
        <CycleDetailDrawer
          cycle={active}
          canManage={canManage}
          onClose={() => setActive(null)}
          onChanged={refresh}
        />
      )}
    </div>
  );
}

function NewCycleDrawer({
  clientId,
  onClose,
  onSaved,
}: {
  clientId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [eff, setEff] = useState('');
  const [budget, setBudget] = useState('');
  const [saving, setSaving] = useState(false);

  const onSubmit = async () => {
    if (!name.trim()) {
      toast.error('Name required.');
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || !/^\d{4}-\d{2}-\d{2}$/.test(eff)) {
      toast.error('Dates must be YYYY-MM-DD.');
      return;
    }
    setSaving(true);
    try {
      await createCycle({
        clientId,
        name: name.trim(),
        reviewPeriodStart: start,
        reviewPeriodEnd: end,
        effectiveDate: eff,
        budget: budget ? Number(budget) : undefined,
      });
      toast.success('Cycle created.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>New merit cycle</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Name</Label>
          <Input className="mt-1" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Period start</Label>
            <Input
              className="mt-1"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              placeholder="2026-01-01"
            />
          </div>
          <div>
            <Label>Period end</Label>
            <Input
              className="mt-1"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              placeholder="2026-12-31"
            />
          </div>
        </div>
        <div>
          <Label>Effective date</Label>
          <Input
            className="mt-1"
            value={eff}
            onChange={(e) => setEff(e.target.value)}
            placeholder="2027-01-01"
          />
        </div>
        <div>
          <Label>Budget (optional)</Label>
          <Input
            className="mt-1"
            type="number"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
          />
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={onSubmit} disabled={saving}>
          {saving ? 'Saving…' : 'Create'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

function CycleDetailDrawer({
  cycle,
  canManage,
  onClose,
  onChanged,
}: {
  cycle: MeritCycle;
  canManage: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const confirm = useConfirm();
  const [proposals, setProposals] = useState<MeritProposal[] | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    setProposals(null);
    try {
      const r = await listProposals(cycle.id);
      setProposals(r.proposals);
    } catch {
      setProposals([]);
    }
  };
  useEffect(() => {
    refresh();
  }, [cycle.id]);

  const totalProposed = useMemo(() => {
    if (!proposals) return 0;
    return proposals
      .filter((p) => p.status === 'APPROVED')
      .reduce(
        (sum, p) => sum + (Number(p.proposedAmount) - Number(p.currentAmount)),
        0,
      );
  }, [proposals]);

  const onSeed = async () => {
    setBusy(true);
    try {
      const r = await seedCycle(cycle.id);
      toast.success(`Created ${r.created} proposals (${r.total} eligible).`);
      onChanged();
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setBusy(false);
    }
  };

  const onApply = async () => {
    if (!(await confirm({ title: `Apply ${cycle.name}?`, description: `Approved proposals become effective ${cycle.effectiveDate}.` }))) {
      return;
    }
    setBusy(true);
    try {
      const r = await applyCycle(cycle.id);
      toast.success(`Applied ${r.applied}; ${r.stale} bounced for re-review.`);
      onChanged();
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setBusy(false);
    }
  };

  const onDecide = async (p: MeritProposal, status: MeritProposalStatus) => {
    if (status !== 'APPROVED' && status !== 'REJECTED') return;
    try {
      await updateProposal(cycle.id, p.id, { status });
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    }
  };

  const onEditProposed = async (p: MeritProposal, value: string) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return;
    try {
      await updateProposal(cycle.id, p.id, { proposedAmount: n });
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    }
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()} width="max-w-3xl">
      <DrawerHeader>
        <DrawerTitle>{cycle.name}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div className="text-sm text-silver flex flex-wrap gap-4">
          <span>Status: <span className="text-white">{cycle.status}</span></span>
          <span>Effective: <span className="text-white">{cycle.effectiveDate}</span></span>
          {cycle.budget && (
            <span>
              Budget: <span className="text-white">${cycle.budget}</span>
            </span>
          )}
          <span>
            Approved Δ:{' '}
            <span className={totalProposed >= 0 ? 'text-emerald-400' : 'text-alert'}>
              ${totalProposed.toFixed(2)}
            </span>
          </span>
        </div>
        {canManage && (cycle.status === 'DRAFT' || cycle.status === 'OPEN') && (
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onSeed} disabled={busy}>
              Seed proposals
            </Button>
            {cycle.status === 'OPEN' && (
              <Button onClick={onApply} disabled={busy}>
                Apply cycle
              </Button>
            )}
          </div>
        )}

        {proposals === null ? (
          <SkeletonRows count={4} />
        ) : proposals.length === 0 ? (
          <EmptyState
            title="No proposals yet"
            description="Click “Seed proposals” to auto-create a row for every active associate."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Associate</TableHead>
                <TableHead>Current</TableHead>
                <TableHead>Proposed</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right w-44">Decide</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {proposals.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-medium text-white">
                    {p.associateName}
                  </TableCell>
                  <TableCell>
                    ${p.currentAmount} <span className="text-silver text-xs">{p.currentPayType}</span>
                  </TableCell>
                  <TableCell>
                    {canManage && cycle.status === 'OPEN' && p.status !== 'APPLIED' ? (
                      <Input
                        className="w-28"
                        type="number"
                        defaultValue={p.proposedAmount}
                        onBlur={(e) => onEditProposed(p, e.target.value)}
                      />
                    ) : (
                      <>${p.proposedAmount}</>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        p.status === 'APPROVED' || p.status === 'APPLIED'
                          ? 'success'
                          : p.status === 'REJECTED'
                            ? 'destructive'
                            : 'pending'
                      }
                    >
                      {p.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {canManage && cycle.status === 'OPEN' && p.status !== 'APPLIED' && (
                      <div className="inline-flex gap-1">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => onDecide(p, 'APPROVED')}
                        >
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => onDecide(p, 'REJECTED')}
                        >
                          Reject
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}
