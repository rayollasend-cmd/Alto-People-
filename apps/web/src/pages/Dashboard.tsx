import { useAuth } from '@/lib/auth';
import { AssociateDashboard } from './AssociateDashboard';
import { AdminDashboard } from './AdminDashboard';

/**
 * Phase 33 — role-aware dashboard router. Associates see a personal
 * landing page (clock-in, next shift, last paystub, time-off, onboarding
 * banner). Everyone else sees the org-wide KPI dashboard.
 */
export function Dashboard() {
  const { user } = useAuth();
  if (user?.role === 'ASSOCIATE') {
    return <AssociateDashboard />;
  }
  return <AdminDashboard />;
}
