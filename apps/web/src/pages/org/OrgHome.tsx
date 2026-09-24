import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
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
import { boundedClientOf, hasCapability } from '@/lib/roles';
import { ApiError } from '@/lib/api';
import { useConfirm } from '@/lib/confirm';
import { useStoreScope } from '@/lib/storeScope';
import { usePersistentState } from '@/lib/usePersistentState';
import { useSelection } from '@/lib/useSelection';
import { fmtDateTime } from '@/lib/format';
import { AssociatePicker, type PickedAssociate } from '@/components/ui/AssociatePicker';
import { AssociateLink } from '@/components/ui/AssociateLink';
import {
  Avatar,
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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui';
import { DataGrid } from '@/components/ui/DataGrid';
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
  // Client pick used to be plain state that reset to "All clients" on every
  // visit (the auto-preselect only fired with exactly one client). It now
  // persists across visits AND syncs both ways with the global Topbar store
  // scope, same contract as AdminTimeView: a set scope seeds the page on
  // entry, later scope changes follow, and page-level changes write back so
  // Scheduling/Time/Labor stay on the same store. Bounded roles are pinned
  // to their clamp.
  const boundedClientId = boundedClientOf(user)?.id ?? '';
  const storeScope = useStoreScope();
  const [pageClientId, setPageClientId] = usePersistentState<string>(
    'alto:list.org.client.v1',
    '',
    (v): v is string => typeof v === 'string',
  );
  const scopeClientId =
    storeScope.enabled && !boundedClientId ? storeScope.clientId : null;
  const scopeSyncedRef = useRef(false);
  useEffect(() => {
    if (scopeClientId === null) return;
    if (!scopeSyncedRef.current) {
      scopeSyncedRef.current = true;
      // On entry a set scope wins over the persisted page pick.
      if (scopeClientId) setPageClientId(scopeClientId);
      return;
    }
    setPageClientId((prev) => (prev === scopeClientId ? prev : scopeClientId));
  }, [scopeClientId, setPageClientId]);
  const clientId = boundedClientId || pageClientId;
  const setClientId = (id: string) => {
    setPageClientId(id);
    // No-op when the scope is disabled (bounded roles / signed-out).
    storeScope.setClientId(id);
  };
  // ?tab= lives in the URL — shareable, and tab changes replace (not push)
  // so Back leaves the page instead of retracing every tab flip. The
  // People-directory drawer's "Edit org assignment" link lands on
  // /org?tab=people&associateId=….
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const tab: Tab =
    tabParam && (TAB_VALUES as readonly string[]).includes(tabParam)
      ? (tabParam as Tab)
      : 'departments';
  const setTab = (next: Tab) => {
    const params = new URLSearchParams(searchParams);
    if (next === 'departments') params.delete('tab');
    else params.set('tab', next);
    setSearchParams(params, { replace: true });
  };
  const deepLinkAssociateId = useRef(
    new URLSearchParams(window.location.search).get('associateId'),
  );
  const clientSelectRef = useRef<HTMLSelectElement>(null);
  const focusClientPicker = () => clientSelectRef.current?.focus();

  // With exactly one client there is nothing to choose — preselect it.
  useEffect(() => {
    if (clients.length === 1) {
      setPageClientId((prev) => prev || clients[0].id);
    }
  }, [clients, setPageClientId]);

  // A persisted client that has since been removed falls back to "All".
  useEffect(() => {
    if (!pageClientId || clients.length === 0) return;
    if (!clients.some((c) => c.id === pageClientId)) setPageClientId('');
  }, [clients, pageClientId, setPageClientId]);

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
            aria-label="Filter by client"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            disabled={!!boundedClientId}
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
  const [drawerTarget, setDrawerTarget] = useState<Department | 'new' | null>(null);

  const listQuery = useQuery({
    queryKey: ['org', 'departments', clientId],
    queryFn: () => listDepartments(clientId || undefined),
  });
  const rows: Department[] | null = listQuery.data?.departments ?? null;
  const error = listQuery.error
    ? listQuery.error instanceof ApiError
      ? listQuery.error.message
      : 'Failed to load.'
    : null;
  const refresh = async () => {
    await listQuery.refetch();
  };

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
      {!rows && !error && <SkeletonRows count={4} rowHeight="h-12" />}
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
        <DataGrid<NonNullable<typeof rows>[number]>
          id="org-departments"
          caption="Departments"
          rows={rows}
          rowKey={(d) => d.id}
          search={{ placeholder: 'Name, code…' }}
          urlState={false}
          exportCsv={{ filename: 'departments' }}
          onRowClick={(d) => setDrawerTarget(d)}
          rowActionLabel={(d) => `Open ${d.name}`}
          columns={[
            { key: 'name', header: 'Name', accessor: (d) => d.name, sortable: true, primary: true, className: 'font-medium' },
            { key: 'code', header: 'Code', accessor: (d) => d.code, sortable: true, cardMeta: true, className: 'text-silver', cell: (d) => d.code ?? '—' },
            { key: 'parent', header: 'Parent', accessor: (d) => (rows ?? []).find((pd) => pd.id === d.parentId)?.name ?? null, sortable: true, cardMeta: true, className: 'text-silver', cell: (d) => (rows ?? []).find((pd) => pd.id === d.parentId)?.name ?? '—' },
            { key: 'associates', header: 'Associates', accessor: (d) => d.associateCount, sortable: true, searchable: false, align: 'right', className: 'tabular-nums' },
          ]}
        />
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
    // Form-wrapped so Enter in any field saves (same rules as the Save
    // button). flex classes mirror the Drawer column layout the fragment
    // used to inherit, keeping DrawerBody's internal scroll working.
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!canManage || submitting) return;
        void submit();
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
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
            type="button"
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
          <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          {canManage && (
            <Button type="submit" loading={submitting} disabled={!name.trim()}>
              {isNew ? 'Create' : 'Save'}
            </Button>
          )}
        </div>
      </DrawerFooter>
    </form>
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
  const [drawerTarget, setDrawerTarget] = useState<CostCenter | 'new' | null>(null);

  const listQuery = useQuery({
    queryKey: ['org', 'cost-centers', clientId],
    queryFn: () => listCostCenters(clientId || undefined),
  });
  const rows: CostCenter[] | null = listQuery.data?.costCenters ?? null;
  const error = listQuery.error
    ? listQuery.error instanceof ApiError
      ? listQuery.error.message
      : 'Failed to load.'
    : null;
  const refresh = async () => {
    await listQuery.refetch();
  };

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
      {!rows && !error && <SkeletonRows count={4} rowHeight="h-12" />}
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
        <DataGrid<NonNullable<typeof rows>[number]>
          id="org-cost-centers"
          caption="Cost centers"
          rows={rows}
          rowKey={(c) => c.id}
          search={{ placeholder: 'Code, name…' }}
          urlState={false}
          exportCsv={{ filename: 'cost-centers' }}
          onRowClick={(c) => setDrawerTarget(c)}
          rowActionLabel={(c) => `Open ${c.name}`}
          columns={[
            { key: 'code', header: 'Code', accessor: (c) => c.code, sortable: true, cardMeta: true, className: 'font-medium tabular-nums' },
            { key: 'name', header: 'Name', accessor: (c) => c.name, sortable: true, primary: true },
            { key: 'associates', header: 'Associates', accessor: (c) => c.associateCount, sortable: true, searchable: false, align: 'right', className: 'tabular-nums' },
          ]}
        />
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
    // Form-wrapped so Enter saves — see DepartmentDrawerContent.
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!canManage || submitting) return;
        void submit();
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
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
            type="button"
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
          <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          {canManage && (
            <Button
              type="submit"
              loading={submitting}
              disabled={!code.trim() || !name.trim()}
            >
              {isNew ? 'Create' : 'Save'}
            </Button>
          )}
        </div>
      </DrawerFooter>
    </form>
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
  const [drawerTarget, setDrawerTarget] = useState<ShiftPosition | 'new' | null>(null);

  const listQuery = useQuery({
    queryKey: ['org', 'shift-positions', clientId],
    queryFn: () => listShiftPositions(clientId || undefined),
  });
  const rows: ShiftPosition[] | null = listQuery.data?.shiftPositions ?? null;
  const error = listQuery.error
    ? listQuery.error instanceof ApiError
      ? listQuery.error.message
      : 'Failed to load.'
    : null;
  const refresh = async () => {
    await listQuery.refetch();
  };

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
      {!rows && !error && <SkeletonRows count={4} rowHeight="h-12" />}
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
        <DataGrid<NonNullable<typeof rows>[number]>
          id="org-positions"
          caption="Positions"
          rows={rows}
          rowKey={(pos) => pos.id}
          search={{ placeholder: 'Position…' }}
          urlState={false}
          exportCsv={{ filename: 'positions' }}
          onRowClick={(pos) => setDrawerTarget(pos)}
          rowActionLabel={(pos) => `Open ${pos.name}`}
          columns={[
            { key: 'order', header: 'Order', accessor: (pos) => pos.sortOrder, sortable: true, searchable: false, align: 'right', cardMeta: true, width: '4rem', className: 'tabular-nums text-silver' },
            { key: 'name', header: 'Name', accessor: (pos) => pos.name, sortable: true, primary: true, className: 'font-medium' },
          ]}
        />
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
    // Form-wrapped so Enter saves — see DepartmentDrawerContent.
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!canManage || submitting) return;
        void submit();
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
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
            type="button"
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
          <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          {canManage && (
            <Button type="submit" disabled={submitting || !name.trim()}>
              {isNew ? 'Create' : 'Save'}
            </Button>
          )}
        </div>
      </DrawerFooter>
    </form>
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
  const [drawerTarget, setDrawerTarget] = useState<JobProfile | 'new' | null>(null);

  const listQuery = useQuery({
    queryKey: ['org', 'job-profiles', clientId],
    queryFn: () => listJobProfiles(clientId || undefined),
  });
  const rows: JobProfile[] | null = listQuery.data?.jobProfiles ?? null;
  const error = listQuery.error
    ? listQuery.error instanceof ApiError
      ? listQuery.error.message
      : 'Failed to load.'
    : null;
  const refresh = async () => {
    await listQuery.refetch();
  };

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
      {!rows && !error && <SkeletonRows count={4} rowHeight="h-12" />}
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
        <DataGrid<NonNullable<typeof rows>[number]>
          id="org-job-profiles"
          caption="Job profiles"
          rows={rows}
          rowKey={(j) => j.id}
          search={{ placeholder: 'Code, title, family…' }}
          urlState={false}
          exportCsv={{ filename: 'job-profiles' }}
          onRowClick={(j) => setDrawerTarget(j)}
          rowActionLabel={(j) => `Open ${j.title}`}
          columns={[
            { key: 'code', header: 'Code', accessor: (j) => j.code, sortable: true, cardMeta: true, className: 'font-medium tabular-nums' },
            { key: 'title', header: 'Title', accessor: (j) => j.title, sortable: true, primary: true },
            { key: 'family', header: 'Family', accessor: (j) => j.family, sortable: true, cardMeta: true, className: 'text-silver', cell: (j) => j.family ?? '—' },
            { key: 'level', header: 'Level', accessor: (j) => j.level, sortable: true, className: 'text-silver', cell: (j) => j.level ?? '—' },
            { key: 'flsa', header: 'FLSA', accessor: (j) => (j.isExempt ? 'Exempt' : 'Non-exempt'), sortable: true, searchable: false, cell: (j) => <Badge variant={j.isExempt ? 'accent' : 'default'}>{j.isExempt ? 'Exempt' : 'Non-exempt'}</Badge> },
            { key: 'associates', header: 'Associates', accessor: (j) => j.associateCount, sortable: true, searchable: false, align: 'right', className: 'tabular-nums' },
          ]}
        />
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
  const [target, setTarget] = useState<AssociateOrgSummary | null>(null);
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

  const peopleQuery = useQuery({
    queryKey: ['org', 'people', clientId],
    queryFn: async () => {
      const [a, d, c, j] = await Promise.all([
        listOrgAssociates(clientId || undefined),
        listDepartments(clientId || undefined),
        listCostCenters(clientId || undefined),
        listJobProfiles(clientId || undefined),
      ]);
      return {
        rows: a.associates,
        departments: d.departments,
        costCenters: c.costCenters,
        jobProfiles: j.jobProfiles,
      };
    },
  });
  const rows: AssociateOrgSummary[] | null = peopleQuery.data?.rows ?? null;
  const departments: Department[] = peopleQuery.data?.departments ?? [];
  const costCenters: CostCenter[] = peopleQuery.data?.costCenters ?? [];
  const jobProfiles: JobProfile[] = peopleQuery.data?.jobProfiles ?? [];
  const error = peopleQuery.error
    ? peopleQuery.error instanceof ApiError
      ? peopleQuery.error.message
      : 'Failed to load.'
    : null;
  const refresh = async () => {
    await peopleQuery.refetch();
  };

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

  // Bulk org-field assignment: checkbox a cohort, fill ONE dialog, done —
  // instead of ten drawer round-trips for a ten-person start class. The
  // selection deliberately survives search changes (build the cohort across
  // several searches); it resets when the client scope changes.
  const selectableIds = useMemo(
    () => (filtered ?? []).map((a) => a.id),
    [filtered],
  );
  const sel = useSelection(selectableIds);
  const clearSel = sel.clear;
  useEffect(() => {
    clearSel();
  }, [clientId, clearSel]);
  const [bulkOpen, setBulkOpen] = useState(false);

  const applyBulk = async (input: {
    departmentId?: string;
    costCenterId?: string;
    jobProfileId?: string;
  }) => {
    const ids = [...sel.selected];
    const results = await Promise.allSettled(
      ids.map((id) => assignOrgFields(id, input)),
    );
    const failedIds: string[] = [];
    results.forEach((r, i) => {
      if (r.status !== 'rejected') return;
      failedIds.push(ids[i]);
      const row = rows?.find((a) => a.id === ids[i]);
      toast.error(
        `${row ? `${row.firstName} ${row.lastName}` : 'Associate'}: ${
          r.reason instanceof ApiError ? r.reason.message : 'assignment failed.'
        }`,
      );
    });
    const ok = ids.length - failedIds.length;
    if (ok > 0) {
      toast.success(`Org fields assigned to ${ok} associate${ok === 1 ? '' : 's'}.`);
    }
    // Failed rows stay selected so a retry is one click away.
    sel.selectAll(failedIds);
    setBulkOpen(false);
    await refresh();
  };

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
      {!rows && !error && <SkeletonRows count={6} rowHeight="h-14" />}
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
      {canManage && sel.count > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-navy-secondary bg-navy-secondary/30 px-3 py-2 mb-3">
          <span className="text-xs text-silver tabular-nums">
            {sel.count} selected
          </span>
          <Button size="sm" variant="secondary" onClick={() => setBulkOpen(true)}>
            Assign org fields ({sel.count})…
          </Button>
          <Button variant="ghost" size="sm" onClick={sel.clear}>
            Clear selection
          </Button>
        </div>
      )}
      {filtered && filtered.length > 0 && (
        <DataGrid<NonNullable<typeof filtered>[number]>
          id="org-associates"
          caption="Associates and their org fields"
          rows={filtered}
          rowKey={(a) => a.id}
          search={false}
          urlState={false}
          exportCsv={{ filename: 'org-assignments' }}
          onRowClick={(a) => setTarget(a)}
          rowActionLabel={(a) => `Open ${a.firstName} ${a.lastName}`}
          selectable={canManage ? { selection: { selected: sel.selected, onChange: sel.replace } } : undefined}
          columns={[
            {
              key: 'associate',
              header: 'Associate',
              accessor: (a) => `${a.firstName} ${a.lastName}`,
              sortable: true,
              primary: true,
              className: 'font-medium',
              cell: (a) => (
                <div className="flex items-center gap-2.5">
                  <Avatar src={a.photoUrl} name={`${a.firstName} ${a.lastName}`} email={a.email} size="sm" />
                  <div className="min-w-0">
                    <AssociateLink associateId={a.id}>
                      {a.firstName} {a.lastName}
                    </AssociateLink>
                  </div>
                </div>
              ),
            },
            {
              key: 'manager',
              header: 'Manager',
              accessor: (a) => a.managerName,
              sortable: true,
              cardMeta: true,
              className: 'text-silver',
              cell: (a) => (a.managerName ? <AssociateLink associateId={a.managerId}>{a.managerName}</AssociateLink> : '—'),
            },
            { key: 'department', header: 'Department', accessor: (a) => a.departmentName, sortable: true, cardMeta: true, className: 'text-silver', cell: (a) => a.departmentName ?? '—' },
            { key: 'costCenter', header: 'Cost ctr', accessor: (a) => a.costCenterCode, sortable: true, className: 'text-silver tabular-nums', cell: (a) => a.costCenterCode ?? '—' },
            { key: 'jobProfile', header: 'Job profile', accessor: (a) => a.jobProfileTitle, sortable: true, cardMeta: true, className: 'text-silver', cell: (a) => a.jobProfileTitle ?? '—' },
          ]}
        />
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

      {/* Mounted per open so the "leave unchanged" defaults reset. */}
      {bulkOpen && (
        <BulkOrgFieldsDialog
          count={sel.count}
          departments={departments}
          costCenters={costCenters}
          jobProfiles={jobProfiles}
          onClose={() => setBulkOpen(false)}
          onApply={applyBulk}
        />
      )}
    </section>
  );
}

