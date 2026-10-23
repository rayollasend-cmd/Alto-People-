import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { capabilityLabel, type Role } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth, useRoleLabel } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import { listAdminUsers } from '@/lib/usersAdminApi';
import { assignTenantRole, createTenantRole, deleteTenantRole, getTenantRoles, updateTenantRole, type TenantRoleRow } from '@/lib/tenantRolesApi';
import { useDeskItem } from '@/components/templates';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { SkeletonRows } from '@/components/ui';
import { QueryError } from '@/components/ui/QueryError';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Drawer, DrawerBody, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/Drawer';

/**
 * Brief 2-3 step 3, at the F500 bar (G4) — Roles & permissions.
 *
 * Opens on every role at once: built-in or custom, who holds it (linked to
 * those accounts), how much it can do. A row opens the role (?role= in the
 * URL): what it may do in words ("Run payroll", the key underneath), as a
 * read-only list for a built-in role and as switches for a custom one.
 *
 * The built-in roles are read-only; a custom role starts from one of them
 * and can only take capabilities away (it still behaves as that role
 * everywhere else: client scope, portal, two-step sign-in class). Changes
 * reach holders on their next request and are recorded in the audit log.
 * Directory groups that grant roles live with SCIM on Sign-in.
 */

const message = (err: unknown) => (err instanceof ApiError ? err.message : 'Something went wrong.');

/** `manage:team-time` → "Team time"; ASN keys group together. */
function areaOf(cap: string): string {
  const [head, ...rest] = cap.split(':');
  const area = (head === 'asn' ? 'ASN integration' : rest.join(':') || head!).replace(/[-:]/g, ' ');
  return area.charAt(0).toUpperCase() + area.slice(1);
}

