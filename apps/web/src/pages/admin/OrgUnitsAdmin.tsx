import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Network, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useAuth, useTenant, useTerm } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import {
  ORG_UNIT_TYPES,
  ORG_UNIT_TYPE_LABEL,
  createOrgUnit,
  deleteOrgUnit,
  listOrgUnitSites,
  listOrgUnits,
  listSites,
  setOrgUnitSites,
  unitDepth,
  updateOrgUnit,
  type OrgUnitRow,
  type OrgUnitType,
} from '@/lib/orgApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Drawer, DrawerBody, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/Drawer';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryError } from '@/components/ui/QueryError';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/Table';

/**
 * The organizational tree (Brief 2-1b step 5): divisions, regions,
 * business units and cost centers, each with a GL code, sites pinned at
 * any level, permissions scoped at any level. Region and cost-center
 * mirrors are managed from their own pages until those are retired.
 */
export function OrgUnitsAdmin() {
  const { can } = useAuth();
  const { moduleOn } = useTenant();
  const term = useTerm();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const canManage = can('manage:org');
  const sitesNoun = term('sites').toLowerCase();
  const [editing, setEditing] = useState<{ unit: OrgUnitRow | null; parentId: string | null } | null>(null);
  const [sitesFor, setSitesFor] = useState<OrgUnitRow | null>(null);

  const query = useQuery({ queryKey: ['org', 'units'], queryFn: listOrgUnits });
  const units = useMemo(() => (query.data?.units ?? []).filter((u): u is OrgUnitRow => !!u && typeof u.id === 'string'), [query.data]);
  const byId = useMemo(() => new Map(units.map((u) => [u.id, u])), [units]);

  const remove = useMutation({
    mutationFn: (id: string) => deleteOrgUnit(id),
    onSuccess: async () => {
      toast.success('Unit removed. Its children moved up a level.');
      await qc.invalidateQueries({ queryKey: ['org', 'units'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not remove the unit.'),
  });

  const askRemove = async (u: OrgUnitRow) => {
    if (
      await confirm({
        title: `Remove ${u.name}?`,
        description: `Its ${u.sites} ${sitesNoun} and the people pinned to it are unpinned; units under it move up to its parent.`,
        confirmLabel: 'Remove',
        destructive: true,
      })
    ) {
      remove.mutate(u.id);
    }
  };

  const mirrorNote = (u: OrgUnitRow) =>
    u.legacyRegionId ? (
      <span className="text-xs text-silver">
        mirrors a region; managed from{' '}
        <Link to="/regions" className="text-gold underline-offset-2 hover:underline">
          Regions
        </Link>
      </span>
    ) : u.legacyCostCenterId ? (
      <span className="text-xs text-silver">mirrors a cost center; managed from Cost centers</span>
    ) : null;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title="Organizational tree"
        subtitle={`Divisions, regions, business units and cost centers, each with its ledger code. ${term('sites')} and accounts can be pinned at any level.`}
        breadcrumbs={[{ label: 'Admin' }, { label: 'Organization profile', to: '/admin/organization' }, { label: 'Organizational tree' }]}
        primaryAction={
          canManage ? (
            <Button size="sm" onClick={() => setEditing({ unit: null, parentId: null })}>
              <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              New unit
            </Button>
          ) : undefined
        }
      />
      {query.isError ? <QueryError what="the organizational tree" query={query} /> : null}
      {query.isPending ? <Skeleton className="h-48" /> : null}
      {!query.isPending && units.length === 0 ? (
        <EmptyState icon={Network} title="No units yet" description="Start with a division or a region, then pin the sites that belong to it." />
      ) : null}
      {units.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Unit</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Code</TableHead>
                  <TableHead>GL code</TableHead>
                  <TableHead className="text-right">{term('sites')}</TableHead>
                  <TableHead>State</TableHead>
                  {canManage && <TableHead className="text-right">Actions</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {units.map((u) => {
                  const depth = unitDepth(u.path);
                  const mirror = !!u.legacyRegionId || !!u.legacyCostCenterId;
                  return (
                    <TableRow key={u.id}>
                      <TableCell>
                        <div style={{ paddingLeft: `${depth * 1.25}rem` }} className="min-w-0">
                          <div className="text-white">{u.name}</div>
                          {mirrorNote(u)}
                          {moduleOn('clientPortal') && u.clientId ? <div className="text-xs text-silver">{term('label.client')}-specific</div> : null}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={u.type === 'COST_CENTER' ? 'info' : 'default'} size="sm" withDot={false}>
                          {ORG_UNIT_TYPE_LABEL[u.type]}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs tabular-nums">{u.code ?? '—'}</TableCell>
                      <TableCell className="text-xs tabular-nums">{u.glCode ?? '—'}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        <button type="button" className="min-h-11 underline-offset-2 hover:underline" onClick={() => setSitesFor(u)}>
                          {u.sites}
                        </button>
                      </TableCell>
                      <TableCell>
                        <Badge variant={u.isActive ? 'success' : 'default'} size="sm">
                          {u.isActive ? 'Active' : 'Inactive'}
                        </Badge>
                      </TableCell>
                      {canManage && (
                        <TableCell className="text-right">
                          <div className="flex flex-wrap justify-end gap-1">
                            <Button size="sm" variant="ghost" onClick={() => setEditing({ unit: null, parentId: u.id })}>
                              Add child
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setEditing({ unit: u, parentId: u.parentId })}>
                              Edit
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setSitesFor(u)}>
                              {term('sites')}
                            </Button>
                            {!mirror && (
                              <Button size="sm" variant="ghost" aria-label={`Remove ${u.name}`} onClick={() => void askRemove(u)}>
                                <Trash2 className="h-4 w-4" aria-hidden="true" />
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
      {editing && <UnitDialog unit={editing.unit} parentId={editing.parentId} units={units} byId={byId} onClose={() => setEditing(null)} />}
      {sitesFor && <UnitSitesDrawer unit={sitesFor} canManage={canManage} onClose={() => setSitesFor(null)} />}
    </div>
  );
}

function UnitDialog({
  unit,
  parentId,
  units,
  byId,
  onClose,
}: {
  unit: OrgUnitRow | null;
  parentId: string | null;
  units: OrgUnitRow[];
  byId: Map<string, OrgUnitRow>;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [type, setType] = useState<OrgUnitType>(unit?.type ?? (parentId ? 'REGION' : 'DIVISION'));
  const [name, setName] = useState(unit?.name ?? '');
  const [code, setCode] = useState(unit?.code ?? '');
  const [glCode, setGlCode] = useState(unit?.glCode ?? '');
  const [parent, setParent] = useState<string>(parentId ?? '');
  // A unit cannot move under itself or its own descendants.
  const parentOptions = units.filter((u) => !unit || (u.id !== unit.id && !u.path.startsWith(`${unit.path}/`)));
  const dirty = () => name !== (unit?.name ?? '') || code !== (unit?.code ?? '') || glCode !== (unit?.glCode ?? '') || parent !== (parentId ?? '');
  const save = useMutation({
    mutationFn: () =>
      unit
        ? updateOrgUnit(unit.id, { name: name.trim(), code: code.trim() || null, glCode: glCode.trim() || null, parentId: parent || null })
        : createOrgUnit({ type, name: name.trim(), parentId: parent || null, code: code.trim() || null, glCode: glCode.trim() || null }),
    onSuccess: async () => {
      toast.success(unit ? 'Unit updated.' : 'Unit added.');
      await qc.invalidateQueries({ queryKey: ['org', 'units'] });
      onClose();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save the unit.'),
  });
  const parentName = parent ? (byId.get(parent)?.name ?? '') : '';
  return (
    <Dialog open onOpenChange={(o) => !o && !save.isPending && onClose()} confirmDiscard={dirty}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{unit ? `Edit ${unit.name}` : parentName ? `New unit under ${parentName}` : 'New unit'}</DialogTitle>
          <DialogDescription>A unit is one node of the tree: its type, its name, its own code and the ledger code it posts to.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {!unit && (
            <Field label="Type">
              {(p) => (
                <Select {...p} value={type} onChange={(e) => setType(e.target.value as OrgUnitType)}>
                  {ORG_UNIT_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {ORG_UNIT_TYPE_LABEL[t]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          <Field label="Name">{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} autoFocus />}</Field>
          <Field label="Parent" hint="Blank puts the unit at the top of the tree.">
            {(p) => (
              <Select {...p} value={parent} onChange={(e) => setParent(e.target.value)}>
                <option value="">— top of the tree —</option>
                {parentOptions.map((u) => (
                  <option key={u.id} value={u.id}>
                    {' '.repeat(unitDepth(u.path) * 3)}
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
            {unit ? 'Save' : 'Add unit'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UnitSitesDrawer({ unit, canManage, onClose }: { unit: OrgUnitRow; canManage: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const term = useTerm();
  const under = useQuery({ queryKey: ['org', 'units', unit.id, 'sites'], queryFn: () => listOrgUnitSites(unit.id) });
  const all = useQuery({ queryKey: ['org', 'sites'], queryFn: listSites, enabled: canManage });
  const underRows = under.data?.sites ?? [];
  const allRows = useMemo(() => all.data?.sites ?? [], [all.data]);
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const direct = useMemo(() => new Set(allRows.filter((s) => s.orgUnitId === unit.id).map((s) => s.id)), [allRows, unit.id]);
  const selection = picked ?? direct;
  const save = useMutation({
    mutationFn: () => setOrgUnitSites(unit.id, [...selection]),
    onSuccess: async () => {
      toast.success(`${term('sites')} updated.`);
      await Promise.all([qc.invalidateQueries({ queryKey: ['org', 'units'] }), qc.invalidateQueries({ queryKey: ['org', 'sites'] })]);
      setPicked(null);
      onClose();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : `Could not update the ${term('sites').toLowerCase()}.`),
  });
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>
          {term('sites')} under {unit.name}
        </DrawerTitle>
        <DrawerDescription>Every {term('site').toLowerCase()} pinned to this unit or to a unit beneath it.</DrawerDescription>
      </DrawerHeader>
      <DrawerBody>
        {under.isPending ? (
          <Skeleton className="h-24" />
        ) : underRows.length === 0 ? (
          <p className="text-sm text-silver">Nothing is pinned under this unit yet.</p>
        ) : (
          <ul className="divide-y divide-navy-secondary/60 rounded-md border border-navy-secondary">
            {underRows.map((s) => (
              <li key={s.id} className="flex items-center justify-between px-3 py-2 text-sm">
                <span className="text-white">{s.name}</span>
                {s.orgUnitId !== unit.id && <span className="text-xs text-silver">in a unit beneath</span>}
              </li>
            ))}
          </ul>
        )}
        {canManage && (
          <div className="mt-6">
            <h3 className="text-xs font-medium uppercase tracking-wider text-silver">Pin directly to {unit.name}</h3>
            {all.isPending ? (
              <Skeleton className="mt-2 h-24" />
            ) : (
              <ul className="mt-2 max-h-72 divide-y divide-navy-secondary/60 overflow-y-auto rounded-md border border-navy-secondary">
                {allRows.map((s) => (
                  <li key={s.id}>
                    <label className="flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2 hover:bg-navy-secondary/30">
                      <input
                        type="checkbox"
                        className="h-4 w-4"
                        checked={selection.has(s.id)}
                        onChange={(e) =>
                          setPicked((prev) => {
                            const n = new Set(prev ?? direct);
                            if (e.target.checked) n.add(s.id);
                            else n.delete(s.id);
                            return n;
                          })
                        }
                      />
                      <span className="text-sm text-white">{s.name}</span>
                      {s.orgUnitId && s.orgUnitId !== unit.id && <span className="text-xs text-silver">· now in {s.orgUnitName}</span>}
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>
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
