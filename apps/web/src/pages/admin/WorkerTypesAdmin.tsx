import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Plus, Users } from 'lucide-react';
import { toast } from 'sonner';
import {
  WORKER_CAPABILITIES,
  WORKER_STATUS_LABELS,
  WORKER_TYPE_LABELS,
  type WorkerStatus,
  type WorkerSummary,
  type WorkerType,
} from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import { fmtDate } from '@/lib/format';
import { listAdminUsers } from '@/lib/usersAdminApi';
import { listClientLocations, listClients } from '@/lib/clientsApi';
import {
  assignWorkerSite,
  createWorker,
  ensurePersonWorkers,
  listWorkers,
  updateWorker,
  type WorkerFilters,
} from '@/lib/workersApi';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { MetricCard } from '@/components/ui/MetricCard';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { QueryError } from '@/components/ui/QueryError';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';

/**
 * Worker types (Brief 1D-1) — people, AI agents and robots in one
 * registry. Every worker has an owner (a user who answers for it), a
 * status and a capability list. People are mirrored from the associate
 * record by the server's sweep; agents and robots are added here.
 */

type TypeFilter = 'ALL' | WorkerType;
const TYPE_OPTIONS: { value: TypeFilter; label: string }[] = [
  { value: 'ALL', label: 'All' },
  { value: 'PERSON', label: 'People' },
  { value: 'AGENT', label: 'Agents' },
  { value: 'ROBOT', label: 'Robots' },
];
const STATUSES: WorkerStatus[] = ['ONBOARDING', 'ACTIVE', 'SUSPENDED', 'OFFBOARDED'];
const STATUS_VARIANT: Record<WorkerStatus, 'pending' | 'success' | 'destructive' | 'outline'> = {
  ONBOARDING: 'pending',
  ACTIVE: 'success',
  SUSPENDED: 'destructive',
  OFFBOARDED: 'outline',
};
const TYPE_VARIANT: Record<WorkerType, 'default' | 'info' | 'accent'> = { PERSON: 'default', AGENT: 'info', ROBOT: 'accent' };
const CAP_LABEL = new Map<string, string>(WORKER_CAPABILITIES.map((c) => [c.code, c.label]));

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    const code = (err as { code?: string }).code ?? '';
    if (code === 'owner_not_eligible') return 'A client portal account cannot own a worker.';
    if (code === 'owner_not_found') return 'That owner no longer exists.';
    if (code === 'person_follows_associate') return 'A person follows their associate record. Edit the associate instead.';
    if (code === 'site_not_found') return 'That site no longer exists.';
    return err.message || fallback;
  }
  return fallback;
}

function currentSites(w: WorkerSummary) {
  return w.sites.filter((s) => s.endedAt === null);
}

/** "2 onboarding · 1 suspended" — everything that is not ACTIVE and not zero. */
function otherStatusesHint(counts: Record<WorkerStatus, number> | undefined): string {
  if (!counts) return 'Active now';
  const parts = STATUSES.filter((s) => s !== 'ACTIVE' && counts[s] > 0).map((s) => `${counts[s]} ${WORKER_STATUS_LABELS[s].toLowerCase()}`);
  return parts.length ? parts.join(' · ') : 'Active now';
}

