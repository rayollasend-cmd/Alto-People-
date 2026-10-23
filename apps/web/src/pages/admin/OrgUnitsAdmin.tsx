import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Network, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useAuth, useTenant, useTerm } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import {
  ORG_UNIT_TYPE_LABEL,
  createOrgUnit,
  deleteOrgUnit,
  listOrgUnits,
  listSites,
  updateOrgUnit,
  type OrgUnitRow,
  type OrgUnitType,
} from '@/lib/orgApi';
import { placeSite } from '@/lib/structureApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Drawer, DrawerBody, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/Drawer';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryError } from '@/components/ui/QueryError';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * Cost centers & ledger codes (formerly "Organizational tree").
 *
 * The business structure — region → client → store — is drawn and edited in
 * one place, the Org chart's field view. What finance still needs from the
 * org-unit tree is the ledger side: cost centers, business units and
 * divisions, each with the GL code labor posts to, and which stores map to
 * each. That is this page: a flat list, not a second tree. A cost center
 * can sit under a region (so its stores keep their region), and stores are
 * mapped through the same rule as the Org chart (lib/structure.placeSite).
 */

/** The ledger side of the tree: what a store can be costed to. */
const LEDGER_TYPES: OrgUnitType[] = ['COST_CENTER', 'BUSINESS_UNIT', 'DIVISION'];

