import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, Plus } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { errorText } from '@/lib/errorText';
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
import { useStoreScope } from '@/lib/storeScope';
import { useUrlParam } from '@/lib/useUrlState';
import { FilterBar } from '@/components/ui/FilterBar';
import { useAuth, useTenant, useTerm } from '@/lib/auth';
import { pickOne } from '@/lib/validationCopy';
import { boundedClientOf } from '@/lib/roles';
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
  payRulesSummary,
  updateProject,
  type PremiumPayKind,
  type PremiumPayRule,
  type Project,
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
  ErrorBanner,
  Input,
  Select,
  SkeletonRows,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui';
import { DataGrid } from '@/components/ui/DataGrid';
import { AssociatePicker, type PickedAssociate } from '@/components/ui/AssociatePicker';
import { Label } from '@/components/ui/Label';
import { ListTemplate } from '@/components/templates';
import { toast } from 'sonner';

type Tab = 'premium' | 'tips' | 'projects';
const TABS: Tab[] = ['premium', 'tips', 'projects'];

export function PayRulesHome() {
  const { user, can } = useAuth();
  const term = useTerm();
  // Client-bound roles (SHIFT_SUPERVISOR) can't list clients — /clients
  // 403s for them. Seed and pin the picker to their one client instead.
  const boundedClient = useMemo(() => boundedClientOf(user), [user]);
  // Shared react-query cache; the fetch is skipped entirely for bounded roles.
  const { clients: fetchedClients } = useClients({ enabled: !boundedClient });
  const clients = useMemo(
    () => (boundedClient ? [boundedClient] : fetchedClients),
    [boundedClient, fetchedClients],
  );
  // The client follows the top bar ("All clients" there = the cross-client
  // table here) until someone picks one on this page; 'all' is every client
  // on purpose. Tab and client are in the URL.
  const scope = useStoreScope();
  // Billing terms and a choice of clients are a staffing firm's; a hotel
  // has one book of rules, its own — no picker, no "all clients" table.
  const bills = useTenant().moduleOn('clientPortal');
  const seesAll = bills && can('process:payroll') && !boundedClient;
  const [clientParam, setClientParam] = useUrlParam<string>('client', '');
  const [tab, setTab] = useUrlParam<Tab>('tab', 'premium', TABS, { history: 'push' });
  const followed = clientParam === 'all' ? '' : clientParam || scope.clientId;
  const clientId = boundedClient?.id ?? (seesAll ? followed : followed || clients[0]?.id || '');
  const setClientId = (id: string) => setClientParam(id === '' ? (scope.clientId ? 'all' : '') : id === scope.clientId ? '' : id);
  const clientName = clients.find((c) => c.id === clientId)?.name ?? null;

  return (
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    <ListTemplate
        title="Pay rules"
        subtitle={`Premium pay (overtime, nights, holidays), tip pools and project codes — what people are paid on top of their rate.${bills ? ` What a ${term('label.client').toLowerCase()} is billed for it is its contract terms.` : ''}`}
        related={[
          ...(bills && can('process:payroll') ? [{ label: 'Contract terms (billing)', to: `/finance/pay-bill?tab=terms${clientId ? `&client=${clientId}` : ''}` }] : []),
          // Tags for reporting is the sibling finance-config page; its route is
          // gated on view:hr-admin, so only show the door to people it opens for.
          ...(can('view:hr-admin') ? [{ label: 'Tags for reporting', to: '/worktags' }] : []),
        ]}
        filters={
          !bills ? undefined : <FilterBar>
            <label htmlFor="payrules-client" className="text-xs2 uppercase tracking-wider text-silver">
              {term('label.client')}
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
              <Select id="payrules-client" size="sm" className="min-w-0 max-w-full sm:w-64" value={clientId} onChange={(e) => setClientId(e.target.value)}>
                {seesAll ? <option value="">All {term('label.clients').toLowerCase()}</option> : clients.length === 0 && <option value="">—</option>}
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            )}
          </FilterBar>
        }
    >
      {!clientId && seesAll ? (
        <AllClients onPick={(id) => setClientId(id)} />
      ) : (
        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
          <TabsList>
            <TabsTrigger value="premium">Premium pay</TabsTrigger>
            <TabsTrigger value="tips">Tip pools</TabsTrigger>
            <TabsTrigger value="projects">Projects</TabsTrigger>
          </TabsList>
          {bills && clientName && <p className="mt-2 text-sm text-ink-muted">For {clientName}.</p>}
          <TabsContent value="premium">
            {clientId && <PremiumTab clientId={clientId} />}
          </TabsContent>
          <TabsContent value="tips">
            {clientId && <TipsTab clientId={clientId} />}
          </TabsContent>
          <TabsContent value="projects">
            {clientId && <ProjectsTab clientId={clientId} />}
          </TabsContent>
        </Tabs>
      )}
    </ListTemplate>
  );
}

