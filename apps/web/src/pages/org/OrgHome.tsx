import { useEffect, useMemo, useState } from 'react';
import { Briefcase, Building2, FolderTree, Hash, Plus, Sparkles, Trash2, Users } from 'lucide-react';
import { PositionsTab } from './PositionsTab';
import { CustomFieldsTab } from './CustomFieldsTab';
import type {
  CostCenter,
  Department,
  JobProfile,
  AssociateOrgSummary,
} from '@alto-people/shared';
import { listClients } from '@/lib/clientsApi';
import type { ClientListItem } from '@alto-people/shared';
import {
  assignOrgFields,
  createCostCenter,
  createDepartment,
  createJobProfile,
  deleteCostCenter,
  deleteDepartment,
  deleteJobProfile,
  listAssociateHistory,
  listCostCenters,
  listDepartments,
  listJobProfiles,
  listOrgAssociates,
  updateCostCenter,
  updateDepartment,
  updateJobProfile,
  type AssociateHistoryEntry,
} from '@/lib/orgApi';
import { useAuth } from '@/lib/auth';
import { hasCapability } from '@/lib/roles';
import { ApiError } from '@/lib/api';
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardContent,
  Drawer,
  DrawerBody,
  DrawerDescription,
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

type Tab = 'departments' | 'cost-centers' | 'job-profiles' | 'positions' | 'people' | 'custom-fields';