export function WorkerTypesAdmin() {
  const { can } = useAuth();
  const canManage = can('manage:org');
  const qc = useQueryClient();
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('ALL');
  const [statusFilter, setStatusFilter] = useState<'' | WorkerStatus>('');
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [ensuring, setEnsuring] = useState(false);

  const filters: WorkerFilters = useMemo(
    () => ({ type: typeFilter === 'ALL' ? undefined : typeFilter, status: statusFilter || undefined }),
    [typeFilter, statusFilter],
  );
  // The headline numbers come from the unfiltered read so a filter never
  // changes the hero; the grid reads with the filters applied.
  const totals = useQuery({ queryKey: ['workers', 'list', {}], queryFn: () => listWorkers({}) });
  const workers = useQuery({ queryKey: ['workers', 'list', filters], queryFn: () => listWorkers(filters) });

  const withoutOwner = totals.data?.withoutOwner.length ?? 0;
  const counts = totals.data?.counts;
  const peopleMissing = totals.data?.associatesWithoutWorker ?? 0;
  const rows = workers.data?.workers ?? [];
  const editing = editingId ? (rows.find((w) => w.id === editingId) ?? totals.data?.workers.find((w) => w.id === editingId) ?? null) : null;

  const refetchAll = () => qc.invalidateQueries({ queryKey: ['workers'] });

  const onEnsure = async () => {
    setEnsuring(true);
    try {
      const { made } = await ensurePersonWorkers();
      toast.success(made === 1 ? '1 person record created.' : `${made} person records created.`);
      await refetchAll();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not create the person records.'));
    } finally {
      setEnsuring(false);
    }
  };

  const columns = useMemo<GridColumn<WorkerSummary>[]>(
    () => [
      {
        key: 'name',
        header: 'Worker',
        accessor: (w) => w.name,
        primary: true,
        sortable: true,
        searchable: true,
        cell: (w) => (
          <span className="inline-flex items-center gap-2">
            <span className="font-medium text-white">{w.name}</span>
            <Badge variant={TYPE_VARIANT[w.type]} size="sm">
              {WORKER_TYPE_LABELS[w.type]}
            </Badge>
          </span>
        ),
        csv: (w) => `${w.name} (${WORKER_TYPE_LABELS[w.type]})`,
      },
      {
        key: 'owner',
        header: 'Owner',
        accessor: (w) => w.owner?.name ?? w.owner?.email ?? '',
        sortable: true,
        searchable: true,
        cardMeta: true,
        cell: (w) =>
          w.owner ? (
            <span className="flex flex-col">
              <span>{w.owner.name || w.owner.email}</span>
              {w.owner.name && <span className="text-xs2 text-silver/70">{w.owner.email}</span>}
            </span>
          ) : (
            <Badge variant="destructive" size="sm">No owner</Badge>
          ),
        csv: (w) => (w.owner ? `${w.owner.name} <${w.owner.email}>` : ''),
      },
      {
        key: 'status',
        header: 'Status',
        accessor: (w) => WORKER_STATUS_LABELS[w.status],
        sortable: true,
        cardMeta: true,
        cell: (w) => <Badge variant={STATUS_VARIANT[w.status]}>{WORKER_STATUS_LABELS[w.status]}</Badge>,
      },
      {
        key: 'capabilities',
        header: 'Capabilities',
        accessor: (w) => w.capabilities.map((c) => CAP_LABEL.get(c) ?? c).join(', '),
        searchable: true,
        cell: (w) =>
          w.capabilities.length ? (
            <span className="flex flex-wrap gap-1">
              {w.capabilities.map((c) => (
                <Badge key={c} variant="outline" size="sm">
                  {CAP_LABEL.get(c) ?? c}
                </Badge>
              ))}
            </span>
          ) : (
            <span className="text-silver/60">—</span>
          ),
      },
      {
        key: 'sites',
        header: 'Current sites',
        accessor: (w) => currentSites(w).map((s) => `${s.clientName} — ${s.siteName}`).join(', '),
        searchable: true,
        cell: (w) => {
          const sites = currentSites(w);
          return sites.length ? (
            <span className="flex flex-col">
              {sites.map((s) => (
                <span key={`${s.locationId}-${s.startedAt}`}>{s.siteName}</span>
              ))}
            </span>
          ) : (
            <span className="text-silver/60">—</span>
          );
        },
      },
      { key: 'upcoming', header: 'Upcoming shifts', accessor: (w) => w.upcomingShifts, sortable: true, align: 'right' },
      { key: 'created', header: 'Created', accessor: (w) => w.createdAt, sortable: true, cell: (w) => fmtDate(w.createdAt) },
    ],
    [],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Worker types"
        subtitle="People, AI agents and robots in one registry. Every worker has an owner who answers for it, a status and a list of what it can do."
        primaryAction={
          canManage ? (
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" aria-hidden="true" /> Add agent or robot
            </Button>
          ) : undefined
        }
      />

      {totals.error && <QueryError what="workers" query={totals} />}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="Without an owner"
          value={totals.isLoading ? '—' : String(withoutOwner)}
          accent={withoutOwner > 0}
          hint={withoutOwner > 0 ? 'Must be zero — every worker needs an owner' : 'Every worker is owned'}
        />
        <MetricCard label="People" value={totals.isLoading ? '—' : String(counts?.PERSON.ACTIVE ?? 0)} hint={otherStatusesHint(counts?.PERSON)} />
        <MetricCard label="AI agents" value={totals.isLoading ? '—' : String(counts?.AGENT.ACTIVE ?? 0)} hint={otherStatusesHint(counts?.AGENT)} />
        <MetricCard label="Robots" value={totals.isLoading ? '—' : String(counts?.ROBOT.ACTIVE ?? 0)} hint={otherStatusesHint(counts?.ROBOT)} />
      </div>

      {peopleMissing > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-warning/30 bg-warning/10 px-4 py-3 text-sm">
          <Users className="h-4 w-4 text-warning" aria-hidden="true" />
          <span>
            People without a worker record: <strong className="tabular-nums">{peopleMissing}</strong>. The server creates them every 15 minutes.
          </span>
          {canManage && (
            <Button size="sm" variant="secondary" onClick={onEnsure} disabled={ensuring}>
              {ensuring ? 'Creating…' : 'Create them now'}
            </Button>
          )}
        </div>
      )}

      <DataGrid
        id="workers"
        caption="Workers"
        rows={rows}
        rowKey={(w) => w.id}
        loading={workers.isLoading}
        error={workers.error ? errorMessage(workers.error, 'Could not load workers.') : null}
        onRetry={() => workers.refetch()}
        search={{ placeholder: 'Search workers, owners, sites…' }}
        urlState
        exportCsv={{ filename: 'workers' }}
        columnChooser
        columns={columns}
        onRowClick={(w) => setEditingId(w.id)}
        rowActionLabel={(w) => `Open ${w.name}`}
        defaultSort={{ key: 'name', direction: 'asc' }}
        filters={
          <div className="flex flex-wrap items-center gap-3">
            <SegmentedControl ariaLabel="Worker type" options={TYPE_OPTIONS} value={typeFilter} onChange={setTypeFilter} />
            <label className="flex items-center gap-2 text-sm text-silver">
              <span className="sr-only">Status</span>
              <Select size="sm" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as '' | WorkerStatus)} aria-label="Status">
                <option value="">Any status</option>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {WORKER_STATUS_LABELS[s]}
                  </option>
                ))}
              </Select>
            </label>
          </div>
        }
        empty={{
          icon: Bot,
          title: 'No workers match',
          description: typeFilter === 'PERSON' ? 'People appear here once the sweep has mirrored each associate.' : 'Add an agent or robot to see it here.',
        }}
      />

      {creating && (
        <CreateWorkerDialog
          onClose={() => setCreating(false)}
          onCreated={async () => {
            setCreating(false);
            await refetchAll();
          }}
        />
      )}
      {editing && (
        <EditWorkerDialog
          worker={editing}
          canManage={canManage}
          onClose={() => setEditingId(null)}
          onSaved={async () => {
            await refetchAll();
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------ owners */

function useOwnerOptions() {
  // Every internal account; the portal accounts are excluded because the
  // server refuses them as owners (owner_not_eligible).
  return useQuery({
    queryKey: ['admin', 'users', 'worker-owners'],
    queryFn: () => listAdminUsers({ status: 'ACTIVE' }),
    select: (d) => d.users.filter((u) => u.role !== 'CLIENT_PORTAL').sort((a, b) => (a.associateName ?? a.email).localeCompare(b.associateName ?? b.email)),
  });
}

function OwnerSelect({ value, onChange, id, ...aria }: { value: string; onChange: (v: string) => void; id?: string; 'aria-describedby'?: string; 'aria-invalid'?: true }) {
  const owners = useOwnerOptions();
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} required {...aria}>
      <option value="">{owners.isLoading ? 'Loading owners…' : 'Choose an owner'}</option>
      {(owners.data ?? []).map((u) => (
        <option key={u.id} value={u.id}>
          {u.associateName ? `${u.associateName} — ${u.email}` : u.email}
        </option>
      ))}
    </Select>
  );
}

/* ------------------------------------------------------ capabilities */

function CapabilityPicker({ type, value, onChange }: { type: WorkerType; value: string[]; onChange: (next: string[]) => void }) {
  const options = WORKER_CAPABILITIES.filter((c) => (c.types as readonly string[]).includes(type));
  const toggle = (code: string, on: boolean) => onChange(on ? Array.from(new Set([...value, code])) : value.filter((v) => v !== code));
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-sm font-medium text-silver">Capabilities</legend>
      {options.length === 0 && <p className="text-xs2 text-silver/70">No capabilities apply to this type.</p>}
      <div className="grid gap-1.5 sm:grid-cols-2">
        {options.map((c) => (
          <label key={c.code} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={value.includes(c.code)} onChange={(e) => toggle(c.code, e.target.checked)} />
            {c.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/* -------------------------------------------------------------- sites */

/** Flat "Client — Site" list across the active clients. */
function useSiteOptions() {
  const clients = useQuery({ queryKey: ['clients', 'names', 'workers'], queryFn: () => listClients({ status: 'ACTIVE', limit: 200 }) });
  const clientList = clients.data?.clients ?? [];
  const ids = clientList.map((c) => c.id);
  const locations = useQuery({
    queryKey: ['clients', 'locations', 'workers', ids],
    queryFn: async () => {
      const all = await Promise.all(clientList.map((c) => listClientLocations(c.id).then((r) => r.locations.map((l) => ({ ...l, clientName: c.name })))));
      return all.flat().filter((l) => l.isActive);
    },
    enabled: ids.length > 0,
  });
  return {
    loading: clients.isLoading || locations.isLoading,
    options: (locations.data ?? []).map((l) => ({ id: l.id, label: `${l.clientName} — ${l.name}` })).sort((a, b) => a.label.localeCompare(b.label)),
  };
}

function SiteSelect({ value, onChange, id, ...aria }: { value: string; onChange: (v: string) => void; id?: string; 'aria-describedby'?: string; 'aria-invalid'?: true }) {
  const sites = useSiteOptions();
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} {...aria}>
      <option value="">{sites.loading ? 'Loading sites…' : 'No site yet'}</option>
      {sites.options.map((s) => (
        <option key={s.id} value={s.id}>
          {s.label}
        </option>
      ))}
    </Select>
  );
}

/* ------------------------------------------------------------- create */

function CreateWorkerDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => Promise<void> }) {
  const [type, setType] = useState<'AGENT' | 'ROBOT'>('AGENT');
  const [name, setName] = useState('');
  const [ownerUserId, setOwnerUserId] = useState('');
  const [status, setStatus] = useState<WorkerStatus>('ONBOARDING');
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [notes, setNotes] = useState('');
  const [locationId, setLocationId] = useState('');
  const [saving, setSaving] = useState(false);
  const dirty = name !== '' || ownerUserId !== '' || capabilities.length > 0 || notes !== '';
  const valid = name.trim().length >= 2 && ownerUserId !== '';

  const changeType = (next: 'AGENT' | 'ROBOT') => {
    setType(next);
    // Keep only the capabilities that still apply to the new type.
    setCapabilities((prev) => prev.filter((code) => (WORKER_CAPABILITIES.find((c) => c.code === code)?.types as readonly string[] | undefined)?.includes(next)));
  };

  const submit = async () => {
    if (!valid) return;
    setSaving(true);
    try {
      await createWorker({
        type,
        name: name.trim(),
        ownerUserId,
        status,
        capabilities: capabilities as never,
        notes: notes.trim() || undefined,
        locationId: locationId || undefined,
      });
      toast.success(`${name.trim()} added.`);
      await onCreated();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not add the worker.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} confirmDiscard={dirty && !saving}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add agent or robot</DialogTitle>
          <DialogDescription>People are mirrored from the associate record. Agents and robots are added here, and every one needs an owner.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Field label="Type" required>
            {(p) => (
              <Select {...p} value={type} onChange={(e) => changeType(e.target.value as 'AGENT' | 'ROBOT')}>
                <option value="AGENT">{WORKER_TYPE_LABELS.AGENT}</option>
                <option value="ROBOT">{WORKER_TYPE_LABELS.ROBOT}</option>
              </Select>
            )}
          </Field>
          <Field label="Name" required hint="How it appears on schedules and in audit.">
            {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={160} autoFocus />}
          </Field>
          <Field label="Owner" required hint="The person who answers for what this worker does.">
            {(p) => <OwnerSelect {...p} value={ownerUserId} onChange={setOwnerUserId} />}
          </Field>
          <Field label="Status">
            {(p) => (
              <Select {...p} value={status} onChange={(e) => setStatus(e.target.value as WorkerStatus)}>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {WORKER_STATUS_LABELS[s]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <CapabilityPicker type={type} value={capabilities} onChange={setCapabilities} />
          <Field label="Initial site" hint="Optional. Where it works first.">
            {(p) => <SiteSelect {...p} value={locationId} onChange={setLocationId} />}
          </Field>
          <Field label="Notes">
            {(p) => <Textarea {...p} value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />}
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || saving}>
              {saving ? 'Creating…' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* --------------------------------------------------------------- edit */

function EditWorkerDialog({ worker, canManage, onClose, onSaved }: { worker: WorkerSummary; canManage: boolean; onClose: () => void; onSaved: () => Promise<void> }) {
  const confirm = useConfirm();
  const isPerson = worker.type === 'PERSON';
  const [name, setName] = useState(worker.name);
  const [ownerUserId, setOwnerUserId] = useState(worker.owner?.id ?? '');
  const [status, setStatus] = useState<WorkerStatus>(worker.status);
  const [capabilities, setCapabilities] = useState<string[]>(worker.capabilities);
  const [notes, setNotes] = useState(worker.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [siteId, setSiteId] = useState('');
  const [assigning, setAssigning] = useState(false);

  const dirty =
    name !== worker.name ||
    ownerUserId !== (worker.owner?.id ?? '') ||
    status !== worker.status ||
    notes !== (worker.notes ?? '') ||
    capabilities.join() !== worker.capabilities.join();
  const valid = ownerUserId !== '' && (isPerson || name.trim().length >= 2);

  const save = async () => {
    if (!valid || !canManage) return;
    if (!isPerson && status === 'OFFBOARDED' && worker.status !== 'OFFBOARDED') {
      const ok = await confirm({
        title: `Offboard ${worker.name}?`,
        description: 'It leaves every site and stops being scheduled. The record stays for audit.',
        confirmLabel: 'Offboard',
        destructive: true,
      });
      if (!ok) return;
    }
    setSaving(true);
    try {
      await updateWorker(worker.id, {
        ownerUserId: ownerUserId !== (worker.owner?.id ?? '') ? ownerUserId : undefined,
        capabilities: capabilities as never,
        notes: notes.trim() || null,
        ...(isPerson ? {} : { name: name.trim(), status }),
      });
      toast.success('Saved.');
      await onSaved();
      onClose();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not save the worker.'));
    } finally {
      setSaving(false);
    }
  };

  const assign = async () => {
    if (!siteId || !canManage) return;
    setAssigning(true);
    try {
      await assignWorkerSite(worker.id, { locationId: siteId });
      toast.success('Assigned to the site.');
      setSiteId('');
      await onSaved();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not assign the site.'));
    } finally {
      setAssigning(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} confirmDiscard={dirty && !saving}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <span className="inline-flex items-center gap-2">
              {worker.name}
              <Badge variant={TYPE_VARIANT[worker.type]} size="sm">
                {WORKER_TYPE_LABELS[worker.type]}
              </Badge>
              <Badge variant={STATUS_VARIANT[worker.status]} size="sm">
                {WORKER_STATUS_LABELS[worker.status]}
              </Badge>
            </span>
          </DialogTitle>
          <DialogDescription>
            {isPerson
              ? 'A person follows their associate record: name, status and sites come from there. Only the owner, capabilities and notes are edited here.'
              : `Created ${fmtDate(worker.createdAt)} · ${worker.upcomingShifts} upcoming ${worker.upcomingShifts === 1 ? 'shift' : 'shifts'}`}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {!isPerson && (
            <Field label="Name" required>
              {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={160} disabled={!canManage} />}
            </Field>
          )}
          <Field label="Owner" required>
            {(p) => (canManage ? <OwnerSelect {...p} value={ownerUserId} onChange={setOwnerUserId} /> : <Input {...p} value={worker.owner ? `${worker.owner.name} — ${worker.owner.email}` : 'No owner'} readOnly />)}
          </Field>
          {!isPerson && (
            <Field label="Status">
              {(p) => (
                <Select {...p} value={status} onChange={(e) => setStatus(e.target.value as WorkerStatus)} disabled={!canManage}>
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {WORKER_STATUS_LABELS[s]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          {canManage ? (
            <CapabilityPicker type={worker.type} value={capabilities} onChange={setCapabilities} />
          ) : (
            <div className="space-y-1">
              <div className="text-sm font-medium text-silver">Capabilities</div>
              <div className="flex flex-wrap gap-1">
                {worker.capabilities.length ? worker.capabilities.map((c) => <Badge key={c} variant="outline" size="sm">{CAP_LABEL.get(c) ?? c}</Badge>) : <span className="text-silver/60">—</span>}
              </div>
            </div>
          )}
          <Field label="Notes">
            {(p) => <Textarea {...p} value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} disabled={!canManage} />}
          </Field>

          <section className="space-y-2 rounded-md border border-navy-secondary p-3">
            <h3 className="text-sm font-medium text-silver">Sites</h3>
            {worker.sites.length === 0 ? (
              <p className="text-sm text-silver/70">Not at any site.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {worker.sites.map((s) => (
                  <li key={`${s.locationId}-${s.startedAt}`} className="flex flex-wrap items-center gap-2">
                    <span>
                      {s.clientName} — {s.siteName}
                    </span>
                    <span className="text-xs2 text-silver/70">
                      {fmtDate(s.startedAt)}
                      {s.endedAt ? ` → ${fmtDate(s.endedAt)}` : ' → now'}
                    </span>
                    <Badge variant="outline" size="sm">
                      {s.source === 'associate' ? 'from the associate record' : 'assigned here'}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
            {canManage && !isPerson && (
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-[14rem] flex-1">
                  <Field label="Assign to site">{(p) => <SiteSelect {...p} value={siteId} onChange={setSiteId} />}</Field>
                </div>
                <Button type="button" variant="secondary" onClick={assign} disabled={!siteId || assigning}>
                  {assigning ? 'Assigning…' : 'Assign'}
                </Button>
              </div>
            )}
            {canManage && isPerson && <p className="text-xs2 text-silver/70">A person's sites follow their associate assignments.</p>}
          </section>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
              {canManage ? 'Cancel' : 'Close'}
            </Button>
            {canManage && (
              <Button type="submit" disabled={!valid || !dirty || saving}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