function BulkOrgFieldsDialog({
  count,
  departments,
  costCenters,
  jobProfiles,
  onClose,
  onApply,
}: {
  count: number;
  departments: Department[];
  costCenters: CostCenter[];
  jobProfiles: JobProfile[];
  onClose: () => void;
  onApply: (input: {
    departmentId?: string;
    costCenterId?: string;
    jobProfileId?: string;
  }) => Promise<void>;
}) {
  // '' = leave unchanged — omitted from the payload; the API treats an
  // omitted field as "keep the current value" (bulk never clears a field).
  const [departmentId, setDepartmentId] = useState('');
  const [costCenterId, setCostCenterId] = useState('');
  const [jobProfileId, setJobProfileId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const nothingChosen = !departmentId && !costCenterId && !jobProfileId;

  const submit = async () => {
    setSubmitting(true);
    try {
      await onApply({
        ...(departmentId ? { departmentId } : {}),
        ...(costCenterId ? { costCenterId } : {}),
        ...(jobProfileId ? { jobProfileId } : {}),
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !submitting && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Assign org fields to {count} associate{count === 1 ? '' : 's'}
          </DialogTitle>
          <DialogDescription>
            Only the fields you pick are applied — everything left on
            “Leave unchanged” keeps each associate's current value.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="Department">
            {(p) => (
              <Select
                value={departmentId}
                onChange={(e) => setDepartmentId(e.target.value)}
                {...p}
              >
                <option value="">Leave unchanged</option>
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
                {...p}
              >
                <option value="">Leave unchanged</option>
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
                {...p}
              >
                <option value="">Leave unchanged</option>
                {jobProfiles.map((j) => (
                  <option key={j.id} value={j.id}>{j.code} · {j.title}</option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={submit} loading={submitting} disabled={nothingChosen}>
            Apply to {count}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  const historyQuery = useQuery({
    queryKey: ['org', 'associate-history', associate.id],
    queryFn: () => listAssociateHistory(associate.id),
  });
  const history: AssociateHistoryEntry[] | null = historyQuery.data?.history ?? null;
  const historyError = historyQuery.error
    ? historyQuery.error instanceof ApiError
      ? historyQuery.error.message
      : 'Could not load history.'
    : null;

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
                    onClick={() => void historyQuery.refetch()}
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
