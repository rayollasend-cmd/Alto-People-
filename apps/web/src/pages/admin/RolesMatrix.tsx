import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { Role } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth, useRoleLabel } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import { listAdminUsers } from '@/lib/usersAdminApi';
import {
  assignTenantRole,
  createTenantRole,
  deleteTenantRole,
  getScimGroups,
  getTenantRoles,
  mapScimGroup,
  unmapScimGroup,
  updateTenantRole,
  type TenantRoleRow,
} from '@/lib/tenantRolesApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { SkeletonRows } from '@/components/ui';
import { QueryError } from '@/components/ui/QueryError';
import { Drawer, DrawerBody, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/Drawer';

/**
 * Brief 2-3 step 3 — Roles & permissions. The built-in roles are read-only;
 * a custom role starts from one of them and can only take capabilities
 * away (it still behaves as that role everywhere else: client scope, portal,
 * two-step sign-in class). Changes reach holders on their next request and
 * are recorded in the audit log with before and after.
 */

const message = (err: unknown) => (err instanceof ApiError ? err.message : 'Something went wrong.');

/** `manage:team-time` → `team time`; ASN keys group together. */
function areaOf(cap: string): string {
  const [head, ...rest] = cap.split(':');
  return (head === 'asn' ? 'asn' : rest.join(':') || head!).replace(/[-:]/g, ' ');
}

function grouped(caps: string[]): Array<[string, string[]]> {
  const m = new Map<string, string[]>();
  for (const c of caps) m.set(areaOf(c), [...(m.get(areaOf(c)) ?? []), c]);
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function CapabilityGrid({ all, ceiling, held, onToggle }: { all: string[]; ceiling: Set<string>; held: Set<string>; onToggle?: (cap: string) => void }) {
  return (
    <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
      {grouped(all.filter((c) => ceiling.has(c))).map(([area, caps]) => (
        <div key={area}>
          <div className="text-xs uppercase tracking-wide text-silver">{area}</div>
          <ul className="mt-1 space-y-1">
            {caps.map((c) => (
              <li key={c}>
                <label className="flex items-center gap-2 text-sm text-white">
                  <input type="checkbox" checked={held.has(c)} disabled={!onToggle} onChange={() => onToggle?.(c)} />
                  <code className="text-xs">{c}</code>
                </label>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function NewRoleDrawer({ roles, all, onClose, onSaved }: { roles: TenantRoleRow[]; all: string[]; onClose: () => void; onSaved: (id: string) => void }) {
  const roleLabel = useRoleLabel();
  const systems = roles.filter((r) => r.system && r.offered);
  const [archetype, setArchetype] = useState<Role>(systems[0]?.archetype ?? 'MANAGER');
  const ceiling = useMemo(() => new Set(roles.find((r) => r.id === `system:${archetype}`)?.capabilities ?? []), [roles, archetype]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [held, setHeld] = useState<Set<string>>(ceiling);
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
    <Drawer open onOpenChange={(o) => !o && onClose()}>
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
        <CapabilityGrid all={all} ceiling={ceiling} held={held} onToggle={(c) => setHeld((s) => { const n = new Set(s); if (n.has(c)) n.delete(c); else n.add(c); return n; })} />
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button disabled={saving || !name.trim()} onClick={() => void save()}>{saving ? 'Saving…' : 'Create role'}</Button>
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
        <p className="text-sm text-silver">Nobody holds this role yet.</p>
      ) : (
        <ul className="divide-y divide-navy-secondary/60">
          {holders.map((u) => (
            <li key={u.id} className="flex items-center justify-between gap-2 py-1.5 text-sm text-white">
              <span className="min-w-0 truncate">{u.email}</span>
              {canManage && <Button size="sm" variant="ghost" onClick={() => void assign(u.id, null)}>Remove</Button>}
            </li>
          ))}
        </ul>
      )}
      {canManage && candidates.length > 0 && (
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Give this role to">
            {(p) => (
              <Select {...p} value={pick} onChange={(e) => setPick(e.target.value)} className="w-72">
                <option value="">Choose a person…</option>
                {candidates.map((u) => (
                  <option key={u.id} value={u.id}>{u.email}</option>
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

function ScimGroups({ roles }: { roles: TenantRoleRow[] }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const roleLabel = useRoleLabel();
  const q = useQuery({ queryKey: ['tenant-roles', 'scim-groups'], queryFn: getScimGroups });
  const [groupName, setGroupName] = useState('');
  const [target, setTarget] = useState('');
  const options = roles.filter((r) => r.offered && r.archetype !== 'CLIENT_PORTAL');
  const add = async () => {
    const r = roles.find((x) => x.id === target);
    if (!r) return;
    try {
      await mapScimGroup({ groupName: groupName.trim(), archetype: r.archetype, tenantRoleId: r.system ? null : r.id });
      setGroupName('');
      setTarget('');
      toast.success('Mapped. Members take the role now.');
      await qc.invalidateQueries({ queryKey: ['tenant-roles'] });
    } catch (err) {
      toast.error(message(err));
    }
  };
  const remove = async (m: { id: string; groupName: string; archetype: Role; tenantRoleName?: string | null }, members: number | null) => {
    const roleName = m.tenantRoleName ?? roleLabel(m.archetype);
    const holders = members === null ? 'People who hold it today keep it' : `The ${members} ${members === 1 ? 'person' : 'people'} in the group keep it`;
    const ok = await confirm({
      title: `Remove the mapping for ${m.groupName}?`,
      description: `The directory stops granting ${roleName} to this group. ${holders} until an admin changes their role.`,
      confirmLabel: 'Remove mapping',
      destructive: true,
    });
    if (!ok) return;
    try {
      await unmapScimGroup(m.id);
      toast.success(`Mapping removed. ${m.groupName} no longer grants ${roleName}.`);
      await qc.invalidateQueries({ queryKey: ['tenant-roles'] });
    } catch (err) {
      toast.error(message(err));
    }
  };
  return (
    <Card>
      <CardContent className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-white">Directory groups</h3>
          <p className="text-xs text-silver">A member of a mapped group holds its role. Leaving every mapped group changes nothing; deactivate in your directory instead.</p>
        </div>
        {q.isLoading ? (
          <SkeletonRows count={2} />
        ) : q.isError ? (
          <QueryError what="directory groups" query={q} />
        ) : (
          <ul className="divide-y divide-navy-secondary/60">
            {(q.data?.mappings ?? []).map((m) => {
              const pushed = q.data?.groups.find((g) => g.displayName === m.groupName);
              return (
                <li key={m.id} className="flex items-center justify-between gap-2 py-1.5 text-sm text-white">
                  <span className="min-w-0 truncate">
                    {m.groupName} → {m.tenantRoleName ?? roleLabel(m.archetype)}
                    <span className="ml-2 text-xs text-silver">{pushed ? `${pushed.members} in the group` : 'not pushed yet'}</span>
                  </span>
                  <Button size="sm" variant="ghost" aria-label={`Remove mapping for ${m.groupName}`} onClick={() => void remove(m, pushed ? pushed.members : null)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              );
            })}
            {q.data?.mappings.length === 0 && <li className="py-1.5 text-sm text-silver">No groups mapped.</li>}
          </ul>
        )}
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Group name">{(p) => <Input {...p} value={groupName} onChange={(e) => setGroupName(e.target.value)} maxLength={200} placeholder="Alto Store Leads" className="w-60" />}</Field>
          <Field label="Role">
            {(p) => (
              <Select {...p} value={target} onChange={(e) => setTarget(e.target.value)} className="w-60">
                <option value="">Choose a role…</option>
                {options.map((r) => (
                  <option key={r.id} value={r.id}>{r.system ? roleLabel(r.archetype) : `${r.name} (${roleLabel(r.archetype)})`}</option>
                ))}
              </Select>
            )}
          </Field>
          <Button size="sm" disabled={!groupName.trim() || !target} onClick={() => void add()}>Map group</Button>
        </div>
      </CardContent>
    </Card>
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
  const pick = (v: string, set: (x: string) => void) => (
    <Select value={v} onChange={(e) => set(e.target.value)} className="w-56">
      {systems.map((r) => (
        <option key={r.id} value={r.id}>{roleLabel(r.archetype)}</option>
      ))}
    </Select>
  );
  return (
    <Card>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <h3 className="text-base font-semibold text-ink">What changed between built-ins</h3>
            <p className="text-xs text-ink-muted">Two roles side by side: what each holds that the other does not. {shared} in common.</p>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {pick(a, setA)}
            <span className="text-xs text-ink-muted">vs</span>
            {pick(b, setB)}
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
                  <ul className="mt-1 flex flex-wrap gap-1">
                    {list.map((c) => (
                      <li key={c}>
                        <Badge variant="info" size="sm"><code>{c}</code></Badge>
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

export function RolesMatrix() {
  const { can } = useAuth();
  const canManage = can('manage:org');
  const qc = useQueryClient();
  const confirm = useConfirm();
  const roleLabel = useRoleLabel();
  const q = useQuery({ queryKey: ['tenant-roles'], queryFn: getTenantRoles });
  const [selected, setSelected] = useState<string>('');
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<Set<string> | null>(null);
  const [saving, setSaving] = useState(false);
  const roles = q.data?.roles ?? [];
  const role = roles.find((r) => r.id === selected) ?? roles.find((r) => !r.system) ?? roles[0];
  const ceiling = useMemo(() => new Set(roles.find((r) => role && r.id === `system:${role.archetype}`)?.capabilities ?? []), [roles, role]);

  if (q.isLoading) return <SkeletonRows count={6} />;
  if (q.isError || !q.data || !role) return <QueryError what="roles" query={q} />;

  const held = draft ?? new Set(role.capabilities);
  const editable = canManage && !role.system;
  const choose = (id: string) => {
    setSelected(id);
    setDraft(null);
  };
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
      setSelected('');
      await qc.invalidateQueries({ queryKey: ['tenant-roles'] });
    } catch (err) {
      toast.error(message(err));
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3">
          <Field label="Role">
            {(p) => (
              <Select {...p} value={role.id} onChange={(e) => choose(e.target.value)} className="w-72">
                <optgroup label="Custom">
                  {roles.filter((r) => !r.system).map((r) => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </optgroup>
                <optgroup label="Built-in">
                  {roles.filter((r) => r.system).map((r) => (
                    <option key={r.id} value={r.id}>{roleLabel(r.archetype)}{r.offered ? '' : ' (module off)'}</option>
                  ))}
                </optgroup>
              </Select>
            )}
          </Field>
          {canManage && (
            <Button size="sm" variant="secondary" onClick={() => setCreating(true)}>
              <Plus className="mr-1 h-4 w-4" /> New custom role
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 className="text-base font-semibold text-white">{role.system ? roleLabel(role.archetype) : role.name}</h3>
              <p className="text-xs text-silver">
                {role.system ? 'Built-in, read-only.' : `Behaves as ${roleLabel(role.archetype)}.`} {held.size} of {ceiling.size} capabilities · {role.holders} {role.holders === 1 ? 'holder' : 'holders'}
              </p>
              {role.description && <p className="mt-1 text-sm text-silver">{role.description}</p>}
            </div>
            <div className="flex items-center gap-2">
              {!role.offered && <Badge variant="pending">Module off</Badge>}
              {editable && draft && (
                <>
                  <Button size="sm" variant="ghost" onClick={() => setDraft(null)} disabled={saving}>Discard</Button>
                  <Button size="sm" onClick={() => void save()} loading={saving}>Save changes</Button>
                </>
              )}
              {editable && !draft && (
                <Button size="sm" variant="ghost" onClick={() => void remove()}>Delete</Button>
              )}
            </div>
          </div>
          <CapabilityGrid
            all={q.data.capabilities}
            ceiling={ceiling}
            held={held}
            onToggle={editable ? (c) => setDraft(() => { const n = new Set(held); if (n.has(c)) n.delete(c); else n.add(c); return n; }) : undefined}
          />
          {!role.system && (
            <div className="border-t border-navy-secondary/60 pt-3">
              <h4 className="mb-2 text-sm font-semibold text-white">People with this role</h4>
              <Holders role={role} canManage={canManage} />
            </div>
          )}
        </CardContent>
      </Card>

      <CompareBuiltIns roles={roles} />

      {canManage && <ScimGroups roles={roles} />}

      {creating && (
        <NewRoleDrawer
          roles={roles}
          all={q.data.capabilities}
          onClose={() => setCreating(false)}
          onSaved={(id) => {
            setCreating(false);
            choose(id);
            void qc.invalidateQueries({ queryKey: ['tenant-roles'] });
          }}
        />
      )}
    </div>
  );
}
