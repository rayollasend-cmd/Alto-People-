import { useEffect } from 'react';
import { useAuth } from '@/lib/auth';
import { setAnalyticsUser } from '@/lib/analytics';

/** Tells product analytics who is signed in: internal id, the role being worn and the company — nothing else (lib/analytics). */
export function AnalyticsIdentity() {
  const { user, role, tenant } = useAuth();
  const id = user?.id ?? null;
  useEffect(() => {
    setAnalyticsUser(id && role ? { id, role, tenantId: tenant.id } : null);
  }, [id, role, tenant.id]);
  return null;
}