export function OrgUnitsAdmin() {
  const { can } = useAuth();
  const term = useTerm();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const canManage = can('manage:org');
  const storesNoun = term('label.stores');
  const hasClients = useTenant().moduleOn('clientPortal');
  const [editing, setEditing] = useState<OrgUnitRow | 'new' | null>(null);
  const [mapping, setMapping] = useState<OrgUnitRow | null>(null);

  const query = useQuery({ queryKey: ['org', 'units'], queryFn: listOrgUnits });
  const units = useMemo(() => (query.data?.units ?? []).filter((u): u is OrgUnitRow => !!u && typeof u.id === 'string'), [query.data]);
  const byId = useMemo(() => new Map(units.map((u) => [u.id, u])), [units]);
  const ledger = useMemo(() => units.filter((u) => LEDGER_TYPES.includes(u.type)), [units]);

  /** The region a unit sits under (the nearest REGION ancestor), for its row. */
  const regionOf = (u: OrgUnitRow): OrgUnitRow | null => {
    const ids = u.path.split('/').filter(Boolean).slice(0, -1).reverse();
    for (const id of ids) {
      const a = byId.get(id);
      if (a?.type === 'REGION') return a;
    }
    return null;
  };
  const parentName = (u: OrgUnitRow) => (u.parentId ? (byId.get(u.parentId)?.name ?? null) : null);

  const remove = useMutation({
    mutationFn: (id: string) => deleteOrgUnit(id),
    onSuccess: async () => {
      toast.success('Removed. Its stores now post to their region’s default.');
      await qc.invalidateQueries({ queryKey: ['org', 'units'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not remove it.'),
  });

  const columns: GridColumn<OrgUnitRow>[] = [
    {
      key: 'name',
      header: 'Name',
      primary: true,
      accessor: (u) => u.name,
      cell: (u) => (
        <div className="min-w-0">
          <div className="text-ink">{u.name}</div>
          <div className="text-xs text-ink-muted">
            {regionOf(u) ? `Under ${regionOf(u)!.name}` : parentName(u) ? `Under ${parentName(u)}` : 'Company-wide'}
          </div>
        </div>
      ),
    },
    {
      key: 'type',
      header: 'Type',
      accessor: (u) => ORG_UNIT_TYPE_LABEL[u.type],
      cell: (u) => (
        <Badge variant={u.type === 'COST_CENTER' ? 'info' : 'default'} size="sm" withDot={false}>
          {ORG_UNIT_TYPE_LABEL[u.type]}
        </Badge>
      ),
      cardMeta: true,
    },
    { key: 'code', header: 'Code', accessor: (u) => u.code ?? '', cell: (u) => <span className="tabular-nums">{u.code ?? '—'}</span>, cardMeta: true },
    { key: 'glCode', header: 'GL code', accessor: (u) => u.glCode ?? '', cell: (u) => <span className="tabular-nums">{u.glCode ?? '—'}</span>, cardMeta: true },
    {
      key: 'sites',
      header: storesNoun,
      align: 'right',
      accessor: (u) => u.sites,
      cell: (u) => (
        <button type="button" className="min-h-11 tabular-nums underline-offset-2 hover:underline" onClick={() => setMapping(u)} aria-label={`${u.sites} ${storesNoun.toLowerCase()} mapped to ${u.name}`}>
          {u.sites}
        </button>
      ),
      stopRowClick: true,
    },
    {
      key: 'state',
      header: 'State',
      accessor: (u) => (u.isActive ? 'Active' : 'Inactive'),
      cell: (u) => (
        <Badge variant={u.isActive ? 'success' : 'default'} size="sm">
          {u.isActive ? 'Active' : 'Inactive'}
        </Badge>
      ),
    },
    ...(canManage
      ? [
          {
            key: 'actions',
            header: '',
            accessor: () => '',
            stopRowClick: true,
            cell: (u: OrgUnitRow) =>
              u.legacyCostCenterId ? (
                <span className="text-xs text-ink-muted">From Departments &amp; job profiles</span>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove ${u.name}`}
                  onClick={async () => {
                    if (
                      await confirm({
                        title: `Remove ${u.name}?`,
                        description: `Its ${u.sites} ${storesNoun.toLowerCase()} are unmapped; anything under it moves up a level.`,
                        confirmLabel: 'Remove',
                        destructive: true,
                      })
                    ) {
                      remove.mutate(u.id);
                    }
                  }}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </Button>
              ),
          } satisfies GridColumn<OrgUnitRow>,
        ]
      : []),
  ];

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title="Cost centers & ledger codes"
        subtitle={`The ledger code labor posts to, and which ${storesNoun.toLowerCase()} map to each. Regions${hasClients ? `, ${term('label.clients').toLowerCase()}` : ''} and ${storesNoun.toLowerCase()} are arranged in the Org chart.`}
        actions={[{ label: 'New cost center', icon: Plus, primary: true, onSelect: () => setEditing('new'), hidden: !canManage }]}
        // Where the structure is arranged: a sibling page, not a standing banner (F500 G4).
        related={[{ label: `Org chart: regions and ${storesNoun.toLowerCase()}`, to: '/org/chart?view=field' }]}
      />
      {query.isError ? <QueryError what="the cost centers" query={query} /> : null}
      {query.isPending ? <Skeleton className="h-48" /> : null}
      {!query.isPending && !query.isError && ledger.length === 0 ? (
        <EmptyState
          icon={Network}
          title="No cost centers yet"
          description={`Add a cost center with the GL code its labor posts to, then map ${storesNoun.toLowerCase()} to it.`}
        />
      ) : null}
      {ledger.length > 0 && (
        <DataGrid
          id="cost-centers"
          caption="Cost centers and ledger codes"
          rows={ledger}
          columns={columns}
          rowKey={(u) => u.id}
          noun={{ one: 'cost center', many: 'cost centers' }}
          search={{ placeholder: 'Search cost centers' }}
          exportCsv={{ filename: 'cost-centers' }}
          onRowClick={canManage ? (u) => setEditing(u) : undefined}
          rowActionLabel={(u) => `Edit ${u.name}`}
        />
      )}
      {editing && <UnitDialog unit={editing === 'new' ? null : editing} units={units} onClose={() => setEditing(null)} />}
      {mapping && <MapStoresDrawer unit={mapping} region={regionOf(mapping)} canManage={canManage} onClose={() => setMapping(null)} />}
    </div>
  );
}

function UnitDialog({ unit, units, onClose }: { unit: OrgUnitRow | null; units: OrgUnitRow[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [type, setType] = useState<OrgUnitType>(unit?.type ?? 'COST_CENTER');
  const [name, setName] = useState(unit?.name ?? '');
  const [code, setCode] = useState(unit?.code ?? '');
  const [glCode, setGlCode] = useState(unit?.glCode ?? '');
  const [parent, setParent] = useState<string>(unit?.parentId ?? '');
  // It can sit under a region (its stores keep their region) or another ledger unit — never under itself.
  const parentOptions = units.filter((u) => !unit || (u.id !== unit.id && !u.path.startsWith(`${unit.path}/`)));
  const dirty = () => name !== (unit?.name ?? '') || code !== (unit?.code ?? '') || glCode !== (unit?.glCode ?? '') || parent !== (unit?.parentId ?? '');
  const save = useMutation({
    mutationFn: () =>
      unit
        ? updateOrgUnit(unit.id, { name: name.trim(), code: code.trim() || null, glCode: glCode.trim() || null, parentId: parent || null })
        : createOrgUnit({ type, name: name.trim(), parentId: parent || null, code: code.trim() || null, glCode: glCode.trim() || null }),
    onSuccess: async () => {
      toast.success(unit ? 'Saved.' : 'Added.');
      await qc.invalidateQueries({ queryKey: ['org', 'units'] });
      await qc.invalidateQueries({ queryKey: ['org', 'structure'] });
      onClose();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save it.'),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && !save.isPending && onClose()} confirmDiscard={dirty}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{unit ? `Edit ${unit.name}` : 'New cost center'}</DialogTitle>
          <DialogDescription>Its name, its own code, and the ledger account its labor posts to.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {!unit && (
            <Field label="Type">
              {(p) => (
                <Select {...p} value={type} onChange={(e) => setType(e.target.value as OrgUnitType)}>
                  {LEDGER_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {ORG_UNIT_TYPE_LABEL[t]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          <Field label="Name">{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} autoFocus />}</Field>
          <Field label="Sits under" hint="Put a cost center under a region when its stores belong to that region.">
            {(p) => (
              <Select {...p} value={parent} onChange={(e) => setParent(e.target.value)}>
                <option value="">Nothing — company-wide</option>
                {parentOptions.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} ({ORG_UNIT_TYPE_LABEL[u.type]})
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Code">{(p) => <Input {...p} value={code} onChange={(e) => setCode(e.target.value)} />}</Field>
            <Field label="GL code" hint="The ledger account it posts to.">
              {(p) => <Input {...p} value={glCode} onChange={(e) => setGlCode(e.target.value)} />}
            </Field>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={name.trim().length === 0 || save.isPending}>
            {unit ? 'Save' : 'Add'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Which stores post to this cost center. Only stores that may (in its
 * region, when it sits under one) can be ticked; each change goes through
 * the placement rule.
 */
function MapStoresDrawer({ unit, region, canManage, onClose }: { unit: OrgUnitRow; region: OrgUnitRow | null; canManage: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const term = useTerm();
  const all = useQuery({ queryKey: ['org', 'sites'], queryFn: listSites });
  const rows = useMemo(() => all.data?.sites ?? [], [all.data]);
  const eligible = useMemo(() => rows.filter((s) => !region || s.regionId === region.legacyRegionId), [rows, region]);
  const mapped = useMemo(() => new Set(rows.filter((s) => s.orgUnitId === unit.id).map((s) => s.id)), [rows, unit.id]);
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const selection = picked ?? mapped;
  const save = useMutation({
    mutationFn: async () => {
      const add = [...selection].filter((id) => !mapped.has(id));
      const drop = [...mapped].filter((id) => !selection.has(id));
      for (const id of add) await placeSite(id, { orgUnitId: unit.id });
      for (const id of drop) await placeSite(id, { orgUnitId: null });
      return add.length + drop.length;
    },
    onSuccess: async (n) => {
      toast.success(`${n} ${n === 1 ? term('label.store').toLowerCase() : term('label.stores').toLowerCase()} updated.`);
      await Promise.all([qc.invalidateQueries({ queryKey: ['org', 'units'] }), qc.invalidateQueries({ queryKey: ['org', 'sites'] }), qc.invalidateQueries({ queryKey: ['org', 'chart'] })]);
      onClose();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not update the mapping.'),
  });
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>
          {term('label.stores')} posting to {unit.name}
        </DrawerTitle>
        <DrawerDescription>
          {region ? `It sits under ${region.name}, so only ${term('label.stores').toLowerCase()} in that region can map to it.` : `Any ${term('label.store').toLowerCase()} can map to it.`}
          {unit.glCode ? ` Labor posts to GL ${unit.glCode}.` : ''}
        </DrawerDescription>
      </DrawerHeader>
      <DrawerBody>
        {all.isPending ? (
          <Skeleton className="h-24" />
        ) : eligible.length === 0 ? (
          <EmptyState icon={Network} title={`No ${term('label.stores').toLowerCase()} can map here`} description={region ? `Move ${term('label.stores').toLowerCase()} into ${region.name} in the Org chart first.` : `Add ${term('label.stores').toLowerCase()} in the Org chart first.`} />
        ) : (
          <ul className="divide-y divide-line rounded-md border border-line">
            {eligible.map((s) => (
              <li key={s.id}>
                <label className="flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2 hover:bg-surface-raised">
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    disabled={!canManage}
                    checked={selection.has(s.id)}
                    onChange={(e) =>
                      setPicked((prev) => {
                        const n = new Set(prev ?? mapped);
                        if (e.target.checked) n.add(s.id);
                        else n.delete(s.id);
                        return n;
                      })
                    }
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-ink">{s.name}</span>
                    <span className="block text-xs text-ink-muted">
                      {[s.clientName, s.regionName].filter(Boolean).join(' · ') || 'No region'}
                      {s.orgUnitId && s.orgUnitId !== unit.id && s.orgUnitType !== 'REGION' ? ` · now ${s.orgUnitName}` : ''}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
        {canManage && (
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!picked || save.isPending}>
            Save
          </Button>
        )}
      </DrawerFooter>
    </Drawer>
  );
}
