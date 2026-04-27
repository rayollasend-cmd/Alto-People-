import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { listClients } from '@/lib/clientsApi';
import type { ClientListItem } from '@alto-people/shared';
import {
  autoAllocate,
  closeTipPool,
  createPremiumPayRule,
  createProject,
  createTipPool,
  deactivateProject,
  deletePremiumPayRule,
  listAllocations,
  listPremiumPayRules,
  listProjects,
  listTipPools,
  payOutTipPool,
  type PremiumPayKind,
  type PremiumPayRule,
  type Project,
  type TipAllocation,
  type TipPool,
} from '@/lib/payRulesApi';
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

type Tab = 'projects' | 'premium' | 'tips';

export function PayRulesHome() {
  const [clients, setClients] = useState<ClientListItem[]>([]);
  const [clientId, setClientId] = useState('');
  const [tab, setTab] = useState<Tab>('projects');

  useEffect(() => {
    listClients()
      .then((r) => {
        setClients(r.clients);
        if (!clientId && r.clients.length > 0) setClientId(r.clients[0].id);
      })
      .catch(() => {});
  }, [clientId]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Pay rules"
        subtitle="Project codes, premium-pay differentials (OT, night, holiday), and tip pools."
        breadcrumbs={[{ label: 'Time & Pay' }, { label: 'Pay rules' }]}
      />
      <Card>
        <CardContent className="p-4 flex items-center gap-3 flex-wrap">
          <span className="text-[11px] uppercase tracking-wider text-silver">Client</span>
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
          <TabsTrigger value="projects">Projects</TabsTrigger>
          <TabsTrigger value="premium">Premium pay</TabsTrigger>
          <TabsTrigger value="tips">Tip pools</TabsTrigger>
        </TabsList>
        <TabsContent value="projects">
          {clientId && <ProjectsTab clientId={clientId} />}
        </TabsContent>
        <TabsContent value="premium">
          {clientId && <PremiumTab clientId={clientId} />}
        </TabsContent>
        <TabsContent value="tips">
          {clientId && <TipsTab clientId={clientId} />}
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ============ Projects ============

function ProjectsTab({ clientId }: { clientId: string }) {
  const [rows, setRows] = useState<Project[] | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');

  const refresh = () => {
    setRows(null);
    listProjects(clientId)
      .then((r) => setRows(r.projects))
      .catch(() => setRows([]));
  };
  useEffect(() => {
    refresh();
  }, [clientId]);

  const onCreate = async () => {
    if (!code.trim() || !name.trim()) {
      toast.error('Code and name required.');
      return;
    }
    try {
      await createProject({ clientId, code: code.trim(), name: name.trim() });
      toast.success('Project created.');
      setShowNew(false);
      setCode('');
      setName('');
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    }
  };

  const onDeactivate = async (id: string) => {
    if (!window.confirm('Deactivate this project?')) return;
    try {
      await deactivateProject(id);
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setShowNew(true)}>
          <Plus className="mr-2 h-4 w-4" /> New project
        </Button>
      </div>
      <Card>
        <CardContent className="p-0">
          {rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              title="No projects"
              description="Create projects to track time-by-project under each client."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Billable</TableHead>
                  <TableHead>Active</TableHead>
                  <TableHead className="w-32 text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-mono text-xs">{p.code}</TableCell>
                    <TableCell className="text-white">{p.name}</TableCell>
                    <TableCell>{p.isBillable ? 'Yes' : 'No'}</TableCell>
                    <TableCell>
                      <Badge variant={p.isActive ? 'success' : 'default'}>
                        {p.isActive ? 'Active' : 'Inactive'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {p.isActive && (
                        <Button size="sm" variant="ghost" onClick={() => onDeactivate(p.id)}>
                          Deactivate
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <Drawer open={showNew} onOpenChange={setShowNew}>
        <DrawerHeader>
          <DrawerTitle>New project</DrawerTitle>
        </DrawerHeader>
        <DrawerBody className="space-y-4">
          <div>
            <Label>Code</Label>
            <Input className="mt-1 font-mono" value={code} onChange={(e) => setCode(e.target.value)} />
          </div>
          <div>
            <Label>Name</Label>
            <Input className="mt-1" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        </DrawerBody>
        <DrawerFooter>
          <Button variant="ghost" onClick={() => setShowNew(false)}>
            Cancel
          </Button>
          <Button onClick={onCreate}>Create</Button>
        </DrawerFooter>
      </Drawer>
    </div>
  );
}

// ============ Premium pay ============

const KIND_LABEL: Record<PremiumPayKind, string> = {
  OVERTIME_DAILY: 'Daily overtime',
  OVERTIME_WEEKLY: 'Weekly overtime',
  NIGHT_DIFFERENTIAL: 'Night differential',
  WEEKEND_DIFFERENTIAL: 'Weekend differential',
  HOLIDAY: 'Holiday',
  SHIFT_DIFFERENTIAL: 'Shift differential',
  CALL_BACK: 'Call-back',
  ON_CALL: 'On-call',
};

function PremiumTab({ clientId }: { clientId: string }) {
  const [rows, setRows] = useState<PremiumPayRule[] | null>(null);
  const [showNew, setShowNew] = useState(false);

  const refresh = () => {
    setRows(null);
    listPremiumPayRules(clientId)
      .then((r) => setRows(r.rules))
      .catch(() => setRows([]));
  };
  useEffect(() => {
    refresh();
  }, [clientId]);

  const onDelete = async (id: string) => {
    if (!window.confirm('Deactivate this rule?')) return;
    try {
      await deletePremiumPayRule(id);
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setShowNew(true)}>
          <Plus className="mr-2 h-4 w-4" /> New rule
        </Button>
      </div>
      <Card>
        <CardContent className="p-0">
          {rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              title="No premium pay rules"
              description="Define overtime multipliers, night differentials, holiday pay, and other premium rules."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Multiplier</TableHead>
                  <TableHead>Add $/hr</TableHead>
                  <TableHead>Threshold</TableHead>
                  <TableHead>Active</TableHead>
                  <TableHead className="w-32 text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium text-white">{r.name}</TableCell>
                    <TableCell>{KIND_LABEL[r.kind] ?? r.kind}</TableCell>
                    <TableCell>{r.multiplier ? `×${r.multiplier}` : '—'}</TableCell>
                    <TableCell>{r.addPerHour ? `$${r.addPerHour}` : '—'}</TableCell>
                    <TableCell>{r.thresholdHours ? `${r.thresholdHours} hr` : '—'}</TableCell>
                    <TableCell>
                      <Badge variant={r.isActive ? 'success' : 'default'}>
                        {r.isActive ? 'Yes' : 'No'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {r.isActive && (
                        <Button size="sm" variant="ghost" onClick={() => onDelete(r.id)}>
                          Deactivate
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {showNew && (
        <PremiumDrawer
          clientId={clientId}
          onClose={() => setShowNew(false)}
          onSaved={() => {
            setShowNew(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function PremiumDrawer({
  clientId,
  onClose,
  onSaved,
}: {
  clientId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<PremiumPayKind>('OVERTIME_DAILY');
  const [multiplier, setMultiplier] = useState('1.5');
  const [addPerHour, setAddPerHour] = useState('');
  const [thresholdHours, setThresholdHours] = useState('8');
  const [saving, setSaving] = useState(false);

  const onSubmit = async () => {
    if (!name.trim()) {
      toast.error('Name required.');
      return;
    }
    const mult = multiplier ? Number(multiplier) : null;
    const add = addPerHour ? Number(addPerHour) : null;
    if (mult == null && add == null) {
      toast.error('Specify multiplier and/or $/hr.');
      return;
    }
    setSaving(true);
    try {
      await createPremiumPayRule({
        clientId,
        name: name.trim(),
        kind,
        multiplier: mult,
        addPerHour: add,
        thresholdHours: thresholdHours ? Number(thresholdHours) : null,
      });
      toast.success('Rule created.');
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
        <DrawerTitle>New premium pay rule</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Name</Label>
          <Input className="mt-1" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <Label>Kind</Label>
          <select
            className="mt-1 flex h-10 w-full rounded-md border border-navy-secondary bg-navy-secondary/40 px-3 text-sm text-white"
            value={kind}
            onChange={(e) => setKind(e.target.value as PremiumPayKind)}
          >
            {(Object.keys(KIND_LABEL) as PremiumPayKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Multiplier</Label>
            <Input
              className="mt-1"
              type="number"
              step="0.01"
              value={multiplier}
              onChange={(e) => setMultiplier(e.target.value)}
              placeholder="1.5"
            />
          </div>
          <div>
            <Label>Add $/hr</Label>
            <Input
              className="mt-1"
              type="number"
              step="0.01"
              value={addPerHour}
              onChange={(e) => setAddPerHour(e.target.value)}
              placeholder="2.00"
            />
          </div>
        </div>
        <div>
          <Label>Threshold hours (for OT kinds)</Label>
          <Input
            className="mt-1"
            type="number"
            value={thresholdHours}
            onChange={(e) => setThresholdHours(e.target.value)}
            placeholder="8"
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

// ============ Tip pools ============

function TipsTab({ clientId }: { clientId: string }) {
  const [rows, setRows] = useState<TipPool[] | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [active, setActive] = useState<TipPool | null>(null);

  const refresh = () => {
    setRows(null);
    listTipPools(clientId)
      .then((r) => setRows(r.pools))
      .catch(() => setRows([]));
  };
  useEffect(() => {
    refresh();
  }, [clientId]);

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setShowNew(true)}>
          <Plus className="mr-2 h-4 w-4" /> New tip pool
        </Button>
      </div>
      <Card>
        <CardContent className="p-0">
          {rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              title="No tip pools"
              description="Create a pool, sum tips, allocate by hours-worked or %, then close + pay out."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Total</TableHead>
                  <TableHead>Allocations</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((p) => (
                  <TableRow
                    key={p.id}
                    className="cursor-pointer"
                    onClick={() => setActive(p)}
                  >
                    <TableCell>{p.shiftDate}</TableCell>
                    <TableCell className="text-white">{p.name}</TableCell>
                    <TableCell>${p.totalAmount}</TableCell>
                    <TableCell>{p.allocationCount}</TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          p.status === 'PAID_OUT'
                            ? 'success'
                            : p.status === 'CLOSED'
                              ? 'pending'
                              : 'default'
                        }
                      >
                        {p.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {showNew && (
        <NewTipPoolDrawer
          clientId={clientId}
          onClose={() => setShowNew(false)}
          onSaved={() => {
            setShowNew(false);
            refresh();
          }}
        />
      )}
      {active && (
        <TipPoolDrawer
          pool={active}
          onClose={() => setActive(null)}
          onChanged={() => {
            refresh();
          }}
        />
      )}
    </div>
  );
}

function NewTipPoolDrawer({
  clientId,
  onClose,
  onSaved,
}: {
  clientId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState('');
  const [shiftDate, setShiftDate] = useState('');
  const [total, setTotal] = useState('');
  const [saving, setSaving] = useState(false);
  const onSubmit = async () => {
    if (!name.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(shiftDate)) {
      toast.error('Name and YYYY-MM-DD date required.');
      return;
    }
    const t = Number(total);
    if (!Number.isFinite(t) || t < 0) {
      toast.error('Total must be ≥ 0.');
      return;
    }
    setSaving(true);
    try {
      await createTipPool({
        clientId,
        name: name.trim(),
        shiftDate,
        totalAmount: t,
      });
      toast.success('Pool created.');
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
        <DrawerTitle>New tip pool</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Name</Label>
          <Input className="mt-1" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <Label>Shift date</Label>
          <Input
            className="mt-1"
            value={shiftDate}
            onChange={(e) => setShiftDate(e.target.value)}
            placeholder="2026-04-27"
          />
        </div>
        <div>
          <Label>Total $</Label>
          <Input
            className="mt-1"
            type="number"
            step="0.01"
            value={total}
            onChange={(e) => setTotal(e.target.value)}
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

function TipPoolDrawer({
  pool,
  onClose,
  onChanged,
}: {
  pool: TipPool;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [allocations, setAllocations] = useState<TipAllocation[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [from, setFrom] = useState(`${pool.shiftDate}T00:00:00.000Z`);
  const [to, setTo] = useState(`${pool.shiftDate}T23:59:59.000Z`);

  const refresh = () => {
    setAllocations(null);
    listAllocations(pool.id)
      .then((r) => setAllocations(r.allocations))
      .catch(() => setAllocations([]));
  };
  useEffect(() => {
    refresh();
  }, [pool.id]);

  const onAuto = async () => {
    setBusy(true);
    try {
      const r = await autoAllocate(pool.id, { from, to });
      toast.success(
        `Allocated to ${r.allocated} associates (${r.totalHours.toFixed(2)} hrs total).`,
      );
      onChanged();
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setBusy(false);
    }
  };

  const onClose_ = async () => {
    setBusy(true);
    try {
      await closeTipPool(pool.id);
      toast.success('Pool closed.');
      onChanged();
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setBusy(false);
    }
  };

  const onPayOut = async () => {
    setBusy(true);
    try {
      await payOutTipPool(pool.id);
      toast.success('Pool paid out.');
      onChanged();
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()} width="max-w-2xl">
      <DrawerHeader>
        <DrawerTitle>{pool.name}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div className="text-sm text-silver">
          {pool.shiftDate} • <span className="text-white">${pool.totalAmount}</span> •{' '}
          status: <span className="text-white">{pool.status}</span>
        </div>
        {pool.status === 'OPEN' && (
          <Card>
            <CardContent className="p-4 space-y-3">
              <div className="text-sm text-white font-medium">
                Auto-allocate by hours worked
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>From (ISO)</Label>
                  <Input
                    className="mt-1 text-xs"
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                  />
                </div>
                <div>
                  <Label>To (ISO)</Label>
                  <Input
                    className="mt-1 text-xs"
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                  />
                </div>
              </div>
              <Button onClick={onAuto} disabled={busy}>
                Auto-allocate
              </Button>
            </CardContent>
          </Card>
        )}
        {allocations === null ? (
          <SkeletonRows count={3} />
        ) : allocations.length === 0 ? (
          <EmptyState title="No allocations" description="Allocate by hours or add manually." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Associate</TableHead>
                <TableHead>Hours</TableHead>
                <TableHead>Share %</TableHead>
                <TableHead>Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {allocations.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="text-white">{a.associateName}</TableCell>
                  <TableCell>{a.hoursWorked}</TableCell>
                  <TableCell>{a.sharePct ? `${a.sharePct}%` : '—'}</TableCell>
                  <TableCell>${a.amount}</TableCell>
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
        {pool.status === 'OPEN' && (
          <Button variant="secondary" onClick={onClose_} disabled={busy}>
            Close pool
          </Button>
        )}
        {pool.status === 'CLOSED' && (
          <Button onClick={onPayOut} disabled={busy}>
            Pay out
          </Button>
        )}
      </DrawerFooter>
    </Drawer>
  );
}