/** "All clients": each client's rules at a glance; a row opens that client's. */
function AllClients({ onPick }: { onPick: (clientId: string) => void }) {
  const term = useTerm();
  const q = useQuery({ queryKey: ['pay-rules', 'summary'], queryFn: payRulesSummary });
  type Row = Awaited<ReturnType<typeof payRulesSummary>>['clients'][number];
  return (
    <DataGrid<Row>
      id="pay-rules-all-clients"
      caption={`Pay rules by ${term('label.client').toLowerCase()}`}
      noun={{ one: term('label.client').toLowerCase(), many: term('label.clients').toLowerCase() }}
      rows={q.data?.clients}
      loading={q.isPending}
      error={q.isError ? errorText(q.error, 'Could not load the pay rules.') : null}
      onRetry={() => void q.refetch()}
      rowKey={(r) => r.clientId}
      onRowClick={(r) => onPick(r.clientId)}
      rowActionLabel={(r) => `Open ${r.clientName}’s pay rules`}
      defaultSort={{ key: 'client', direction: 'asc' }}
      columns={[
        { key: 'client', header: term('label.client'), accessor: (r) => r.clientName, sortable: true, primary: true, cell: (r) => <span className="font-medium text-ink">{r.clientName}</span> },
        { key: 'premium', header: 'Premium rules', accessor: (r) => r.premiumRules, sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cell: (r) => (r.premiumRules ? r.premiumRules : <span className="text-ink-muted">None</span>) },
        { key: 'tips', header: 'Open tip pools', accessor: (r) => r.openTipPools, sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cell: (r) => (r.openTipPools ? r.openTipPools : <span className="text-ink-muted">None</span>) },
        { key: 'projects', header: 'Projects', accessor: (r) => r.projects, sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cardMeta: true, cell: (r) => (r.projects ? r.projects : <span className="text-ink-muted">None</span>) },
      ]}
      empty={{ title: `No ${term('label.clients').toLowerCase()} yet`, description: 'Pay rules are set per client.' }}
    />
  );
}

// ============ Projects ============

