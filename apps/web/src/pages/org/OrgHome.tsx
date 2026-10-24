import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowDown, ArrowUp, Briefcase, Building2, CalendarClock, FolderTree, GripVertical, Hash, Plus, Sparkles, Trash2 } from '@/components/ui/icons';
import { OrgAssignmentDrawer } from './OrgAssignmentDrawer';
import { PositionsTab } from './PositionsTab';
import { CustomFieldsTab } from './CustomFieldsTab';
import type {
  ClientSummary,
  CostCenter,
  Department,
  JobProfile,
  ShiftPosition,
} from '@alto-people/shared';
import { useClients } from '@/lib/useClients';
import {
  createCostCenter,
  createDepartment,
  createJobProfile,
  createShiftPosition,
  deleteCostCenter,
  deleteDepartment,
  deleteJobProfile,
  deleteShiftPosition,
  listCostCenters,
  listDepartments,
  listJobProfiles,
  listShiftPositions,
  updateCostCenter,
  updateDepartment,
  updateJobProfile,
  updateShiftPosition,
} from '@/lib/orgApi';
import { DepartmentTree } from './DepartmentTree';
import { useAuth, useTenant, useTerm } from '@/lib/auth';
import { boundedClientOf, hasCapability } from '@/lib/roles';
import { ApiError } from '@/lib/api';
import { useConfirm } from '@/lib/confirm';
import { useStoreScope } from '@/lib/storeScope';
import { usePersistentState } from '@/lib/usePersistentState';
import { useUrlParam } from '@/lib/useUrlState';
import { cn } from '@/lib/cn';
import {
  Badge,
  Button,
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
  Select,
  SkeletonRows,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui';
import { DataGrid } from '@/components/ui/DataGrid';
import { ListTemplate } from '@/components/templates';
import { toast } from 'sonner';

type Tab = 'departments' | 'cost-centers' | 'job-profiles' | 'positions' | 'shift-positions' | 'custom-fields';

const TAB_VALUES: readonly Tab[] = [
  'departments',
  'cost-centers',
  'job-profiles',
  'positions',
  'shift-positions',
  'custom-fields',
];

export function OrgHome() {
  const { user } = useAuth();
  const term = useTerm();
  const navigate = useNavigate();
  const hasClients = useTenant().moduleOn('clientPortal');
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
  // ?tab= lives in the URL — shareable, and Back returns to the tab you
  // came from. A staffing company runs on the shift roles each client
  // staffs: they lead. A direct employer starts at its departments.
  const defaultTab: Tab = hasClients ? 'shift-positions' : 'departments';
  const [tab, setTab] = useUrlParam<Tab>('tab', defaultTab, TAB_VALUES, { history: 'push' });
  // The People tab is gone (People is the one list of people), but its
  // deep link stays: `?tab=people&associateId=…` — a person's record and
  // the People directory's "Edit org assignment" — opens that person's org
  // assignment here; a bare `?tab=people` goes to People.
  const [searchParams] = useSearchParams();
  const legacyPeopleTab = searchParams.get('tab') === 'people';
  const editAssociateId = legacyPeopleTab ? searchParams.get('associateId') : null;
  const closeAssignment = () => {
    // Back to where the edit was opened from (the person's record), else to it.
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate(editAssociateId ? `/people/${editAssociateId}` : '/people', { replace: true });
  };

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

  const clientSelectRef = useRef<HTMLSelectElement>(null);
  const focusClientPicker = () => clientSelectRef.current?.focus();

  if (legacyPeopleTab && !editAssociateId) return <Navigate to="/people" replace />;

  return (
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    <ListTemplate
        title="Departments & job profiles"
        subtitle={
          hasClients
            ? `The shift roles each ${term('label.client').toLowerCase()} staffs, and the departments, job profiles and positions behind reporting and approvals.`
            : 'Departments, job profiles and positions — the dimensions behind reporting and approvals.'
        }
    >

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

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        {/* The client is a filter of the tab row, not a card of its own; it
            follows the top bar's store scope both ways. */}
        <div className="flex flex-wrap-reverse items-end gap-x-4 gap-y-3 border-b border-navy-secondary">
          <TabsList className="min-w-0 flex-1 border-b-0">
            {hasClients && (
              <TabsTrigger value="shift-positions">
                <CalendarClock className="h-3.5 w-3.5" />
                Shift roles
              </TabsTrigger>
            )}
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
            {!hasClients && (
              <TabsTrigger value="shift-positions">
                <CalendarClock className="h-3.5 w-3.5" />
                Shift roles
              </TabsTrigger>
            )}
            <TabsTrigger value="custom-fields">
              <Sparkles className="h-3.5 w-3.5" />
              Custom fields
            </TabsTrigger>
          </TabsList>
          {hasClients && (
            <label className="flex basis-full items-center gap-2 text-sm text-ink-muted sm:basis-auto sm:shrink-0 sm:pb-2 [&>div]:min-w-0 [&>div]:flex-1 sm:[&>div]:flex-none">
              <span>{term('label.client')}</span>
              <Select
                ref={clientSelectRef}
                size="sm"
                aria-label={`Filter by ${term('label.client').toLowerCase()}`}
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                disabled={!!boundedClientId}
              >
                <option value="">Every {term('label.client').toLowerCase()}</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </label>
          )}
        </div>
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
            clients={clients}
            canManage={canManage}
            onPickClient={focusClientPicker}
          />
        </TabsContent>
        <TabsContent value="custom-fields">
          <CustomFieldsTab clientId={clientId} canManage={canManage} />
        </TabsContent>
      </Tabs>
      <OrgAssignmentDrawer associateId={editAssociateId} canManage={canManage} onClose={closeAssignment} />
    </ListTemplate>
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
  const term = useTerm();
  // A direct employer has no clients: its departments are the company's own.
  const hasClients = useTenant().moduleOn('clientPortal');
  const canAdd = canManage && (!!clientId || !hasClients);

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
        <h2 className="text-base font-medium text-ink">Departments</h2>
        {canAdd && (
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
            !hasClients || clientId
              ? 'Create a department to start organizing.'
              : `Pick a ${term('label.client').toLowerCase()} to start adding departments.`
          }
          action={
            hasClients && !clientId ? (
              <Button variant="outline" size="sm" onClick={onPickClient}>
                Choose a {term('label.client').toLowerCase()}
              </Button>
            ) : canAdd ? (
              <Button onClick={() => setDrawerTarget('new')} size="sm">
                <Plus className="h-4 w-4" />
                New department
              </Button>
            ) : undefined
          }
        />
      )}
      {rows && rows.length > 0 && <DepartmentTree rows={rows} onOpen={(d) => setDrawerTarget(d)} />}

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
          clientId: clientId || null,
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
  const term = useTerm();
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
            { key: 'associates', header: term('workers'), accessor: (c) => c.associateCount, sortable: true, searchable: false, align: 'right', className: 'tabular-nums' },
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

// ----- Shift roles tab (Shift positions in the API) -----------------------
//
// "Shift roles", not "Shift positions": the Positions tab is the headcount
// seat (a job profile, budgeted and filled); a shift role is the label a
// scheduler picks for a shift. One word, one meaning.

function ShiftPositionsTab({
  clientId,
  clients,
  canManage,
  onPickClient,
}: {
  clientId: string;
  clients: ClientSummary[];
  canManage: boolean;
  onPickClient: () => void;
}) {
  const qc = useQueryClient();
  const [drawerTarget, setDrawerTarget] = useState<ShiftPosition | 'new' | null>(null);
  const queryKey = ['org', 'shift-positions', clientId];
  const listQuery = useQuery({
    queryKey,
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
  const clientName = (id: string) => clients.find((c) => c.id === id)?.name ?? '';
  // The order is the order schedulers see in the shift dialog. It is set by
  // moving rows (drag, or the arrows from the keyboard and on a phone) —
  // never typed as a number. Only within one client: each client has its own list.
  const canReorder = canManage && !!clientId && (rows?.length ?? 0) > 1;
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const reorder = useMutation({
    mutationFn: async (next: ShiftPosition[]) => {
      const changed = next.map((p, i) => ({ p, i })).filter(({ p, i }) => p.sortOrder !== i);
      await Promise.all(changed.map(({ p, i }) => updateShiftPosition(p.id, { sortOrder: i })));
    },
    onMutate: async (next) => {
      await qc.cancelQueries({ queryKey });
      const prev = qc.getQueryData(queryKey);
      qc.setQueryData(queryKey, { shiftPositions: next.map((p, i) => ({ ...p, sortOrder: i })) });
      return { prev };
    },
    onError: (err, _next, ctx) => {
      if (ctx?.prev) qc.setQueryData(queryKey, ctx.prev);
      toast.error(err instanceof ApiError ? err.message : 'Could not save the new order.');
    },
    onSettled: () => void qc.invalidateQueries({ queryKey }),
  });
  const move = (from: number, to: number) => {
    if (!rows || from === to || to < 0 || to >= rows.length) return;
    const next = [...rows];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    reorder.mutate(next);
  };

  return (
    <section>
      <div className="flex items-center justify-between gap-3 mb-4">
        <h2 className="text-base font-medium text-white">Shift roles</h2>
        {canManage && clientId && (
          <Button onClick={() => setDrawerTarget('new')} size="sm">
            <Plus className="h-4 w-4" />
            New shift role
          </Button>
        )}
      </div>
      <p className="text-sm text-silver/80 mb-4 max-w-2xl">
        The roles schedulers pick from when they create a shift, in the order
        they see them. A short list stops the same role being typed a dozen
        ways and keeps scheduling reports clean.
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
          title="No shift roles yet"
          description={
            clientId
              ? 'Add the roles schedulers should choose from (e.g. "F&D Morning Shift").'
              : 'Pick a client to set up its shift roles.'
          }
          action={
            !clientId ? (
              <Button variant="outline" size="sm" onClick={onPickClient}>
                Choose a client
              </Button>
            ) : canManage ? (
              <Button onClick={() => setDrawerTarget('new')} size="sm">
                <Plus className="h-4 w-4" />
                New shift role
              </Button>
            ) : undefined
          }
        />
      )}
      {rows && rows.length > 0 && (
        <>
          <ol
            className="divide-y divide-navy-secondary overflow-hidden rounded-lg border border-navy-secondary"
            aria-label="Shift roles, in the order schedulers see them"
          >
            {rows.map((pos, i) => (
              <li
                key={pos.id}
                data-testid="shift-role-row"
                className={cn(
                  'flex items-center gap-2 bg-surface px-2 py-1.5 sm:px-3',
                  overId === pos.id && dragId !== pos.id && 'ring-2 ring-inset ring-accent',
                  dragId === pos.id && 'opacity-50',
                )}
                onDragOver={
                  canReorder && dragId
                    ? (e) => {
                        e.preventDefault();
                        if (overId !== pos.id) setOverId(pos.id);
                      }
                    : undefined
                }
                onDrop={
                  canReorder && dragId
                    ? (e) => {
                        e.preventDefault();
                        const from = rows.findIndex((r) => r.id === dragId);
                        setDragId(null);
                        setOverId(null);
                        move(from, i);
                      }
                    : undefined
                }
              >
                {canReorder && (
                  <span
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = 'move';
                      e.dataTransfer.setData('text/plain', pos.id);
                      setDragId(pos.id);
                    }}
                    onDragEnd={() => {
                      setDragId(null);
                      setOverId(null);
                    }}
                    className="hidden cursor-grab touch-none text-ink-muted active:cursor-grabbing md:inline-flex"
                    title="Drag to reorder"
                    aria-hidden="true"
                  >
                    <GripVertical className="h-4 w-4" />
                  </span>
                )}
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate py-1.5 text-left text-sm font-medium text-ink hover:underline"
                  onClick={() => setDrawerTarget(pos)}
                >
                  {pos.name}
                  {!clientId && clientName(pos.clientId) && (
                    <span className="font-normal text-ink-muted"> · {clientName(pos.clientId)}</span>
                  )}
                </button>
                {pos.isLead && (
                  <Badge size="sm" variant="outline">
                    Lead
                  </Badge>
                )}
                {canReorder && (
                  <span className="flex shrink-0 items-center">
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Move ${pos.name} up`}
                      disabled={i === 0 || reorder.isPending}
                      onClick={() => move(i, i - 1)}
                    >
                      <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Move ${pos.name} down`}
                      disabled={i === rows.length - 1 || reorder.isPending}
                      onClick={() => move(i, i + 1)}
                    >
                      <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
                    </Button>
                  </span>
                )}
              </li>
            ))}
          </ol>
          <p className="mt-2 text-xs text-ink-muted">
            {canReorder
              ? 'Drag a role, or use its arrows, to change the order schedulers see.'
              : canManage && !clientId
                ? 'Pick a client to add roles or change their order.'
                : null}
          </p>
        </>
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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) return;
    setError(null);
    setSubmitting(true);
    try {
      if (isNew) {
        // A new role goes to the end of the list; move it from the list.
        await createShiftPosition({ clientId, name: name.trim() });
        toast.success('Shift role created.');
      } else {
        await updateShiftPosition(initial!.id, { name: name.trim() });
        toast.success('Shift role updated.');
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
      toast.success('Shift role deleted.');
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
        <DrawerTitle>{isNew ? 'New shift role' : initial!.name}</DrawerTitle>
        <DrawerDescription>
          {isNew
            ? 'Schedulers pick this name when they create a shift. It goes to the end of the list.'
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
  const term = useTerm();
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
            { key: 'associates', header: term('workers'), accessor: (j) => j.associateCount, sortable: true, searchable: false, align: 'right', className: 'tabular-nums' },
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
  const [tippedCode, setTippedCode] = useState(initial?.tippedOccupationCode ?? '');
  const tippedCodeError = tippedCode.trim() && !/^\d{3}$/.test(tippedCode.trim()) ? 'Use the three-digit code from the Treasury list.' : null;
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!code.trim() || !title.trim() || tippedCodeError) return;
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
          tippedOccupationCode: tippedCode.trim() || null,
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
          tippedOccupationCode: tippedCode.trim() || null,
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
          <Field
            label="Tipped occupation code"
            hint="For jobs that customarily get tips. Printed in box 14b of the W-2 from 2026 with the tips in box 12 TP."
            error={tippedCodeError}
          >
            {(p) => (
              <Input
                value={tippedCode}
                onChange={(e) => setTippedCode(e.target.value.replace(/\D/g, '').slice(0, 3))}
                inputMode="numeric"
                maxLength={3}
                placeholder="e.g. 101"
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
