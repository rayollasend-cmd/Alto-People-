import { useEffect, useMemo, useRef, useState } from 'react';
import { Briefcase, Building2, CalendarClock, FolderTree, Hash, Plus, Sparkles, Trash2, Users } from 'lucide-react';
import { PositionsTab } from './PositionsTab';
import { CustomFieldsTab } from './CustomFieldsTab';
import type {
  ClientSummary,
  CostCenter,
  Department,
  JobProfile,
  ShiftPosition,
  AssociateOrgSummary,
} from '@alto-people/shared';
import { useClients } from '@/lib/useClients';
import {
  assignOrgFields,
  createCostCenter,
  createDepartment,
  createJobProfile,
  createShiftPosition,
  deleteCostCenter,
  deleteDepartment,
  deleteJobProfile,
  deleteShiftPosition,
  listAssociateHistory,
  listCostCenters,
  listDepartments,
  listJobProfiles,
  listOrgAssociates,
  listShiftPositions,
  updateCostCenter,
  updateDepartment,
  updateJobProfile,
  updateShiftPosition,
  type AssociateHistoryEntry,
} from '@/lib/orgApi';
import { useAuth } from '@/lib/auth';
import { hasCapability } from '@/lib/roles';
import { ApiError } from '@/lib/api';
import { useConfirm } from '@/lib/confirm';
import { fmtDateTime } from '@/lib/format';
import { AssociatePicker, type PickedAssociate } from '@/components/ui/AssociatePicker';
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
  ErrorBanner,
  Field,
  Input,
  PageHeader,
  SearchInput,
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
import { Skeleton } from '@/components/ui/Skeleton';
import { toast } from 'sonner';

type Tab = 'departments' | 'cost-centers' | 'job-profiles' | 'positions' | 'shift-positions' | 'people' | 'custom-fields';

const TAB_VALUES: readonly Tab[] = [
  'departments',
  'cost-centers',
  'job-profiles',
  'positions',
  'shift-positions',
  'people',
  'custom-fields',
];