function ProjectsTab({ clientId }: { clientId: string }) {
  const confirm = useConfirm();
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [editTarget, setEditTarget] = useState<Project | null>(null);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [isBillable, setIsBillable] = useState(true);

  const refreshQuery = useQuery({
    queryKey: ['ProjectsTab', 'rows', clientId],
    queryFn: () => listProjects(clientId),
  });
  const rows: Project[] | null = refreshQuery.data?.projects ?? null;
  useEffect(() => {
    const r = refreshQuery.data;
    if (r === undefined) return;
    setLoadError(null);

  }, [refreshQuery.data]);
  useEffect(() => {
    if (!refreshQuery.isError) return;
    setLoadError('Failed to load projects.')
  }, [refreshQuery.isError, refreshQuery.error]);
  const refresh = () => void refreshQuery.refetch();

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
      toast.error(errorText(err, "Couldn't create the project."));
    }
  };

  const onDeactivate = async (id: string) => {
    if (!(await confirm({ title: 'Deactivate this project?', destructive: true }))) return;
    try {
      await deactivateProject(id);
      refresh();
    } catch (err) {
      toast.error(errorText(err, "Couldn't deactivate the project."));
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
            <div className="p-6">
              <ErrorBanner
                action={
                  <Button size="sm" variant="secondary" onClick={refresh}>
                    Retry
                  </Button>
                }
              >
                {loadError}
              </ErrorBanner>
            </div>
          ) : rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              title="No projects"
              description="Create projects to track time-by-project under each client."
            />
          ) : (
            <DataGrid<NonNullable<typeof rows>[number]>
              id="projects"
              caption="Projects"
              rows={rows}
              rowKey={(pr) => pr.id}
              search={{ placeholder: 'Code, name…' }}
              urlState={false}
              exportCsv={{ filename: 'projects' }}
              onRowClick={(pr) => setEditTarget(pr)}
              rowActionLabel={(pr) => `Edit ${pr.name}`}
              columns={[
                { key: 'code', header: 'Code', accessor: (pr) => pr.code, sortable: true, cardMeta: true, className: 'font-mono text-xs' },
                { key: 'name', header: 'Name', accessor: (pr) => pr.name, sortable: true, primary: true, className: 'text-white' },
                { key: 'billable', header: 'Billable', accessor: (pr) => (pr.isBillable ? 'Yes' : 'No'), sortable: true, searchable: false },
                { key: 'active', header: 'Active', accessor: (pr) => (pr.isActive ? 'Active' : 'Inactive'), sortable: true, searchable: false, cell: (pr) => <Badge variant={pr.isActive ? 'success' : 'default'}>{pr.isActive ? 'Active' : 'Inactive'}</Badge> },
                {
                  key: 'action',
                  header: 'Action',
                  accessor: () => null,
                  searchable: false,
                  csv: () => '',
                  align: 'right',
                  stopRowClick: true,
                  cell: (pr) => (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => setEditTarget(pr)}>
                        Edit
                      </Button>
                      {pr.isActive && (
                        <Button size="sm" variant="ghost" onClick={() => onDeactivate(pr.id)}>
                          Deactivate
                        </Button>
                      )}
                    </>
                  ),
                },
              ]}
            />
          )}
        </CardContent>
      </Card>
      <Drawer open={showNew} onOpenChange={setShowNew} confirmDiscard={() => code.trim().length > 0 || name.trim().length > 0}>
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
      toast.error(errorText(err, "Couldn't save the project."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()} confirmDiscard={() => code !== project.code || name !== project.name || isBillable !== project.isBillable}>
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  const refreshQuery = useQuery({
    queryKey: ['PremiumTab', 'rows', clientId],
    queryFn: () => listPremiumPayRules(clientId),
  });
  const rows: PremiumPayRule[] | null = refreshQuery.data?.rules ?? null;
  useEffect(() => {
    const r = refreshQuery.data;
    if (r === undefined) return;
    setLoadError(null);

  }, [refreshQuery.data]);
  useEffect(() => {
    if (!refreshQuery.isError) return;
    setLoadError('Failed to load premium pay rules.')
  }, [refreshQuery.isError, refreshQuery.error]);
  const refresh = () => void refreshQuery.refetch();

  const onDelete = async (id: string) => {
    if (!(await confirm({ title: 'Deactivate this rule?', destructive: true }))) return;
    try {
      await deletePremiumPayRule(id);
      refresh();
    } catch (err) {
      toast.error(errorText(err, "Couldn't deactivate the pay rule."));
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
            <div className="p-6">
              <ErrorBanner
                action={
                  <Button size="sm" variant="secondary" onClick={refresh}>
                    Retry
                  </Button>
                }
              >
                {loadError}
              </ErrorBanner>
            </div>
          ) : rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              title="No premium pay rules"
              description="Define overtime multipliers, night differentials, holiday pay, and other premium rules."
            />
          ) : (
            <DataGrid<NonNullable<typeof rows>[number]>
              id="premium-pay-rules"
              caption="Premium pay rules"
              rows={rows}
              rowKey={(r) => r.id}
              search={{ placeholder: 'Name, kind…' }}
              urlState={false}
              exportCsv={{ filename: 'premium-pay-rules' }}
              columns={[
                { key: 'name', header: 'Name', accessor: (r) => r.name, sortable: true, primary: true, className: 'font-medium text-white' },
                { key: 'kind', header: 'Kind', accessor: (r) => KIND_LABEL[r.kind] ?? r.kind, sortable: true, cardMeta: true },
                { key: 'multiplier', header: 'Multiplier', accessor: (r) => r.multiplier, csv: (r) => (r.multiplier ? `×${r.multiplier}` : ''), sortable: true, searchable: false, align: 'right', cardMeta: true, className: 'tabular-nums', cell: (r) => (r.multiplier ? `×${r.multiplier}` : '—') },
                { key: 'add', header: 'Add $/hr', accessor: (r) => r.addPerHour, csv: (r) => (r.addPerHour ? fmtMoney(r.addPerHour) : ''), sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cell: (r) => (r.addPerHour ? fmtMoney(r.addPerHour) : '—') },
                { key: 'threshold', header: 'Threshold', accessor: (r) => r.thresholdHours, csv: (r) => (r.thresholdHours ? `${r.thresholdHours} hr` : ''), sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cell: (r) => (r.thresholdHours ? `${r.thresholdHours} hr` : '—') },
                { key: 'active', header: 'Active', accessor: (r) => (r.isActive ? 'Yes' : 'No'), sortable: true, searchable: false, cell: (r) => <Badge variant={r.isActive ? 'success' : 'default'}>{r.isActive ? 'Yes' : 'No'}</Badge> },
                {
                  key: 'action',
                  header: 'Action',
                  accessor: () => null,
                  searchable: false,
                  csv: () => '',
                  align: 'right',
                  stopRowClick: true,
                  cell: (r) =>
                    r.isActive ? (
                      <Button size="sm" variant="ghost" onClick={() => onDelete(r.id)}>
                        Deactivate
                      </Button>
                    ) : null,
                },
              ]}
            />
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
      toast.error(errorText(err, "Couldn't save the pay rule."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()} confirmDiscard={() => name.trim().length > 0 || addPerHour !== '' || multiplier !== '1.5' || thresholdHours !== '8'}>
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

const POOL_STATUS_LABELS: Record<TipPool['status'], string> = {
  OPEN: 'Open',
  CLOSED: 'Closed',
  PAID_OUT: 'Paid out',
};

function TipsTab({ clientId }: { clientId: string }) {
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [active, setActive] = useState<TipPool | null>(null);

  const refreshQuery = useQuery({
    queryKey: ['TipsTab', 'rows', clientId],
    queryFn: () => listTipPools(clientId),
  });
  const rows: TipPool[] | null = refreshQuery.data?.pools ?? null;
  useEffect(() => {
    const r = refreshQuery.data;
    if (r === undefined) return;
    setLoadError(null);

  }, [refreshQuery.data]);
  useEffect(() => {
    if (!refreshQuery.isError) return;
    setLoadError('Failed to load tip pools.')
  }, [refreshQuery.isError, refreshQuery.error]);
  const refresh = () => void refreshQuery.refetch();

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
            <div className="p-6">
              <ErrorBanner
                action={
                  <Button size="sm" variant="secondary" onClick={refresh}>
                    Retry
                  </Button>
                }
              >
                {loadError}
              </ErrorBanner>
            </div>
          ) : rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              title="No tip pools"
              description="Create a pool, sum tips, allocate by hours-worked or %, then close + pay out."
            />
          ) : (
            <DataGrid<NonNullable<typeof rows>[number]>
              id="tip-pools"
              caption="Tip pools"
              rows={rows}
              rowKey={(pool) => pool.id}
              search={{ placeholder: 'Pool name…' }}
              urlState={false}
              exportCsv={{ filename: 'tip-pools' }}
              onRowClick={(pool) => setActive(pool)}
              rowActionLabel={(pool) => `Open ${pool.name}`}
              columns={[
                { key: 'date', header: 'Date', accessor: (pool) => pool.shiftDate, sortable: true, searchable: false, cardMeta: true, cell: (pool) => fmtDate(parseYmd(pool.shiftDate)) },
                { key: 'name', header: 'Name', accessor: (pool) => pool.name, sortable: true, primary: true, className: 'text-white' },
                { key: 'total', header: 'Total', accessor: (pool) => Number(pool.totalAmount), csv: (pool) => fmtMoney(pool.totalAmount, { currency: pool.currency }), sortable: true, searchable: false, align: 'right', cardMeta: true, className: 'tabular-nums', cell: (pool) => fmtMoney(pool.totalAmount, { currency: pool.currency }) },
                { key: 'allocations', header: 'Allocations', accessor: (pool) => pool.allocationCount, sortable: true, searchable: false, align: 'right', className: 'tabular-nums' },
                {
                  key: 'status',
                  header: 'Status',
                  accessor: (pool) => POOL_STATUS_LABELS[pool.status] ?? pool.status,
                  sortable: true,
                  cell: (pool) => <Badge variant={pool.status === 'PAID_OUT' ? 'success' : pool.status === 'CLOSED' ? 'pending' : 'default'}>{POOL_STATUS_LABELS[pool.status] ?? pool.status}</Badge>,
                },
              ]}
            />
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
      toast.error(errorText(err, "Couldn't create the tip pool."));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()} confirmDiscard={() => name.trim().length > 0 || total !== ''}>
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
        {error && <ErrorBanner>{error}</ErrorBanner>}
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
  const term = useTerm();
  const [busy, setBusy] = useState(false);
  // datetime-local wall-clock values; converted to UTC ISO on submit.
  const [from, setFrom] = useState(`${pool.shiftDate}T00:00`);
  const [to, setTo] = useState(`${pool.shiftDate}T23:59`);
  const [manualAssociate, setManualAssociate] = useState<PickedAssociate | null>(null);
  const [manualAmount, setManualAmount] = useState('');

  const refreshQuery = useQuery({
    queryKey: ['allocations', pool.id],
    queryFn: () => listAllocations(pool.id),
  });
  const allocations = refreshQuery.data?.allocations ?? null;
  const allocError = refreshQuery.error ? (refreshQuery.error instanceof ApiError ? refreshQuery.error.message : 'Failed to load allocations.') : null;
  const refresh = () => void refreshQuery.refetch();

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
      toast.error(errorText(err, "Couldn't allocate the tips."));
    } finally {
      setBusy(false);
    }
  };

  const onAddManual = async () => {
    if (!manualAssociate) {
      toast.error(pickOne(term));
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
      toast.error(errorText(err, "Couldn't add the allocation."));
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
      toast.error(errorText(err, "Couldn't close the tip pool."));
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
      toast.error(errorText(err, "Couldn't pay out the tip pool."));
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
    <Drawer open={true} onOpenChange={(o) => !o && onClose()} width="max-w-2xl" confirmDiscard={() => manualAssociate !== null || manualAmount !== ''}>
      <DrawerHeader>
        <DrawerTitle>{pool.name}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div className="text-sm text-silver">
          {fmtDate(parseYmd(pool.shiftDate))} •{' '}
          <span className="text-white">
            {fmtMoney(pool.totalAmount, { currency: pool.currency })}
          </span>{' '}
          • status:{' '}
          <span className="text-white">{POOL_STATUS_LABELS[pool.status]}</span>
        </div>
        {pool.status === 'OPEN' && (
          <Card>
            <CardContent className="space-y-3">
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
            <CardContent className="space-y-3">
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
          <ErrorBanner
            action={
              <Button size="sm" variant="secondary" onClick={refresh}>
                Retry
              </Button>
            }
          >
            {allocError}
          </ErrorBanner>
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
            <DataGrid<(typeof allocations)[number]>
              id="tip-pool-allocations"
              caption="Allocations"
              rows={allocations}
              rowKey={(a) => a.id}
              search={false}
              urlState={false}
              exportCsv={false}
              columnChooser={false}
              columns={[
                { key: 'associate', header: 'Associate', accessor: (a) => a.associateName, sortable: true, primary: true, className: 'text-white' },
                { key: 'hours', header: 'Hours', accessor: (a) => a.hoursWorked, sortable: true, searchable: false, align: 'right', cardMeta: true, className: 'tabular-nums' },
                { key: 'share', header: 'Share %', accessor: (a) => a.sharePct, csv: (a) => (a.sharePct ? `${a.sharePct}%` : ''), sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cell: (a) => (a.sharePct ? `${a.sharePct}%` : '—') },
                { key: 'amount', header: 'Amount', accessor: (a) => Number(a.amount), csv: (a) => fmtMoney(a.amount, { currency: pool.currency }), sortable: true, searchable: false, align: 'right', cardMeta: true, className: 'tabular-nums', cell: (a) => fmtMoney(a.amount, { currency: pool.currency }) },
              ]}
              footnote={
                <div className="space-y-1 text-sm">
                  <div className="flex justify-between gap-4 font-medium text-white">
                    <span>Total allocated ({headcount})</span>
                    <span className="tabular-nums">{fmtMoney(allocatedTotal, { currency: pool.currency })}</span>
                  </div>
                  <div className={`flex justify-between gap-4 ${remainderNonZero ? 'text-alert font-medium' : 'text-silver'}`}>
                    <span>Unallocated remainder</span>
                    <span className="tabular-nums">{fmtMoney(remainder, { currency: pool.currency })}</span>
                  </div>
                </div>
              }
            />
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
