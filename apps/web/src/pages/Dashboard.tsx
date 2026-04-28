import { useAuth } from '@/lib/auth';
import { AssociateDashboard } from './AssociateDashboard';
import { AdminDashboard } from './AdminDashboard';
import { ManagerDashboard } from './ManagerDashboard';

/**
 * Role-aware dashboard router.
 *   ASSOCIATE → personal landing (clock-in, shift, paystub, time-off)
 *   MANAGER   → team-scoped (direct reports, pending approvals)
 *   anyone else → org-wide AdminDashboard, role-filtered internally
 */
export function Dashboard() {
  const { user } = useAuth();
  if (user?.role === 'ASSOCIATE') {
    return <AssociateDashboard />;
  }
  if (user?.role === 'MANAGER') {
    return <ManagerDashboard />;
  }
  return <AdminDashboard />;
}
