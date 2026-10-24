import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from '@/components/ui/icons';
import { toast } from 'sonner';
import type { Role } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useRoleLabel } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import { getScimGroups, getTenantRoles, mapScimGroup, unmapScimGroup, type TenantRoleRow } from '@/lib/tenantRolesApi';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { SkeletonRows } from '@/components/ui';
import { QueryError } from '@/components/ui/QueryError';

/**
 * Directory groups that grant a role (SCIM). They sit with directory
 * provisioning on Sign-in (F500 G4: the mapping used to be an inline form
 * on Roles & permissions while SCIM itself lived here). A member of a
 * mapped group holds its role.
 */

const message = (err: unknown) => (err instanceof ApiError ? err.message : 'Something went wrong.');

/** The groups card, loading the roles it maps to itself. */
export function DirectoryGroups() {
  const q = useQuery({ queryKey: ['tenant-roles'], queryFn: getTenantRoles });
  if (q.isPending) return <SkeletonRows count={2} />;
  if (q.isError || !q.data) return <QueryError what="roles" query={q} />;
  return <ScimGroups roles={q.data.roles} />;
}

export function ScimGroups({ roles }: { roles: TenantRoleRow[] }) {
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
          <h3 className="text-sm font-semibold text-ink">Groups that grant a role</h3>
          <p className="text-xs text-ink-muted">A member of a mapped group holds its role. Leaving every mapped group changes nothing; deactivate in your directory instead.</p>
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
                <li key={m.id} className="flex items-center justify-between gap-2 py-1.5 text-sm text-ink">
                  <span className="min-w-0 truncate">
                    {m.groupName} → {m.tenantRoleName ?? roleLabel(m.archetype)}
                    <span className="ml-2 text-xs text-ink-muted">{pushed ? `${pushed.members} in the group` : 'not pushed yet'}</span>
                  </span>
                  <Button size="sm" variant="ghost" aria-label={`Remove mapping for ${m.groupName}`} onClick={() => void remove(m, pushed ? pushed.members : null)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              );
            })}
            {q.data?.mappings.length === 0 && <li className="py-1.5 text-sm text-ink-muted">No groups mapped.</li>}
          </ul>
        )}
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Group name">{(p) => <Input {...p} value={groupName} onChange={(e) => setGroupName(e.target.value)} maxLength={200} placeholder="Shift Leads" className="w-60" />}</Field>
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