export function OrgHome() {
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:org') : false;
  const [clients, setClients] = useState<ClientListItem[]>([]);
  const [clientId, setClientId] = useState<string>('');
  const [tab, setTab] = useState<Tab>('departments');

  useEffect(() => {
    listClients()
      .then((res) => {
        setClients(res.clients);
        if (!clientId && res.clients.length === 1) {
          setClientId(res.clients[0].id);
        }
      })
      .catch(() => {
        // listClients failure is non-fatal — manager UI can still work
        // without the per-client filter applied (returns global view).
      });
  }, [clientId]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Org structure"
        subtitle="Departments, cost centers, job profiles, and the people-to-org assignments that hold dimensional reporting and approval routing together."
        breadcrumbs={[{ label: 'Workforce' }, { label: 'Org' }]}
      />

      <Card>
        <CardContent className="p-4 flex items-center gap-3 flex-wrap">
          <span className="text-[11px] uppercase tracking-wider text-silver">
            Client
          </span>
          <select
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            className="h-9 px-2 rounded bg-navy-secondary/40 border border-navy-secondary text-sm text-white"
          >
            <option value="">All clients</option>
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
          <TabsTrigger value="departments">
            <FolderTree className="h-3.5 w-3.5" />
            Departments
          </TabsTrigger>
          <TabsTrigger value="cost-centers">
            <Hash className="h-3.5 w-3.5" />
            Cost centers
          </TabsTrigger>
          <TabsTrigger value="job-profiles">
            <Building2 className="h-3.5 w-3.5" />
            Job profiles
          </TabsTrigger>
          <TabsTrigger value="positions">
            <Briefcase className="h-3.5 w-3.5" />
            Positions
          </TabsTrigger>
          <TabsTrigger value="people">
            <Users className="h-3.5 w-3.5" />
            People
          </TabsTrigger>
          <TabsTrigger value="custom-fields">
            <Sparkles className="h-3.5 w-3.5" />
            Custom fields
          </TabsTrigger>
        </TabsList>
        <TabsContent value="departments">
          <DepartmentsTab clientId={clientId} canManage={canManage} />
        </TabsContent>
        <TabsContent value="cost-centers">
          <CostCentersTab clientId={clientId} canManage={canManage} />
        </TabsContent>
        <TabsContent value="job-profiles">
          <JobProfilesTab clientId={clientId} canManage={canManage} />
        </TabsContent>
        <TabsContent value="positions">
          <PositionsTab clientId={clientId} canManage={canManage} />
        </TabsContent>
        <TabsContent value="people">
          <PeopleTab clientId={clientId} canManage={canManage} clients={clients} />
        </TabsContent>
        <TabsContent value="custom-fields">
          <CustomFieldsTab clientId={clientId} canManage={canManage} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ----- Departments tab ----------------------------------------------------

function DepartmentsTab({
  clientId,
  canManage,
}: {
  clientId: string;
  canManage: boolean;
}) {
  const [rows, setRows] = useState<Department[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drawerTarget, setDrawerTarget] = useState<Department | 'new' | null>(null);

  const refresh = async () => {
    try {
      setError(null);
      const res = await listDepartments(clientId || undefined);
      setRows(res.departments);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load.');
    }
  };

  useEffect(() => {
    setRows(null);
    refresh();
  }, [clientId]);

  return (
    <section>
      <div className="flex items-center justify-between gap-3 mb-4">
        <h2 className="text-base font-medium text-white">Departments</h2>
        {canManage && clientId && (
          <Button onClick={() => setDrawerTarget('new')} size="sm">
            <Plus className="h-4 w-4" />
            New department
          </Button>
        )}
      </div>
      {error && <p role="alert" className="text-sm text-alert mb-3">{error}</p>}
      {!rows && <SkeletonRows count={4} rowHeight="h-12" />}
      {rows && rows.length === 0 && (
        <EmptyState
          icon={FolderTree}
          title="No departments yet"
          description={
            clientId
              ? 'Pick a client and create a department to start organizing.'
              : 'Pick a client to start adding departments.'
          }
          action={
            canManage && clientId ? (
              <Button onClick={() => setDrawerTarget('new')} size="sm">
                <Plus className="h-4 w-4" />
                New department
              </Button>
            ) : undefined
          }
        />
      )}
      {rows && rows.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Code</TableHead>
              <TableHead>Parent</TableHead>
              <TableHead className="text-right">Associates</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((d) => {
              const parent = rows.find((p) => p.id === d.parentId);
              return (
                <TableRow
                  key={d.id}
                  className="group cursor-pointer"
                  onClick={(e) => {
                    const t = e.target as HTMLElement;
                    if (t.closest('button, a, input, [data-no-row-click]')) return;
                    setDrawerTarget(d);
                  }}
                >
                  <TableCell className="font-medium">{d.name}</TableCell>
                  <TableCell className="text-silver">{d.code ?? '—'}</TableCell>
                  <TableCell className="text-silver">{parent?.name ?? '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {d.associateCount}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <Drawer
        open={drawerTarget !== null}
        onOpenChange={(o) => !o && setDrawerTarget(null)}
        width="max-w-md"
      >
        {drawerTarget && (
          <DepartmentDrawer
            target={drawerTarget}
            clientId={clientId}
            allDepartments={rows ?? []}
            canManage={canManage}
            onClose={() => setDrawerTarget(null)}
            onSaved={() => {
              setDrawerTarget(null);
              refresh();
            }}
          />
        )}
      </Drawer>
    </section>
  );
}

function DepartmentDrawer({
  target,
  clientId,
  allDepartments,
  canManage,
  onClose,
  onSaved,
}: {
  target: Department | 'new';
  clientId: string;
  allDepartments: Department[];
  canManage: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = target === 'new';
  const initial = isNew ? null : target;
  const [name, setName] = useState(initial?.name ?? '');
  const [code, setCode] = useState(initial?.code ?? '');
  const [parentId, setParentId] = useState(initial?.parentId ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) return;
    setError(null);
    setSubmitting(true);
    try {
      if (isNew) {
        await createDepartment({
          clientId,
          name: name.trim(),
          code: code.trim() || null,
          parentId: parentId || null,
          description: description.trim() || null,
        });
        toast.success('Department created');
      } else {
        await updateDepartment(initial!.id, {
          name: name.trim(),
          code: code.trim() || null,
          parentId: parentId || null,
          description: description.trim() || null,
        });
        toast.success('Department updated');
      }
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Save failed.');
    } finally {
      setSubmitting(false);
    }
  };

  const remove = async () => {
    if (isNew) return;
    if (!window.confirm(`Delete "${initial!.name}"?`)) return;
    setSubmitting(true);
    try {
      await deleteDepartment(initial!.id);
      toast.success('Department deleted');
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Delete failed.');
      setSubmitting(false);
    }
  };

  return (
    <>
      <DrawerHeader>
        <DrawerTitle>
          {isNew ? 'New department' : initial!.name}
        </DrawerTitle>
        <DrawerDescription>
          {isNew
            ? 'Departments group associates for reporting and approval routing.'
            : `${initial!.associateCount} associate${initial!.associateCount === 1 ? '' : 's'}`}
        </DrawerDescription>
      </DrawerHeader>
      <DrawerBody>
        <div className="space-y-3">
          <div>
            <Label htmlFor="dept-name" required>Name</Label>
            <Input
              id="dept-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              disabled={!canManage}
            />
          </div>
          <div>
            <Label htmlFor="dept-code">Code</Label>
            <Input
              id="dept-code"
              value={code ?? ''}
              onChange={(e) => setCode(e.target.value)}
              maxLength={40}
              placeholder="HRD"
              disabled={!canManage}
            />
          </div>
          <div>
            <Label htmlFor="dept-parent">Parent department</Label>
            <select
              id="dept-parent"
              value={parentId ?? ''}
              onChange={(e) => setParentId(e.target.value)}
              disabled={!canManage}
              className="w-full h-10 px-3 py-2 rounded-md bg-navy-secondary/40 border border-navy-secondary focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold text-white text-sm"
            >
              <option value="">— None (top-level) —</option>
              {allDepartments
                .filter((d) => !isNew && d.id !== initial!.id)
                .map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
            </select>
          </div>
          <div>
            <Label htmlFor="dept-desc">Description</Label>
            <Input
              id="dept-desc"
              value={description ?? ''}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
              disabled={!canManage}
            />
          </div>
          {error && <p role="alert" className="text-sm text-alert">{error}</p>}
        </div>
      </DrawerBody>
      <DrawerFooter className="justify-between">
        {!isNew && canManage ? (
          <Button
            variant="ghost"
            onClick={remove}
            disabled={submitting}
            className="text-alert hover:text-alert"
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </Button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          {canManage && (
            <Button onClick={submit} loading={submitting} disabled={!name.trim()}>
              {isNew ? 'Create' : 'Save'}
            </Button>
          )}
        </div>
      </DrawerFooter>
    </>
  );
}

// ----- Cost centers tab ---------------------------------------------------

function CostCentersTab({
  clientId,
  canManage,
}: {
  clientId: string;
  canManage: boolean;
}) {
  const [rows, setRows] = useState<CostCenter[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drawerTarget, setDrawerTarget] = useState<CostCenter | 'new' | null>(null);

  const refresh = async () => {
    try {
      setError(null);
      const res = await listCostCenters(clientId || undefined);
      setRows(res.costCenters);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load.');
    }
  };

  useEffect(() => {
    setRows(null);
    refresh();
  }, [clientId]);

  return (
    <section>
      <div className="flex items-center justify-between gap-3 mb-4">
        <h2 className="text-base font-medium text-white">Cost centers</h2>
        {canManage && clientId && (
          <Button onClick={() => setDrawerTarget('new')} size="sm">
            <Plus className="h-4 w-4" />
            New cost center
          </Button>
        )}
      </div>
      {error && <p role="alert" className="text-sm text-alert mb-3">{error}</p>}
      {!rows && <SkeletonRows count={4} rowHeight="h-12" />}
      {rows && rows.length === 0 && (
        <EmptyState
          icon={Hash}
          title="No cost centers yet"
          description={
            clientId
              ? 'Add a cost center to tag payroll items, time entries, and shifts for dimensional reporting.'
              : 'Pick a client to start adding cost centers.'
          }
          action={
            canManage && clientId ? (
              <Button onClick={() => setDrawerTarget('new')} size="sm">
                <Plus className="h-4 w-4" />
                New cost center
              </Button>
            ) : undefined
          }
        />
      )}
      {rows && rows.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Name</TableHead>
              <TableHead className="text-right">Associates</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((c) => (
              <TableRow
                key={c.id}
                className="group cursor-pointer"
                onClick={(e) => {
                  const t = e.target as HTMLElement;
                  if (t.closest('button, a, input, [data-no-row-click]')) return;
                  setDrawerTarget(c);
                }}
              >
                <TableCell className="font-medium tabular-nums">{c.code}</TableCell>
                <TableCell>{c.name}</TableCell>
                <TableCell className="text-right tabular-nums">{c.associateCount}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Drawer
        open={drawerTarget !== null}
        onOpenChange={(o) => !o && setDrawerTarget(null)}
        width="max-w-md"
      >
        {drawerTarget && (
          <CostCenterDrawer
            target={drawerTarget}
            clientId={clientId}
            canManage={canManage}
            onClose={() => setDrawerTarget(null)}
            onSaved={() => {
              setDrawerTarget(null);
              refresh();
            }}
          />
        )}
      </Drawer>
    </section>
  );
}

function CostCenterDrawer({
  target,
  clientId,
  canManage,
  onClose,
  onSaved,
}: {
  target: CostCenter | 'new';
  clientId: string;
  canManage: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = target === 'new';
  const initial = isNew ? null : target;
  const [code, setCode] = useState(initial?.code ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!code.trim() || !name.trim()) return;
    setError(null);
    setSubmitting(true);
    try {
      if (isNew) {
        await createCostCenter({
          clientId,
          code: code.trim(),
          name: name.trim(),
          description: description.trim() || null,
        });
        toast.success('Cost center created');
      } else {
        await updateCostCenter(initial!.id, {
          code: code.trim(),
          name: name.trim(),
          description: description.trim() || null,
        });
        toast.success('Cost center updated');
      }
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Save failed.');
    } finally {
      setSubmitting(false);
    }
  };

  const remove = async () => {
    if (isNew) return;
    if (!window.confirm(`Delete cost center ${initial!.code}?`)) return;
    setSubmitting(true);
    try {
      await deleteCostCenter(initial!.id);
      toast.success('Cost center deleted');
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Delete failed.');
      setSubmitting(false);
    }
  };

  return (
    <>
      <DrawerHeader>
        <DrawerTitle>{isNew ? 'New cost center' : initial!.code}</DrawerTitle>
        <DrawerDescription>
          {isNew
            ? 'Codes are short ALL-CAPS identifiers (max 40 chars), unique per client.'
            : initial!.name}
        </DrawerDescription>
      </DrawerHeader>
      <DrawerBody>
        <div className="space-y-3">
          <div>
            <Label htmlFor="cc-code" required>Code</Label>
            <Input
              id="cc-code"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              maxLength={40}
              placeholder="HQ-OPS"
              disabled={!canManage}
            />
          </div>
          <div>
            <Label htmlFor="cc-name" required>Name</Label>
            <Input
              id="cc-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              disabled={!canManage}
            />
          </div>
          <div>
            <Label htmlFor="cc-desc">Description</Label>
            <Input
              id="cc-desc"
              value={description ?? ''}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
              disabled={!canManage}
            />
          </div>
          {error && <p role="alert" className="text-sm text-alert">{error}</p>}
        </div>
      </DrawerBody>
      <DrawerFooter className="justify-between">
        {!isNew && canManage ? (
          <Button
            variant="ghost"
            onClick={remove}
            disabled={submitting}
            className="text-alert hover:text-alert"
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </Button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          {canManage && (
            <Button
              onClick={submit}
              loading={submitting}
              disabled={!code.trim() || !name.trim()}
            >
              {isNew ? 'Create' : 'Save'}
            </Button>
          )}
        </div>
      </DrawerFooter>
    </>
  );
}

// ----- Job profiles tab ---------------------------------------------------

function JobProfilesTab({
  clientId,
  canManage,
}: {
  clientId: string;
  canManage: boolean;
}) {
  const [rows, setRows] = useState<JobProfile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drawerTarget, setDrawerTarget] = useState<JobProfile | 'new' | null>(null);

  const refresh = async () => {
    try {
      setError(null);
      const res = await listJobProfiles(clientId || undefined);
      setRows(res.jobProfiles);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load.');
    }
  };

  useEffect(() => {
    setRows(null);
    refresh();
  }, [clientId]);

  return (
    <section>
      <div className="flex items-center justify-between gap-3 mb-4">
        <h2 className="text-base font-medium text-white">Job profiles</h2>
        {canManage && clientId && (
          <Button onClick={() => setDrawerTarget('new')} size="sm">
            <Plus className="h-4 w-4" />
            New job profile
          </Button>
        )}
      </div>
      {error && <p role="alert" className="text-sm text-alert mb-3">{error}</p>}
      {!rows && <SkeletonRows count={4} rowHeight="h-12" />}
      {rows && rows.length === 0 && (
        <EmptyState
          icon={Building2}
          title="No job profiles yet"
          description={
            clientId
              ? 'Job profiles capture title, family, level, and FLSA exemption — used by comp bands and OT calculation.'
              : 'Pick a client to start adding job profiles.'
          }
          action={
            canManage && clientId ? (
              <Button onClick={() => setDrawerTarget('new')} size="sm">
                <Plus className="h-4 w-4" />
                New job profile
              </Button>
            ) : undefined
          }
        />
      )}
      {rows && rows.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Title</TableHead>
              <TableHead>Family</TableHead>
              <TableHead>Level</TableHead>
              <TableHead>FLSA</TableHead>
              <TableHead className="text-right">Associates</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((j) => (
              <TableRow
                key={j.id}
                className="group cursor-pointer"
                onClick={(e) => {
                  const t = e.target as HTMLElement;
                  if (t.closest('button, a, input, [data-no-row-click]')) return;
                  setDrawerTarget(j);
                }}
              >
                <TableCell className="font-medium tabular-nums">{j.code}</TableCell>
                <TableCell>{j.title}</TableCell>
                <TableCell className="text-silver">{j.family ?? '—'}</TableCell>
                <TableCell className="text-silver">{j.level ?? '—'}</TableCell>
                <TableCell>
                  <Badge variant={j.isExempt ? 'accent' : 'default'}>
                    {j.isExempt ? 'Exempt' : 'Non-exempt'}
                  </Badge>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {j.associateCount}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Drawer
        open={drawerTarget !== null}
        onOpenChange={(o) => !o && setDrawerTarget(null)}
        width="max-w-md"
      >
        {drawerTarget && (
          <JobProfileDrawer
            target={drawerTarget}
            clientId={clientId}
            canManage={canManage}
            onClose={() => setDrawerTarget(null)}
            onSaved={() => {
              setDrawerTarget(null);
              refresh();
            }}
          />
        )}
      </Drawer>
    </section>
  );
}

function JobProfileDrawer({
  target,
  clientId,
  canManage,
  onClose,
  onSaved,
}: {
  target: JobProfile | 'new';
  clientId: string;
  canManage: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = target === 'new';
  const initial = isNew ? null : target;
  const [code, setCode] = useState(initial?.code ?? '');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [family, setFamily] = useState(initial?.family ?? '');
  const [level, setLevel] = useState(initial?.level ?? '');
  const [isExempt, setIsExempt] = useState(initial?.isExempt ?? false);
  const [description, setDescription] = useState(initial?.description ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!code.trim() || !title.trim()) return;
    setError(null);
    setSubmitting(true);
    try {
      if (isNew) {
        await createJobProfile({
          clientId,
          code: code.trim(),
          title: title.trim(),
          family: family.trim() || null,
          level: level.trim() || null,
          isExempt,
          description: description.trim() || null,
        });
        toast.success('Job profile created');
      } else {
        await updateJobProfile(initial!.id, {
          code: code.trim(),
          title: title.trim(),
          family: family.trim() || null,
          level: level.trim() || null,
          isExempt,
          description: description.trim() || null,
        });
        toast.success('Job profile updated');
      }
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Save failed.');
    } finally {
      setSubmitting(false);
    }
  };

  const remove = async () => {
    if (isNew) return;
    if (!window.confirm(`Delete job profile ${initial!.code}?`)) return;
    setSubmitting(true);
    try {
      await deleteJobProfile(initial!.id);
      toast.success('Job profile deleted');
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Delete failed.');
      setSubmitting(false);
    }
  };

  return (
    <>
      <DrawerHeader>
        <DrawerTitle>{isNew ? 'New job profile' : initial!.title}</DrawerTitle>
        <DrawerDescription>
          {isNew
            ? 'Code is unique per client. FLSA exemption controls overtime eligibility.'
            : initial!.code}
        </DrawerDescription>
      </DrawerHeader>
      <DrawerBody>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="jp-code" required>Code</Label>
              <Input
                id="jp-code"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                maxLength={40}
                placeholder="LINE_COOK"
                disabled={!canManage}
              />
            </div>
            <div>
              <Label htmlFor="jp-level">Level</Label>
              <Input
                id="jp-level"
                value={level ?? ''}
                onChange={(e) => setLevel(e.target.value)}
                maxLength={40}
                placeholder="L2"
                disabled={!canManage}
              />
            </div>
          </div>
          <div>
            <Label htmlFor="jp-title" required>Title</Label>
            <Input
              id="jp-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={120}
              disabled={!canManage}
            />
          </div>
          <div>
            <Label htmlFor="jp-family">Family</Label>
            <Input
              id="jp-family"
              value={family ?? ''}
              onChange={(e) => setFamily(e.target.value)}
              maxLength={80}
              placeholder="Kitchen"
              disabled={!canManage}
            />
          </div>
          <label className="text-sm text-white flex items-center gap-2">
            <input
              type="checkbox"
              checked={isExempt}
              onChange={(e) => setIsExempt(e.target.checked)}
              disabled={!canManage}
            />
            FLSA exempt (salaried, no overtime)
          </label>
          <div>
            <Label htmlFor="jp-desc">Description</Label>
            <Input
              id="jp-desc"
              value={description ?? ''}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
              disabled={!canManage}
            />
          </div>
          {error && <p role="alert" className="text-sm text-alert">{error}</p>}
        </div>
      </DrawerBody>
      <DrawerFooter className="justify-between">
        {!isNew && canManage ? (
          <Button
            variant="ghost"
            onClick={remove}
            disabled={submitting}
            className="text-alert hover:text-alert"
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </Button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          {canManage && (
            <Button
              onClick={submit}
              loading={submitting}
              disabled={!code.trim() || !title.trim()}
            >
              {isNew ? 'Create' : 'Save'}
            </Button>
          )}
        </div>
      </DrawerFooter>
    </>
  );
}

// ----- People tab — assign manager / dept / cost center / job profile -----

function PeopleTab({
  clientId,
  canManage,
  clients,
}: {
  clientId: string;
  canManage: boolean;
  clients: ClientListItem[];
}) {
  const [rows, setRows] = useState<AssociateOrgSummary[] | null>(null);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [costCenters, setCostCenters] = useState<CostCenter[]>([]);
  const [jobProfiles, setJobProfiles] = useState<JobProfile[]>([]);
  const [target, setTarget] = useState<AssociateOrgSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setError(null);
      const [a, d, c, j] = await Promise.all([
        listOrgAssociates(clientId || undefined),
        listDepartments(clientId || undefined),
        listCostCenters(clientId || undefined),
        listJobProfiles(clientId || undefined),
      ]);
      setRows(a.associates);
      setDepartments(d.departments);
      setCostCenters(c.costCenters);
      setJobProfiles(j.jobProfiles);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load.');
    }
  };

  useEffect(() => {
    setRows(null);
    refresh();
  }, [clientId]);

  const managerCandidates = useMemo(() => rows ?? [], [rows]);

  const clientLabel = clients.find((c) => c.id === clientId)?.name ?? 'All clients';

  return (
    <section>
      <div className="flex items-center justify-between gap-3 mb-4">
        <h2 className="text-base font-medium text-white">
          Associates · {clientLabel}
        </h2>
      </div>
      {error && <p role="alert" className="text-sm text-alert mb-3">{error}</p>}
      {!rows && <SkeletonRows count={6} rowHeight="h-14" />}
      {rows && rows.length === 0 && (
        <EmptyState
          icon={Users}
          title="No associates"
          description="Once associates are onboarded for the selected client, they'll appear here for org-field assignment."
        />
      )}
      {rows && rows.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Associate</TableHead>
              <TableHead>Manager</TableHead>
              <TableHead>Department</TableHead>
              <TableHead>Cost ctr</TableHead>
              <TableHead>Job profile</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((a) => (
              <TableRow
                key={a.id}
                className="group cursor-pointer"
                onClick={(e) => {
                  const t = e.target as HTMLElement;
                  if (t.closest('button, a, input, [data-no-row-click]')) return;
                  setTarget(a);
                }}
              >
                <TableCell className="font-medium">
                  <div className="flex items-center gap-2.5">
                    <Avatar name={`${a.firstName} ${a.lastName}`} email={a.email} size="sm" />
                    <span>{a.firstName} {a.lastName}</span>
                  </div>
                </TableCell>
                <TableCell className="text-silver">{a.managerName ?? '—'}</TableCell>
                <TableCell className="text-silver">{a.departmentName ?? '—'}</TableCell>
                <TableCell className="text-silver tabular-nums">
                  {a.costCenterCode ?? '—'}
                </TableCell>
                <TableCell className="text-silver">{a.jobProfileTitle ?? '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Drawer
        open={target !== null}
        onOpenChange={(o) => !o && setTarget(null)}
        width="max-w-md"
      >
        {target && (
          <PersonOrgDrawer
            associate={target}
            canManage={canManage}
            departments={departments}
            costCenters={costCenters}
            jobProfiles={jobProfiles}
            managerCandidates={managerCandidates}
            onClose={() => setTarget(null)}
            onSaved={() => {
              setTarget(null);
              refresh();
            }}
          />
        )}
      </Drawer>
    </section>
  );
}

function PersonOrgDrawer({
  associate,
  canManage,
  departments,
  costCenters,
  jobProfiles,
  managerCandidates,
  onClose,
  onSaved,
}: {
  associate: AssociateOrgSummary;
  canManage: boolean;
  departments: Department[];
  costCenters: CostCenter[];
  jobProfiles: JobProfile[];
  managerCandidates: AssociateOrgSummary[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [managerId, setManagerId] = useState(associate.managerId ?? '');
  const [departmentId, setDepartmentId] = useState(associate.departmentId ?? '');
  const [costCenterId, setCostCenterId] = useState(associate.costCenterId ?? '');
  const [jobProfileId, setJobProfileId] = useState(associate.jobProfileId ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<AssociateHistoryEntry[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    listAssociateHistory(associate.id)
      .then((res) => {
        if (!cancelled) setHistory(res.history);
      })
      .catch(() => {
        if (!cancelled) setHistory([]);
      });
    return () => {
      cancelled = true;
    };
  }, [associate.id]);

  const submit = async () => {
    setError(null);
    setSubmitting(true);
    try {
      await assignOrgFields(associate.id, {
        managerId: managerId || null,
        departmentId: departmentId || null,
        costCenterId: costCenterId || null,
        jobProfileId: jobProfileId || null,
      });
      toast.success('Org assignment updated');
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Save failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <DrawerHeader>
        <div className="flex items-center gap-3">
          <Avatar
            name={`${associate.firstName} ${associate.lastName}`}
            email={associate.email}
            size="md"
          />
          <div className="min-w-0">
            <DrawerTitle className="truncate">
              {associate.firstName} {associate.lastName}
            </DrawerTitle>
            <DrawerDescription className="truncate">
              {associate.email}
            </DrawerDescription>
          </div>
        </div>
      </DrawerHeader>
      <DrawerBody>
        <div className="space-y-3">
          <div>
            <Label htmlFor="po-manager">Manager</Label>
            <select
              id="po-manager"
              value={managerId}
              onChange={(e) => setManagerId(e.target.value)}
              disabled={!canManage}
              className="w-full h-10 px-3 py-2 rounded-md bg-navy-secondary/40 border border-navy-secondary focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold text-white text-sm"
            >
              <option value="">—</option>
              {managerCandidates
                .filter((c) => c.id !== associate.id)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.firstName} {c.lastName}
                  </option>
                ))}
            </select>
          </div>
          <div>
            <Label htmlFor="po-dept">Department</Label>
            <select
              id="po-dept"
              value={departmentId}
              onChange={(e) => setDepartmentId(e.target.value)}
              disabled={!canManage}
              className="w-full h-10 px-3 py-2 rounded-md bg-navy-secondary/40 border border-navy-secondary focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold text-white text-sm"
            >
              <option value="">—</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="po-cc">Cost center</Label>
            <select
              id="po-cc"
              value={costCenterId}
              onChange={(e) => setCostCenterId(e.target.value)}
              disabled={!canManage}
              className="w-full h-10 px-3 py-2 rounded-md bg-navy-secondary/40 border border-navy-secondary focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold text-white text-sm"
            >
              <option value="">—</option>
              {costCenters.map((c) => (
                <option key={c.id} value={c.id}>{c.code} · {c.name}</option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="po-jp">Job profile</Label>
            <select
              id="po-jp"
              value={jobProfileId}
              onChange={(e) => setJobProfileId(e.target.value)}
              disabled={!canManage}
              className="w-full h-10 px-3 py-2 rounded-md bg-navy-secondary/40 border border-navy-secondary focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold text-white text-sm"
            >
              <option value="">—</option>
              {jobProfiles.map((j) => (
                <option key={j.id} value={j.id}>{j.code} · {j.title}</option>
              ))}
            </select>
          </div>
          {error && <p role="alert" className="text-sm text-alert">{error}</p>}

          <div className="pt-3 border-t border-navy-secondary">
            <div className="text-[10px] uppercase tracking-widest text-silver/80 mb-2">
              Effective changes
            </div>
            {history === null && (
              <div className="text-xs text-silver">Loading…</div>
            )}
            {history?.length === 0 && (
              <div className="text-xs text-silver">No history yet.</div>
            )}
            {history && history.length > 0 && (
              <ol className="space-y-2 text-xs">
                {history.map((h) => {
                  const isCurrent = h.effectiveTo === null;
                  return (
                    <li
                      key={h.id}
                      className="flex items-start gap-3 border-l-2 pl-3 border-navy-secondary data-[current=true]:border-gold"
                      data-current={isCurrent}
                    >
                      <div className="min-w-0">
                        <div className="text-white tabular-nums">
                          {new Date(h.effectiveFrom).toLocaleString()}
                          {isCurrent ? (
                            <Badge variant="default" className="ml-2">current</Badge>
                          ) : null}
                        </div>
                        <div className="text-silver mt-0.5">
                          {h.reason ?? '—'}
                          {h.actorEmail ? ` · ${h.actorEmail}` : ''}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        {canManage && (
          <Button onClick={submit} loading={submitting}>
            Save assignment
          </Button>
        )}
      </DrawerFooter>
    </>
  );
}