export function OrgHome() {
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:org') : false;
  // Shared react-query cache — fetched at most once per 5 minutes app-wide.
  const {
    clients,
    isError: clientsError,
    refetch: refetchClients,
  } = useClients();
  const [clientId, setClientId] = useState<string>('');
  // ?tab= deep-link (the People-directory drawer's "Edit org assignment"
  // link lands on /org?tab=people&associateId=…). Seeded once at mount.
  const [tab, setTab] = useState<Tab>(() => {
    const t = new URLSearchParams(window.location.search).get('tab');
    return t && (TAB_VALUES as readonly string[]).includes(t)
      ? (t as Tab)
      : 'departments';
  });
  const deepLinkAssociateId = useRef(
    new URLSearchParams(window.location.search).get('associateId'),
  );
  const clientSelectRef = useRef<HTMLSelectElement>(null);
  const focusClientPicker = () => clientSelectRef.current?.focus();

  // With exactly one client there is nothing to choose — preselect it.
  useEffect(() => {
    if (clients.length === 1) {
      setClientId((prev) => prev || clients[0].id);
    }
  }, [clients]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Org structure"
        subtitle="Departments, cost centers, job profiles, and the people-to-org assignments that hold dimensional reporting and approval routing together."
        breadcrumbs={[{ label: 'Workforce' }, { label: 'Org' }]}
      />

      {clientsError && (
        <ErrorBanner>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <span>Could not load clients.</span>
            <Button size="sm" variant="outline" onClick={() => void refetchClients()}>
              Retry
            </Button>
          </div>
        </ErrorBanner>
      )}

      <Card>
        <CardContent className="p-4 flex items-center gap-3 flex-wrap">
          <span className="text-xs2 uppercase tracking-wider text-silver">
            Client
          </span>
          <Select
            ref={clientSelectRef}
            size="sm"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
          >
            <option value="">All clients</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
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
          <TabsTrigger value="shift-positions">
            <CalendarClock className="h-3.5 w-3.5" />
            Shift positions
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
          <DepartmentsTab
            clientId={clientId}
            canManage={canManage}
            onPickClient={focusClientPicker}
          />
        </TabsContent>
        <TabsContent value="cost-centers">
          <CostCentersTab
            clientId={clientId}
            canManage={canManage}
            onPickClient={focusClientPicker}
          />
        </TabsContent>
        <TabsContent value="job-profiles">
          <JobProfilesTab
            clientId={clientId}
            canManage={canManage}
            onPickClient={focusClientPicker}
          />
        </TabsContent>
        <TabsContent value="positions">
          <PositionsTab clientId={clientId} canManage={canManage} />
        </TabsContent>
        <TabsContent value="shift-positions">
          <ShiftPositionsTab
            clientId={clientId}
            canManage={canManage}
            onPickClient={focusClientPicker}
          />
        </TabsContent>
        <TabsContent value="people">
          <PeopleTab
            clientId={clientId}
            canManage={canManage}
            clients={clients}
            initialAssociateId={deepLinkAssociateId.current}
          />
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
  onPickClient,
}: {
  clientId: string;
  canManage: boolean;
  onPickClient: () => void;
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
      {error && (
        <ErrorBanner className="mb-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <span>{error}</span>
            <Button size="sm" variant="outline" onClick={() => void refresh()}>
              Retry
            </Button>
          </div>
        </ErrorBanner>
      )}
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
            !clientId ? (
              <Button variant="outline" size="sm" onClick={onPickClient}>
                Choose a client
              </Button>
            ) : canManage ? (
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
              <TableHead className="hidden md:table-cell">Code</TableHead>
              <TableHead className="hidden md:table-cell">Parent</TableHead>
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
                  <TableCell className="font-medium">
                    {d.name}
                    <div className="text-xs2 text-silver/70 md:hidden">
                      {[d.code, parent?.name].filter(Boolean).join(' · ') || '—'}
                    </div>
                  </TableCell>
                  <TableCell className="text-silver hidden md:table-cell">{d.code ?? '—'}</TableCell>
                  <TableCell className="text-silver hidden md:table-cell">{parent?.name ?? '—'}</TableCell>
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
  const confirm = useConfirm();
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
        toast.success('Department created.');
      } else {
        await updateDepartment(initial!.id, {
          name: name.trim(),
          code: code.trim() || null,
          parentId: parentId || null,
          description: description.trim() || null,
        });
        toast.success('Department updated.');
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
    if (!(await confirm({ title: `Delete "${initial!.name}"?`, destructive: true }))) return;
    setSubmitting(true);
    try {
      await deleteDepartment(initial!.id);
      toast.success('Department deleted.');
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
          <Field label="Name" required>
            {(p) => (
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={120}
                disabled={!canManage}
                {...p}
              />
            )}
          </Field>
          <Field label="Code">
            {(p) => (
              <Input
                value={code ?? ''}
                onChange={(e) => setCode(e.target.value)}
                maxLength={40}
                placeholder="HRD"
                disabled={!canManage}
                {...p}
              />
            )}
          </Field>
          <Field label="Parent department">
            {(p) => (
              <Select
                value={parentId ?? ''}
                onChange={(e) => setParentId(e.target.value)}
                disabled={!canManage}
                {...p}
              >
                <option value="">— None (top-level) —</option>
                {allDepartments
                  .filter((d) => !isNew && d.id !== initial!.id)
                  .map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
          <Field label="Description">
            {(p) => (
              <Input
                value={description ?? ''}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={500}
                disabled={!canManage}
                {...p}
              />
            )}
          </Field>
          {error && <ErrorBanner>{error}</ErrorBanner>}
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
  onPickClient,
}: {
  clientId: string;
  canManage: boolean;
  onPickClient: () => void;
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
      {error && (
        <ErrorBanner className="mb-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <span>{error}</span>
            <Button size="sm" variant="outline" onClick={() => void refresh()}>
              Retry
            </Button>
          </div>
        </ErrorBanner>
      )}
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
            !clientId ? (
              <Button variant="outline" size="sm" onClick={onPickClient}>
                Choose a client
              </Button>
            ) : canManage ? (
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
  const confirm = useConfirm();
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
        toast.success('Cost center created.');
      } else {
        await updateCostCenter(initial!.id, {
          code: code.trim(),
          name: name.trim(),
          description: description.trim() || null,
        });
        toast.success('Cost center updated.');
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
    if (!(await confirm({ title: `Delete cost center ${initial!.code}?`, destructive: true }))) return;
    setSubmitting(true);
    try {
      await deleteCostCenter(initial!.id);
      toast.success('Cost center deleted.');
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
          <Field label="Code" required>
            {(p) => (
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                maxLength={40}
                placeholder="HQ-OPS"
                disabled={!canManage}
                {...p}
              />
            )}
          </Field>
          <Field label="Name" required>
            {(p) => (
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={120}
                disabled={!canManage}
                {...p}
              />
            )}
          </Field>
          <Field label="Description">
            {(p) => (
              <Input
                value={description ?? ''}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={500}
                disabled={!canManage}
                {...p}
              />
            )}
          </Field>
          {error && <ErrorBanner>{error}</ErrorBanner>}
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

// ----- Shift positions tab ------------------------------------------------
// The curated dropdown that constrains Shift.position on the scheduling
// page, so admins stop typing divergent free-text for the same role.

function ShiftPositionsTab({
  clientId,
  canManage,
  onPickClient,
}: {
  clientId: string;
  canManage: boolean;
  onPickClient: () => void;
}) {
  const [rows, setRows] = useState<ShiftPosition[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drawerTarget, setDrawerTarget] = useState<ShiftPosition | 'new' | null>(null);

  const refresh = async () => {
    try {
      setError(null);
      const res = await listShiftPositions(clientId || undefined);
      setRows(res.shiftPositions);
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
        <h2 className="text-base font-medium text-white">Shift positions</h2>
        {canManage && clientId && (
          <Button onClick={() => setDrawerTarget('new')} size="sm">
            <Plus className="h-4 w-4" />
            New position
          </Button>
        )}
      </div>
      <p className="text-sm text-silver/80 mb-4 max-w-2xl">
        The list of positions admins can pick from when creating a shift. Keeping
        it curated stops the same role being typed a dozen different ways and
        keeps scheduling reports clean.
      </p>
      {error && (
        <ErrorBanner className="mb-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <span>{error}</span>
            <Button size="sm" variant="outline" onClick={() => void refresh()}>
              Retry
            </Button>
          </div>
        </ErrorBanner>
      )}
      {!rows && <SkeletonRows count={4} rowHeight="h-12" />}
      {rows && rows.length === 0 && (
        <EmptyState
          icon={CalendarClock}
          title="No shift positions yet"
          description={
            clientId
              ? 'Add the positions schedulers should choose from (e.g. "F&D Morning Shift").'
              : 'Pick a client to manage its shift positions.'
          }
          action={
            !clientId ? (
              <Button variant="outline" size="sm" onClick={onPickClient}>
                Choose a client
              </Button>
            ) : canManage ? (
              <Button onClick={() => setDrawerTarget('new')} size="sm">
                <Plus className="h-4 w-4" />
                New position
              </Button>
            ) : undefined
          }
        />
      )}
      {rows && rows.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16 text-right">Order</TableHead>
              <TableHead>Name</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((p) => (
              <TableRow
                key={p.id}
                className="group cursor-pointer"
                onClick={(e) => {
                  const t = e.target as HTMLElement;
                  if (t.closest('button, a, input, [data-no-row-click]')) return;
                  setDrawerTarget(p);
                }}
              >
                <TableCell className="text-right tabular-nums text-silver">{p.sortOrder}</TableCell>
                <TableCell className="font-medium">{p.name}</TableCell>
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
          <ShiftPositionDrawer
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

function ShiftPositionDrawer({
  target,
  clientId,
  canManage,
  onClose,
  onSaved,
}: {
  target: ShiftPosition | 'new';
  clientId: string;
  canManage: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const confirm = useConfirm();
  const isNew = target === 'new';
  const initial = isNew ? null : target;
  const [name, setName] = useState(initial?.name ?? '');
  const [sortOrder, setSortOrder] = useState(String(initial?.sortOrder ?? ''));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) return;
    setError(null);
    setSubmitting(true);
    const order = sortOrder.trim() === '' ? undefined : Number(sortOrder);
    try {
      if (isNew) {
        await createShiftPosition({
          clientId,
          name: name.trim(),
          ...(order !== undefined && Number.isFinite(order) ? { sortOrder: order } : {}),
        });
        toast.success('Shift position created.');
      } else {
        await updateShiftPosition(initial!.id, {
          name: name.trim(),
          ...(order !== undefined && Number.isFinite(order) ? { sortOrder: order } : {}),
        });
        toast.success('Shift position updated.');
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
    if (!(await confirm({ title: `Delete "${initial!.name}"?`, destructive: true }))) return;
    setSubmitting(true);
    try {
      await deleteShiftPosition(initial!.id);
      toast.success('Shift position deleted.');
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Delete failed.');
      setSubmitting(false);
    }
  };

  return (
    <>
      <DrawerHeader>
        <DrawerTitle>{isNew ? 'New shift position' : initial!.name}</DrawerTitle>
        <DrawerDescription>
          {isNew
            ? 'This name appears in the position dropdown when scheduling a shift.'
            : 'Renaming only affects future shifts; past shifts keep the name they were saved with.'}
        </DrawerDescription>
      </DrawerHeader>
      <DrawerBody>
        <div className="space-y-3">
          <Field label="Name" required>
            {(p) => (
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={120}
                placeholder="F&D Morning Shift"
                disabled={!canManage}
                {...p}
              />
            )}
          </Field>
          <Field label="Sort order" hint="Lower numbers appear first in the dropdown.">
            {(p) => (
              <Input
                type="number"
                value={sortOrder}
                onChange={(e) => setSortOrder(e.target.value)}
                min={0}
                placeholder="Auto"
                disabled={!canManage}
                {...p}
              />
            )}
          </Field>
          {error && <ErrorBanner>{error}</ErrorBanner>}
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
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          {canManage && (
            <Button onClick={submit} disabled={submitting || !name.trim()}>
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
  onPickClient,
}: {
  clientId: string;
  canManage: boolean;
  onPickClient: () => void;
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
      {error && (
        <ErrorBanner className="mb-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <span>{error}</span>
            <Button size="sm" variant="outline" onClick={() => void refresh()}>
              Retry
            </Button>
          </div>
        </ErrorBanner>
      )}
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
            !clientId ? (
              <Button variant="outline" size="sm" onClick={onPickClient}>
                Choose a client
              </Button>
            ) : canManage ? (
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
              <TableHead className="hidden md:table-cell">Family</TableHead>
              <TableHead className="hidden md:table-cell">Level</TableHead>
              <TableHead className="hidden lg:table-cell">FLSA</TableHead>
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
                <TableCell>
                  {j.title}
                  <div className="text-xs2 text-silver/70 md:hidden">
                    {[j.family, j.level].filter(Boolean).join(' · ') || '—'}
                  </div>
                </TableCell>
                <TableCell className="text-silver hidden md:table-cell">{j.family ?? '—'}</TableCell>
                <TableCell className="text-silver hidden md:table-cell">{j.level ?? '—'}</TableCell>
                <TableCell className="hidden lg:table-cell">
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
  const confirm = useConfirm();
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
        toast.success('Job profile created.');
      } else {
        await updateJobProfile(initial!.id, {
          code: code.trim(),
          title: title.trim(),
          family: family.trim() || null,
          level: level.trim() || null,
          isExempt,
          description: description.trim() || null,
        });
        toast.success('Job profile updated.');
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
    if (!(await confirm({ title: `Delete job profile ${initial!.code}?`, destructive: true }))) return;
    setSubmitting(true);
    try {
      await deleteJobProfile(initial!.id);
      toast.success('Job profile deleted.');
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
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Code" required>
              {(p) => (
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  maxLength={40}
                  placeholder="LINE_COOK"
                  disabled={!canManage}
                  {...p}
                />
              )}
            </Field>
            <Field label="Level">
              {(p) => (
                <Input
                  value={level ?? ''}
                  onChange={(e) => setLevel(e.target.value)}
                  maxLength={40}
                  placeholder="L2"
                  disabled={!canManage}
                  {...p}
                />
              )}
            </Field>
          </div>
          <Field label="Title" required>
            {(p) => (
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={120}
                disabled={!canManage}
                {...p}
              />
            )}
          </Field>
          <Field label="Family">
            {(p) => (
              <Input
                value={family ?? ''}
                onChange={(e) => setFamily(e.target.value)}
                maxLength={80}
                placeholder="Kitchen"
                disabled={!canManage}
                {...p}
              />
            )}
          </Field>
          <label className="text-sm text-white flex items-center gap-2">
            <input
              type="checkbox"
              checked={isExempt}
              onChange={(e) => setIsExempt(e.target.checked)}
              disabled={!canManage}
            />
            FLSA exempt (salaried, no overtime)
          </label>
          <Field label="Description">
            {(p) => (
              <Input
                value={description ?? ''}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={500}
                disabled={!canManage}
                {...p}
              />
            )}
          </Field>
          {error && <ErrorBanner>{error}</ErrorBanner>}
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
  initialAssociateId,
}: {
  clientId: string;
  canManage: boolean;
  clients: ClientSummary[];
  initialAssociateId: string | null;
}) {
  const [rows, setRows] = useState<AssociateOrgSummary[] | null>(null);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [costCenters, setCostCenters] = useState<CostCenter[]>([]);
  const [jobProfiles, setJobProfiles] = useState<JobProfile[]>([]);
  const [target, setTarget] = useState<AssociateOrgSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Client-side name/email filter over the loaded rows, debounced so
  // typing doesn't re-filter a 1000-row list on every keystroke.
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(id);
  }, [search]);
  // ?associateId= deep-link (from the People-directory drawer). Consumed
  // once when the first row set arrives.
  const deepLinkConsumed = useRef(false);

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

  // Auto-open the drawer for a deep-linked associate once rows land.
  useEffect(() => {
    if (!initialAssociateId || deepLinkConsumed.current || !rows) return;
    deepLinkConsumed.current = true;
    const match = rows.find((a) => a.id === initialAssociateId);
    if (match) setTarget(match);
    else toast.error('That associate is not in the current client view.');
  }, [initialAssociateId, rows]);

  const filtered = useMemo(() => {
    if (!rows) return null;
    const q = debouncedSearch.toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (a) =>
        `${a.firstName} ${a.lastName}`.toLowerCase().includes(q) ||
        a.email.toLowerCase().includes(q),
    );
  }, [rows, debouncedSearch]);

  const clientLabel = clients.find((c) => c.id === clientId)?.name ?? 'All clients';

  return (
    <section>
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <h2 className="text-base font-medium text-white">
          Associates · {clientLabel}
        </h2>
        <div className="flex items-center gap-3">
          {rows && filtered && (
            <span className="text-xs text-silver tabular-nums">
              {debouncedSearch
                ? `${filtered.length} of ${rows.length}`
                : rows.length}{' '}
              associate{(debouncedSearch ? filtered.length : rows.length) === 1 ? '' : 's'}
            </span>
          )}
          <SearchInput
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name or email"
            className="h-8 text-sm w-56"
            aria-label="Search associates"
          />
        </div>
      </div>
      {error && (
        <ErrorBanner className="mb-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <span>{error}</span>
            <Button size="sm" variant="outline" onClick={() => void refresh()}>
              Retry
            </Button>
          </div>
        </ErrorBanner>
      )}
      {!rows && <SkeletonRows count={6} rowHeight="h-14" />}
      {rows && rows.length === 0 && (
        <EmptyState
          icon={Users}
          title="No associates"
          description="Once associates are onboarded for the selected client, they'll appear here for org-field assignment."
        />
      )}
      {rows && filtered && rows.length > 0 && filtered.length === 0 && (
        <EmptyState
          icon={Users}
          title="No associates match"
          description="Try a different name or email."
          action={
            <Button variant="outline" size="sm" onClick={() => setSearch('')}>
              Clear search
            </Button>
          }
        />
      )}
      {filtered && filtered.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Associate</TableHead>
              <TableHead className="hidden md:table-cell">Manager</TableHead>
              <TableHead className="hidden md:table-cell">Department</TableHead>
              <TableHead className="hidden lg:table-cell">Cost ctr</TableHead>
              <TableHead>Job profile</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((a) => (
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
                    <Avatar src={a.photoUrl} name={`${a.firstName} ${a.lastName}`} email={a.email} size="sm" />
                    <div className="min-w-0">
                      <span>{a.firstName} {a.lastName}</span>
                      <div className="text-xs2 text-silver/70 md:hidden">
                        {[a.managerName, a.departmentName].filter(Boolean).join(' · ') || '—'}
                      </div>
                    </div>
                  </div>
                </TableCell>
                <TableCell className="text-silver hidden md:table-cell">{a.managerName ?? '—'}</TableCell>
                <TableCell className="text-silver hidden md:table-cell">{a.departmentName ?? '—'}</TableCell>
                <TableCell className="text-silver tabular-nums hidden lg:table-cell">
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
  onClose,
  onSaved,
}: {
  associate: AssociateOrgSummary;
  canManage: boolean;
  departments: Department[];
  costCenters: CostCenter[];
  jobProfiles: JobProfile[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [manager, setManager] = useState<PickedAssociate | null>(
    associate.managerId
      ? { id: associate.managerId, name: associate.managerName ?? 'Current manager' }
      : null,
  );
  const [departmentId, setDepartmentId] = useState(associate.departmentId ?? '');
  const [costCenterId, setCostCenterId] = useState(associate.costCenterId ?? '');
  const [jobProfileId, setJobProfileId] = useState(associate.jobProfileId ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<AssociateHistoryEntry[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyRetry, setHistoryRetry] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setHistory(null);
    setHistoryError(null);
    listAssociateHistory(associate.id)
      .then((res) => {
        if (!cancelled) setHistory(res.history);
      })
      .catch((err) => {
        if (!cancelled) {
          setHistoryError(
            err instanceof ApiError ? err.message : 'Could not load history.',
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [associate.id, historyRetry]);

  const submit = async () => {
    setError(null);
    setSubmitting(true);
    try {
      await assignOrgFields(associate.id, {
        managerId: manager?.id ?? null,
        departmentId: departmentId || null,
        costCenterId: costCenterId || null,
        jobProfileId: jobProfileId || null,
      });
      toast.success('Org assignment updated.');
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
            src={associate.photoUrl}
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
          <Field label="Manager">
            {() =>
              canManage ? (
                <AssociatePicker
                  value={manager}
                  onChange={(v) => {
                    if (v && v.id === associate.id) {
                      toast.error('An associate cannot manage themselves.');
                      return;
                    }
                    setManager(v);
                  }}
                  placeholder="Search for a manager…"
                />
              ) : (
                <div className="rounded-md border border-navy-secondary bg-navy px-3 py-2 text-sm text-white">
                  {manager?.name ?? '—'}
                </div>
              )
            }
          </Field>
          <Field label="Department">
            {(p) => (
              <Select
                value={departmentId}
                onChange={(e) => setDepartmentId(e.target.value)}
                disabled={!canManage}
                {...p}
              >
                <option value="">—</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Cost center">
            {(p) => (
              <Select
                value={costCenterId}
                onChange={(e) => setCostCenterId(e.target.value)}
                disabled={!canManage}
                {...p}
              >
                <option value="">—</option>
                {costCenters.map((c) => (
                  <option key={c.id} value={c.id}>{c.code} · {c.name}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Job profile">
            {(p) => (
              <Select
                value={jobProfileId}
                onChange={(e) => setJobProfileId(e.target.value)}
                disabled={!canManage}
                {...p}
              >
                <option value="">—</option>
                {jobProfiles.map((j) => (
                  <option key={j.id} value={j.id}>{j.code} · {j.title}</option>
                ))}
              </Select>
            )}
          </Field>
          {error && <ErrorBanner>{error}</ErrorBanner>}

          <div className="pt-3 border-t border-navy-secondary">
            <div className="text-2xs uppercase tracking-widest text-silver/80 mb-2">
              Effective changes
            </div>
            {historyError && (
              <ErrorBanner className="mb-2">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <span>{historyError}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setHistoryRetry((n) => n + 1)}
                  >
                    Retry
                  </Button>
                </div>
              </ErrorBanner>
            )}
            {history === null && !historyError && (
              <div className="space-y-1.5">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
              </div>
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
                          {fmtDateTime(h.effectiveFrom)}
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