function grouped(caps: string[]): Array<[string, string[]]> {
  const m = new Map<string, string[]>();
  for (const c of caps) m.set(areaOf(c), [...(m.get(areaOf(c)) ?? []), c]);
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/** A read-only role: what it may do, as a list (no disabled checkboxes). */
function CapabilityList({ caps }: { caps: string[] }) {
  return (
    <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
      {grouped(caps).map(([area, list]) => (
        <div key={area}>
          <div className="text-xs uppercase tracking-wide text-ink-muted">{area}</div>
          <ul className="mt-1 space-y-1">
            {list.map((c) => (
              <li key={c} className="text-sm text-ink" title={c}>
                {capabilityLabel(c)}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** A custom role's switches: everything its built-in role holds, ticked or not. */
function CapabilityGrid({ ceiling, held, onToggle, disabled }: { ceiling: string[]; held: Set<string>; onToggle: (cap: string) => void; disabled?: boolean }) {
  return (
    <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
      {grouped(ceiling).map(([area, caps]) => (
        <div key={area}>
          <div className="text-xs uppercase tracking-wide text-ink-muted">{area}</div>
          <ul className="mt-1 space-y-1">
            {caps.map((c) => (
              <li key={c}>
                <label className="flex items-start gap-2 text-sm text-ink" title={c}>
                  <input type="checkbox" className="mt-0.5" checked={held.has(c)} disabled={disabled} onChange={() => onToggle(c)} />
                  <span>
                    {capabilityLabel(c)}
                    <code className="block text-2xs text-ink-muted">{c}</code>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function NewRoleDrawer({ roles, onClose, onSaved }: { roles: TenantRoleRow[]; onClose: () => void; onSaved: (id: string) => void }) {
  const roleLabel = useRoleLabel();
  const systems = roles.filter((r) => r.system && r.offered);
  const [archetype, setArchetype] = useState<Role>(systems[0]?.archetype ?? 'MANAGER');
  const ceiling = useMemo(() => roles.find((r) => r.id === `system:${archetype}`)?.capabilities ?? [], [roles, archetype]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [held, setHeld] = useState<Set<string>>(() => new Set(ceiling));
  const [saving, setSaving] = useState(false);
  const pick = (r: Role) => {
    setArchetype(r);
    setHeld(new Set(roles.find((x) => x.id === `system:${r}`)?.capabilities ?? []));
  };
  const save = async () => {
    setSaving(true);
    try {
      const { id } = await createTenantRole({ name: name.trim(), description: description.trim() || null, archetype, capabilities: [...held] });
      toast.success('Role created.');
      onSaved(id);
    } catch (err) {
      toast.error(message(err));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} width="max-w-2xl" confirmDiscard={() => name.trim().length > 0}>
      <DrawerHeader>
        <DrawerTitle>New custom role</DrawerTitle>
        <DrawerDescription>Start from a built-in role and untick what this one should not do. It cannot add anything the built-in role lacks.</DrawerDescription>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <Field label="Name" required>{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Store lead (no pay)" />}</Field>
        <Field label="Description">{(p) => <Input {...p} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} />}</Field>
        <Field label="Behaves as" hint="Scope, portal and sign-in rules follow this role.">
          {(p) => (
            <Select {...p} value={archetype} onChange={(e) => pick(e.target.value as Role)}>
              {systems.map((r) => (
                <option key={r.archetype} value={r.archetype}>{roleLabel(r.archetype)}</option>
              ))}
            </Select>
          )}
        </Field>
        <CapabilityGrid ceiling={ceiling} held={held} onToggle={(c) => setHeld((s) => { const n = new Set(s); if (n.has(c)) n.delete(c); else n.add(c); return n; })} />
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button loading={saving} disabled={saving || !name.trim()} onClick={() => void save()}>Create role</Button>
      </DrawerFooter>
    </Drawer>
  );
}

function Holders({ role, canManage }: { role: TenantRoleRow; canManage: boolean }) {
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ['admin-users', 'by-role', role.archetype], queryFn: () => listAdminUsers({ role: role.archetype }) });
  const [pick, setPick] = useState('');
  const holders = (users.data?.users ?? []).filter((u) => u.tenantRoleId === role.id);
  const candidates = (users.data?.users ?? []).filter((u) => u.tenantRoleId !== role.id && u.status !== 'DISABLED');
  const assign = async (userId: string, tenantRoleId: string | null) => {
    try {
      await assignTenantRole(userId, tenantRoleId);
      toast.success(tenantRoleId ? 'Assigned.' : 'Back on the built-in role.');
      setPick('');
      await qc.invalidateQueries({ queryKey: ['admin-users'] });
      await qc.invalidateQueries({ queryKey: ['tenant-roles'] });
    } catch (err) {
      toast.error(message(err));
    }
  };
  if (users.isLoading) return <SkeletonRows count={2} />;
  return (
    <div className="space-y-2">
      {holders.length === 0 ? (
        <p className="text-sm text-ink-muted">Nobody holds this role yet.</p>
      ) : (
        <ul className="divide-y divide-line">
          {holders.map((u) => (
            <li key={u.id} className="flex items-center justify-between gap-2 py-1.5 text-sm text-ink">
              <span className="min-w-0 truncate">{u.associateName ?? u.email}</span>
              {canManage && <Button size="sm" variant="ghost" onClick={() => void assign(u.id, null)}>Remove</Button>}
            </li>
          ))}
        </ul>
      )}
      {canManage && candidates.length > 0 && (
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Give this role to">
            {(p) => (
              <Select {...p} value={pick} onChange={(e) => setPick(e.target.value)} className="w-72 max-w-full">
                <option value="">Choose a person…</option>
                {candidates.map((u) => (
                  <option key={u.id} value={u.id}>{u.associateName ?? u.email}</option>
                ))}
              </Select>
            )}
          </Field>
          <Button size="sm" disabled={!pick} onClick={() => void assign(pick, role.id)}>Assign</Button>
        </div>
      )}
    </div>
  );
}

/** One role, opened from the table: what it may do, who holds it, and (custom) its edits. */
function RoleDrawer({ role, roles, canManage, onClose }: { role: TenantRoleRow; roles: TenantRoleRow[]; canManage: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const roleLabel = useRoleLabel();
  const ceiling = useMemo(() => roles.find((r) => r.id === `system:${role.archetype}`)?.capabilities ?? [], [roles, role.archetype]);
  const [draft, setDraft] = useState<Set<string> | null>(null);
  const [saving, setSaving] = useState(false);
  const held = draft ?? new Set(role.capabilities);
  const editable = canManage && !role.system;
  const save = async () => {
    if (!draft || saving) return;
    setSaving(true);
    try {
      await updateTenantRole(role.id, { capabilities: [...draft] });
      toast.success(role.holders ? `Saved. ${role.holders} ${role.holders === 1 ? 'person has' : 'people have'} the new set on their next click.` : 'Saved.');
      setDraft(null);
      await qc.invalidateQueries({ queryKey: ['tenant-roles'] });
    } catch (err) {
      toast.error(message(err));
    } finally {
      setSaving(false);
    }
  };
  const remove = async () => {
    if (!(await confirm({ title: `Delete “${role.name}”?`, description: 'Only a role nobody holds can be deleted.', confirmLabel: 'Delete', destructive: true }))) return;
    try {
      await deleteTenantRole(role.id);
      onClose();
      await qc.invalidateQueries({ queryKey: ['tenant-roles'] });
    } catch (err) {
      toast.error(message(err));
    }
  };
  const title = role.system ? roleLabel(role.archetype) : role.name;
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} width="max-w-2xl" confirmDiscard={() => draft !== null}>
      <DrawerHeader>
        <DrawerTitle>{title}</DrawerTitle>
        <DrawerDescription>
          {role.system ? 'Built-in, read-only.' : `Custom, behaves as ${roleLabel(role.archetype)}.`} {role.system ? `${role.capabilities.length} capabilities` : `${held.size} of ${ceiling.length} capabilities`} ·{' '}
          <Link to={`/admin/users?role=${role.archetype}&status=all`} className="text-accent underline-offset-2 hover:underline">
            {role.holders} {role.holders === 1 ? 'holder' : 'holders'}
          </Link>
        </DrawerDescription>
        {!role.offered && (
          <div className="mt-2">
            <Badge variant="pending">Module off</Badge>
          </div>
        )}
      </DrawerHeader>
      <DrawerBody className="space-y-6">
        {role.description && <p className="text-sm text-ink-muted">{role.description}</p>}
        <section aria-label="What this role may do" className="space-y-2">
          <SectionTitle title="What it may do" as="h3" size="sm" />
          {editable ? (
            <CapabilityGrid ceiling={ceiling} held={held} onToggle={(c) => setDraft(() => { const n = new Set(held); if (n.has(c)) n.delete(c); else n.add(c); return n; })} />
          ) : (
            <CapabilityList caps={role.capabilities} />
          )}
        </section>
        {!role.system && (
          <section aria-label="People with this role" className="space-y-2">
            <SectionTitle title="People with this role" as="h3" size="sm" />
            <Holders role={role} canManage={canManage} />
          </section>
        )}
      </DrawerBody>
      {editable && (
        <DrawerFooter>
          <Button variant="ghost" className="mr-auto text-negative" onClick={() => void remove()} disabled={draft !== null}>
            Delete role
          </Button>
          {draft && (
            <Button variant="ghost" onClick={() => setDraft(null)} disabled={saving}>
              Discard
            </Button>
          )}
          <Button onClick={() => void save()} loading={saving} disabled={!draft}>
            Save changes
          </Button>
        </DrawerFooter>
      )}
    </Drawer>
  );
}

/**
 * Access pack: what changed between two built-in roles — the capabilities
 * one holds and the other does not, side by side, so "Recruiter and
 * Workforce Manager are the same" is answered by the matrix, not folklore.
 */
function CompareBuiltIns({ roles }: { roles: TenantRoleRow[] }) {
  const roleLabel = useRoleLabel();
  const systems = roles.filter((r) => r.system);
  const [a, setA] = useState<string>(systems.find((r) => r.archetype === 'INTERNAL_RECRUITER')?.id ?? systems[0]?.id ?? '');
  const [b, setB] = useState<string>(systems.find((r) => r.archetype === 'WORKFORCE_MANAGER')?.id ?? systems[1]?.id ?? '');
  const ra = systems.find((r) => r.id === a);
  const rb = systems.find((r) => r.id === b);
  if (!ra || !rb) return null;
  const sa = new Set(ra.capabilities);
  const sb = new Set(rb.capabilities);
  const onlyA = ra.capabilities.filter((c) => !sb.has(c)).sort();
  const onlyB = rb.capabilities.filter((c) => !sa.has(c)).sort();
  const shared = ra.capabilities.filter((c) => sb.has(c)).length;
  const pick = (v: string, set: (x: string) => void, label: string) => (
    <Select value={v} onChange={(e) => set(e.target.value)} className="w-56 max-w-full" aria-label={label}>
      {systems.map((r) => (
        <option key={r.id} value={r.id}>{roleLabel(r.archetype)}</option>
      ))}
    </Select>
  );
  return (
    <Card>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <SectionTitle title="Compare two built-in roles" description={`What each holds that the other does not. ${shared} in common.`} wrap size="sm" />
          <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
            {pick(a, setA, 'First role')}
            <span className="text-xs text-ink-muted">vs</span>
            {pick(b, setB, 'Second role')}
          </div>
        </div>
        {onlyA.length === 0 && onlyB.length === 0 ? (
          <p className="text-sm text-ink-muted">These two roles hold exactly the same capabilities.</p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {[{ r: ra, list: onlyA }, { r: rb, list: onlyB }].map(({ r, list }) => (
              <div key={r.id}>
                <div className="text-xs uppercase tracking-wide text-ink-muted">Only {roleLabel(r.archetype)} ({list.length})</div>
                {list.length === 0 ? (
                  <p className="mt-1 text-sm text-ink-muted">Holds no capability the other lacks.</p>
                ) : (
                  <ul className="mt-1 space-y-0.5">
                    {list.map((c) => (
                      <li key={c} className="text-sm text-ink" title={c}>
                        {capabilityLabel(c)}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function RolesMatrix({ creating, onCreatingChange }: { creating: boolean; onCreatingChange: (v: boolean) => void }) {
  const { can } = useAuth();
  const canManage = can('manage:org');
  const qc = useQueryClient();
  const roleLabel = useRoleLabel();
  const q = useQuery({ queryKey: ['tenant-roles'], queryFn: getTenantRoles });
  const desk = useDeskItem('role');
  const roles = q.data?.roles ?? [];
  const open = roles.find((r) => r.id === desk.openId) ?? null;

  if (q.isPending) return <SkeletonRows count={6} />;
  if (q.isError || !q.data) return <QueryError what="roles" query={q} />;

  const nameOf = (r: TenantRoleRow) => (r.system ? roleLabel(r.archetype) : r.name);
  const ceilingOf = (r: TenantRoleRow) => roles.find((x) => x.id === `system:${r.archetype}`)?.capabilities.length ?? r.capabilities.length;
  const columns: GridColumn<TenantRoleRow>[] = [
    {
      key: 'role',
      header: 'Role',
      primary: true,
      sortable: true,
      accessor: nameOf,
      cell: (r) => (
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-ink">
            {nameOf(r)}
            {!r.offered && <Badge variant="pending" size="sm">Module off</Badge>}
          </div>
          {!r.system && <div className="text-xs text-ink-muted">Behaves as {roleLabel(r.archetype)}</div>}
        </div>
      ),
    },
    { key: 'kind', header: 'Type', sortable: true, cardMeta: true, accessor: (r) => (r.system ? 'Built-in' : 'Custom'), className: 'text-ink-muted' },
    {
      key: 'holders',
      header: 'Holders',
      sortable: true,
      align: 'right',
      accessor: (r) => r.holders,
      stopRowClick: true,
      cell: (r) =>
        r.holders > 0 ? (
          <Link to={`/admin/users?role=${r.archetype}&status=all`} className="tabular-nums text-ink underline-offset-2 hover:text-accent hover:underline">
            {r.holders}
          </Link>
        ) : (
          <span className="tabular-nums text-ink-muted">0</span>
        ),
    },
    {
      key: 'caps',
      header: 'Can do',
      sortable: true,
      align: 'right',
      accessor: (r) => r.capabilities.length,
      csv: (r) => r.capabilities.length,
      className: 'tabular-nums text-ink-muted',
      cell: (r) => (r.system ? `${r.capabilities.length} things` : `${r.capabilities.length} of ${ceilingOf(r)}`),
    },
  ];
  // Custom roles first (they are this organization's own), then the built-ins.
  const ordered = [...roles].sort((a, b) => Number(a.system) - Number(b.system));

  return (
    <div className="space-y-5">
      <Card>
        <CardContent className="p-0">
          <DataGrid<TenantRoleRow>
            id="roles"
            caption="Roles"
            noun={{ one: 'role', many: 'roles' }}
            rows={ordered}
            columns={columns}
            rowKey={(r) => r.id}
            urlKey="roles"
            search={{ placeholder: 'Find a role' }}
            exportCsv={{ filename: 'roles' }}
            onRowClick={(r) => desk.open(r.id)}
            rowActionLabel={(r) => `Open ${nameOf(r)}`}
            rowClassName={(r) => (r.id === desk.openId ? 'bg-surface-raised/60' : undefined)}
          />
        </CardContent>
      </Card>

      <CompareBuiltIns roles={roles} />

      <p className="text-sm text-ink-muted">
        Directory groups that grant a role are mapped with your directory on{' '}
        <Link to="/admin/sign-in#directory" className="text-accent underline-offset-2 hover:underline">
          Sign-in › Directory provisioning
        </Link>
        .
      </p>

      {open && <RoleDrawer key={open.id} role={open} roles={roles} canManage={canManage} onClose={desk.close} />}
      {creating && (
        <NewRoleDrawer
          roles={roles}
          onClose={() => onCreatingChange(false)}
          onSaved={(id) => {
            onCreatingChange(false);
            void qc.invalidateQueries({ queryKey: ['tenant-roles'] }).then(() => desk.open(id));
          }}
        />
      )}
    </div>
  );
}
