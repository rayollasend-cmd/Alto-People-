import { PageHeader } from '@/components/ui/PageHeader';
import { RolesMatrix } from './RolesMatrix';

/**
 * Roles & permissions, its own Settings & trust entry (audit Tier 3): who
 * may do what, the built-in roles compared, custom roles, their holders and
 * the SCIM groups that grant them. It was the third segment inside Users &
 * access, where nobody looking for "permissions" thought to look.
 */
export function RolesPage() {
  return (
    <div className="space-y-5">
      <PageHeader
        title="Roles & permissions"
        subtitle="What each role may do, the custom roles built on them, who holds each, and the identity-provider groups that grant them."
        breadcrumbs={[{ label: 'Settings & trust', to: '/admin' }, { label: 'Roles & permissions' }]}
      />
      <RolesMatrix />
    </div>
  );
}
