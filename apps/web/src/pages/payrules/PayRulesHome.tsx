import { useEffect, useMemo, useState } from 'react';
import { Download, Plus } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { useConfirm } from '@/lib/confirm';
import { downloadCsv } from '@/lib/csv';
import {
  fmtDate,
  fmtMoney,
  localInputToUtcIso,
  parseYmd,
  ymdLocal,
} from '@/lib/format';
import { useClients } from '@/lib/useClients';
import { useAuth } from '@/lib/auth';
import {
  addAllocation,
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
  updateProject,
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
  Select,
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
import { AssociatePicker, type PickedAssociate } from '@/components/ui/AssociatePicker';
import { Label } from '@/components/ui/Label';
import { toast } from 'sonner';

type Tab = 'projects' | 'premium' | 'tips';

export function PayRulesHome() {
  const { user } = useAuth();
  // Client-bound roles (SHIFT_SUPERVISOR) can't list clients — /clients
  // 403s for them. Seed and pin the picker to their one client instead.
  const boundedClient = useMemo(
    () =>
      user?.clientId
        ? { id: user.clientId, name: user.clientName ?? 'Your client' }
        : null,
    [user?.clientId, user?.clientName],
  );
  // Shared react-query cache; the fetch is skipped entirely for bounded roles.
  const { clients: fetchedClients } = useClients({ enabled: !boundedClient });
  const clients = useMemo(
    () => (boundedClient ? [boundedClient] : fetchedClients),
    [boundedClient, fetchedClients],
  );
  const [clientId, setClientId] = useState(boundedClient?.id ?? '');
  const [tab, setTab] = useState<Tab>('projects');

  useEffect(() => {
    if (clients.length > 0) setClientId((prev) => prev || clients[0].id);
  }, [clients]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Pay rules"
        subtitle="Project codes, premium-pay differentials (OT, night, holiday), and tip pools."
        breadcrumbs={[{ label: 'Time & Pay' }, { label: 'Pay rules' }]}
      />
      <Card>
        <CardContent className="p-4 flex items-center gap-3 flex-wrap">
          <label
            htmlFor="payrules-client"
            className="text-[11px] uppercase tracking-wider text-silver"
          >
            Client
          </label>
          {boundedClient ? (
            // Client-bound role — the client is fixed, not a choice.
            <div
              id="payrules-client"
              className="inline-flex h-8 items-center rounded-md border border-navy-secondary bg-navy-secondary/20 px-2.5 text-sm text-white"
              title="Your account is scoped to this client"
            >
              {boundedClient.name}
            </div>
          ) : (
            <Select
              id="payrules-client"
              size="sm"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
            >
              {clients.length === 0 && <option value="">—</option>}
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
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
  const confirm = useConfirm();
  const [rows, setRows] = useState<Project[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [editTarget, setEditTarget] = useState<Project | null>(null);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [isBillable, setIsBillable] = useState(true);

  const refresh = () => {
    setRows(null);
    setLoadError(null);
    listProjects(clientId)
      .then((r) => setRows(r.projects))
      .catch(() => setLoadError('Failed to load projects.'));
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
      await createProject({
        clientId,
        code: code.trim(),
        name: name.trim(),
        isBillable,
      });
      toast.success('Project created.');
      setShowNew(false);
      setCode('');
      setName('');
      setIsBillable(true);
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    }
  };

  const onDeactivate = async (id: string) => {
    if (!(await confirm({ title: 'Deactivate this project?', destructive: true }))) return;
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
          {loadError ? (
            <div className="p-6 space-y-3">
              <p role="alert" className="text-sm text-alert">{loadError}</p>
              <Button size="sm" variant="secondary" onClick={refresh}>
                Retry
              </Button>
            </div>
          ) : rows === null ? (
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
                  <TableRow
                    key={p.id}
                    className="cursor-pointer"
                    onClick={() => setEditTarget(p)}
                  >
                    <TableCell className="font-mono text-xs">{p.code}</TableCell>
                    <TableCell className="text-white">{p.name}</TableCell>
                    <TableCell>{p.isBillable ? 'Yes' : 'No'}</TableCell>
                    <TableCell>
                      <Badge variant={p.isActive ? 'success' : 'default'}>
                        {p.isActive ? 'Active' : 'Inactive'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                      <Button size="sm" variant="ghost" onClick={() => setEditTarget(p)}>
                        Edit
                      </Button>
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
          <label className="flex items-center gap-2 text-sm text-white">
            <input
              type="checkbox"
              checked={isBillable}
              onChange={(e) => setIsBillable(e.target.checked)}
            />
            Billable to the client
          </label>
        </DrawerBody>
        <DrawerFooter>
          <Button variant="ghost" onClick={() => setShowNew(false)}>
            Cancel
          </Button>
          <Button onClick={onCreate}>Create</Button>
        </DrawerFooter>
      </Drawer>
      {editTarget && (
        <EditProjectDrawer
          project={editTarget}
          onClose={() => setEditTarget(null)}
          onSaved={() => {
            setEditTarget(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function EditProjectDrawer({
  project,
  onClose,
  onSaved,
}: {
  project: Project;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [code, setCode] = useState(project.code);
  const [name, setName] = useState(project.name);
  const [isBillable, setIsBillable] = useState(project.isBillable);
  const [saving, setSaving] = useState(false);

  const onSubmit = async () => {
    if (!code.trim() || !name.trim()) {
      toast.error('Code and name required.');
      return;
    }
    setSaving(true);
    try {
      await updateProject(project.id, {
        code: code.trim(),
        name: name.trim(),
        isBillable,
      });
      toast.success('Project updated.');
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
        <DrawerTitle>Edit project</DrawerTitle>
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
        <label className="flex items-center gap-2 text-sm text-white">
          <input
            type="checkbox"
            checked={isBillable}
            onChange={(e) => setIsBillable(e.target.checked)}
          />
          Billable to the client
        </label>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={onSubmit} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </DrawerFooter>
    </Drawer>
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
  const confirm = useConfirm();
  const [rows, setRows] = useState<PremiumPayRule[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  const refresh = () => {
    setRows(null);
    setLoadError(null);
    listPremiumPayRules(clientId)
      .then((r) => setRows(r.rules))
      .catch(() => setLoadError('Failed to load premium pay rules.'));
  };
  useEffect(() => {
    refresh();
  }, [clientId]);

  const onDelete = async (id: string) => {
    if (!(await confirm({ title: 'Deactivate this rule?', destructive: true }))) return;
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
          {loadError ? (
            <div className="p-6 space-y-3">
              <p role="alert" className="text-sm text-alert">{loadError}</p>
              <Button size="sm" variant="secondary" onClick={refresh}>
                Retry
              </Button>
            </div>
          ) : rows === null ? (
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
                    <TableCell>{r.addPerHour ? fmtMoney(r.addPerHour) : '—'}</TableCell>
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

  // Live worked example so the admin can sanity-check the rule before
  // saving: base $18/hr → multiplier × base + flat add-on.
  const exampleBase = 18;
  const multNum = multiplier !== '' ? Number(multiplier) : null;
  const addNum = addPerHour !== '' ? Number(addPerHour) : null;
  const multOk = multNum !== null && Number.isFinite(multNum) && multNum > 0;
  const addOk = addNum !== null && Number.isFinite(addNum) && addNum >= 0;
  const examplePay =
    multOk || addOk
      ? exampleBase * (multOk ? multNum : 1) + (addOk ? addNum : 0)
      : null;

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
          <Select
            className="mt-1"
            value={kind}
            onChange={(e) => setKind(e.target.value as PremiumPayKind)}
          >
            {(Object.keys(KIND_LABEL) as PremiumPayKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </Select>
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
        {examplePay !== null && (
          <div className="text-xs text-silver bg-navy-secondary/40 border border-navy-secondary rounded-md p-3">
            Example: at a {fmtMoney(exampleBase)}/hr base this rule pays{' '}
            <span className="text-white font-medium">{fmtMoney(examplePay)}/hr</span>.
          </div>
        )}
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [active, setActive] = useState<TipPool | null>(null);

  const refresh = () => {
    setRows(null);
    setLoadError(null);
    listTipPools(clientId)
      .then((r) => setRows(r.pools))
      .catch(() => setLoadError('Failed to load tip pools.'));
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
          {loadError ? (
            <div className="p-6 space-y-3">
              <p role="alert" className="text-sm text-alert">{loadError}</p>
              <Button size="sm" variant="secondary" onClick={refresh}>
                Retry
              </Button>
            </div>
          ) : rows === null ? (
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
                    <TableCell>{fmtDate(parseYmd(p.shiftDate))}</TableCell>
                    <TableCell className="text-white">{p.name}</TableCell>
                    <TableCell>{fmtMoney(p.totalAmount, { currency: p.currency })}</TableCell>
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
  // Tip pools are usually reconciled the morning after the shift, so
  // default to yesterday's date.
  const [shiftDate, setShiftDate] = useState(() =>
    ymdLocal(new Date(Date.now() - 86_400_000)),
  );
  const [total, setTotal] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const onSubmit = async () => {
    setError(null);
    if (!name.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(shiftDate)) {
      setError('Name and shift date are required.');
      return;
    }
    const t = Number(total);
    if (!Number.isFinite(t) || t <= 0) {
      setError('Tip pool total must be greater than $0.');
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
            type="date"
            className="mt-1"
            value={shiftDate}
            onChange={(e) => setShiftDate(e.target.value)}
          />
        </div>
        <div>
          <Label>Total $</Label>
          <Input
            className="mt-1"
            type="number"
            step="0.01"
            min="0.01"
            value={total}
            onChange={(e) => setTotal(e.target.value)}
          />
        </div>
        {error && (
          <p role="alert" className="text-sm text-alert">
            {error}
          </p>
        )}
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
  const confirm = useConfirm();
  const [allocations, setAllocations] = useState<TipAllocation[] | null>(null);
  const [allocError, setAllocError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // datetime-local wall-clock values; converted to UTC ISO on submit.
  const [from, setFrom] = useState(`${pool.shiftDate}T00:00`);
  const [to, setTo] = useState(`${pool.shiftDate}T23:59`);
  const [manualAssociate, setManualAssociate] = useState<PickedAssociate | null>(null);
  const [manualAmount, setManualAmount] = useState('');

  const refresh = () => {
    setAllocations(null);
    setAllocError(null);
    listAllocations(pool.id)
      .then((r) => setAllocations(r.allocations))
      .catch(() => setAllocError('Failed to load allocations.'));
  };
  useEffect(() => {
    refresh();
  }, [pool.id]);

  const headcount = allocations?.length ?? 0;
  const allocatedTotal = (allocations ?? []).reduce(
    (s, a) => s + Number(a.amount),
    0,
  );
  const remainder = Number(pool.totalAmount) - allocatedTotal;
  const remainderNonZero = Math.abs(remainder) >= 0.005;

  const onAuto = async () => {
    if (!from || !to) {
      toast.error('From and to times are required.');
      return;
    }
    setBusy(true);
    try {
      const r = await autoAllocate(pool.id, {
        from: localInputToUtcIso(from),
        to: localInputToUtcIso(to),
      });
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

  const onAddManual = async () => {
    if (!manualAssociate) {
      toast.error('Pick an associate.');
      return;
    }
    const amt = Number(manualAmount);
    if (!Number.isFinite(amt) || amt <= 0) {
      toast.error('Amount must be greater than $0.');
      return;
    }
    setBusy(true);
    try {
      await addAllocation(pool.id, {
        associateId: manualAssociate.id,
        amount: amt,
      });
      toast.success('Allocation added.');
      setManualAssociate(null);
      setManualAmount('');
      onChanged();
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setBusy(false);
    }
  };

  const onClose_ = async () => {
    const ok = await confirm({
      title: 'Close this tip pool?',
      description: `This locks ${fmtMoney(pool.totalAmount, {
        currency: pool.currency,
      })} allocated across ${headcount} associate${headcount === 1 ? '' : 's'}. Allocations can no longer be changed after closing.`,
      confirmLabel: 'Close pool',
      destructive: true,
    });
    if (!ok) return;
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
    const ok = await confirm({
      title: 'Pay out this tip pool?',
      description: `This pays out ${fmtMoney(pool.totalAmount, {
        currency: pool.currency,
      })} to ${headcount} associate${headcount === 1 ? '' : 's'}. This cannot be undone.`,
      confirmLabel: 'Pay out',
      destructive: true,
    });
    if (!ok) return;
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

  const onExportCsv = () => {
    downloadCsv(`tip-pool-${pool.shiftDate}-allocations.csv`, [
      ['Associate', 'Hours', 'Share %', 'Amount'],
      ...(allocations ?? []).map((a) => [
        a.associateName,
        a.hoursWorked,
        a.sharePct ?? '',
        Number(a.amount).toFixed(2),
      ]),
      ['Total allocated', '', '', allocatedTotal.toFixed(2)],
      ['Unallocated remainder', '', '', remainder.toFixed(2)],
    ]);
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()} width="max-w-2xl">
      <DrawerHeader>
        <DrawerTitle>{pool.name}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div className="text-sm text-silver">
          {fmtDate(parseYmd(pool.shiftDate))} •{' '}
          <span className="text-white">
            {fmtMoney(pool.totalAmount, { currency: pool.currency })}
          </span>{' '}
          • status: <span className="text-white">{pool.status}</span>
        </div>
        {pool.status === 'OPEN' && (
          <Card>
            <CardContent className="p-4 space-y-3">
              <div className="text-sm text-white font-medium">
                Auto-allocate by hours worked
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>From</Label>
                  <Input
                    type="datetime-local"
                    className="mt-1 text-xs"
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                  />
                </div>
                <div>
                  <Label>To</Label>
                  <Input
                    type="datetime-local"
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
        {pool.status === 'OPEN' && (
          <Card>
            <CardContent className="p-4 space-y-3">
              <div className="text-sm text-white font-medium">
                Add manual allocation
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Associate</Label>
                  <div className="mt-1">
                    <AssociatePicker
                      value={manualAssociate}
                      onChange={setManualAssociate}
                    />
                  </div>
                </div>
                <div>
                  <Label>Amount ($)</Label>
                  <Input
                    type="number"
                    step="0.01"
                    min="0.01"
                    className="mt-1"
                    value={manualAmount}
                    onChange={(e) => setManualAmount(e.target.value)}
                  />
                </div>
              </div>
              <Button variant="secondary" onClick={onAddManual} disabled={busy}>
                Add allocation
              </Button>
            </CardContent>
          </Card>
        )}
        {allocError ? (
          <div className="space-y-3">
            <p role="alert" className="text-sm text-alert">{allocError}</p>
            <Button size="sm" variant="secondary" onClick={refresh}>
              Retry
            </Button>
          </div>
        ) : allocations === null ? (
          <SkeletonRows count={3} />
        ) : allocations.length === 0 ? (
          <EmptyState
            title="No allocations yet"
            description={
              pool.status === 'OPEN'
                ? 'Auto-allocate by hours worked above, or add an allocation manually.'
                : 'This pool was closed without any allocations.'
            }
          />
        ) : (
          <div className="space-y-2">
            <div className="flex justify-end">
              <Button size="sm" variant="secondary" onClick={onExportCsv}>
                <Download className="mr-2 h-4 w-4" /> Export CSV
              </Button>
            </div>
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
                    <TableCell>
                      {fmtMoney(a.amount, { currency: pool.currency })}
                    </TableCell>
                  </TableRow>
                ))}
                <TableRow>
                  <TableCell className="font-medium text-white">
                    Total allocated ({headcount})
                  </TableCell>
                  <TableCell />
                  <TableCell />
                  <TableCell className="font-medium text-white">
                    {fmtMoney(allocatedTotal, { currency: pool.currency })}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell
                    className={remainderNonZero ? 'text-alert' : 'text-silver'}
                  >
                    Unallocated remainder
                  </TableCell>
                  <TableCell />
                  <TableCell />
                  <TableCell
                    className={
                      remainderNonZero ? 'text-alert font-medium' : 'text-silver'
                    }
                  >
                    {fmtMoney(remainder, { currency: pool.currency })}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
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
