import { useQuery } from '@tanstack/react-query';
import { ROLE_CAPABILITIES } from '@alto-people/shared';
import { ROLE_LABELS } from '@/lib/roles';
import { listAdminUsers } from '@/lib/usersAdminApi';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';

/**
 * Brief 1A-4: Region scope on a portal account needs a named approver —
 * an active account that holds manage:org. The name goes on the account
 * and into the audit log with the decision.
 */
export function approverCandidates(users: Array<{ id: string; email: string; role: keyof typeof ROLE_CAPABILITIES; status: string; associateName?: string | null }>) {
  return users
    .filter((u) => u.status === 'ACTIVE' && ROLE_CAPABILITIES[u.role]?.has('manage:org'))
    .map((u) => ({ id: u.id, label: `${u.associateName ?? u.email} · ${ROLE_LABELS[u.role]}` }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function ApproverPicker({
  value,
  onChange,
  disabled,
  hint = 'An active account that holds manage:org. Recorded with the decision in the audit log.',
}: {
  value: string;
  onChange: (userId: string) => void;
  disabled?: boolean;
  hint?: string;
}) {
  const query = useQuery({
    queryKey: ['ApproverPicker', 'manage-org-users'],
    queryFn: () => listAdminUsers({ status: 'ACTIVE' }),
  });
  const options = query.data ? approverCandidates(query.data.users) : [];
  return (
    <Field label="Approved by" hint={query.isError ? 'Could not load the approver list — try again.' : hint}>
      {(p) => (
        <Select {...p} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled || query.isPending}>
          <option value="">{query.isPending ? 'Loading…' : '— pick the approver —'}</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}
