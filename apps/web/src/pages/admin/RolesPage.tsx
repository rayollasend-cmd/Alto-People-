import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { PageHeader } from '@/components/ui/PageHeader';
import { RolesMatrix } from './RolesMatrix';

/**
 * Roles & permissions, its own Settings & trust entry (audit Tier 3): who
 * may do what, the built-in roles compared, and the custom roles built on
 * them, with who holds each. The trail comes from the Settings rail.
 */
export function RolesPage() {
  const { can } = useAuth();
  const [creating, setCreating] = useState(false);
  return (
    <div className="space-y-5">
      <PageHeader
        title="Roles & permissions"
        subtitle="What each role may do, the custom roles built on them, and who holds each. Open a role to see it in full."
        actions={[{ label: 'New custom role', icon: Plus, primary: true, onSelect: () => setCreating(true), hidden: !can('manage:org') }]}
        related={[
          { label: 'Users & access', to: '/admin/users' },
          { label: 'Approval rules', to: '/admin/approvals' },
        ]}
      />
      <RolesMatrix creating={creating} onCreatingChange={setCreating} />
    </div>
  );
}
