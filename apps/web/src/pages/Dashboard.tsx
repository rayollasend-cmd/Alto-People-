import { lazy, Suspense } from 'react';
import { useAuth } from '@/lib/auth';
import { Skeleton } from '@/components/ui/Skeleton';

// PERF: each variant is its own chunk. All four dashboards used to ride
// statically in the main bundle (~110 KB of TSX plus their api libs) even
// though any given user renders exactly one.
const AssociateDashboard = lazy(() =>
  import('./AssociateDashboard').then((m) => ({ default: m.AssociateDashboard })),
);
const AdminDashboard = lazy(() =>
  import('./AdminDashboard').then((m) => ({ default: m.AdminDashboard })),
);
const ManagerDashboard = lazy(() =>
  import('./ManagerDashboard').then((m) => ({ default: m.ManagerDashboard })),
);
const SupervisorDashboard = lazy(() =>
  import('./SupervisorDashboard').then((m) => ({ default: m.SupervisorDashboard })),
);

function DashboardFallback() {
  return (
    <div className="space-y-4" aria-label="Loading">
      <Skeleton className="h-8 w-1/3" />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24 hidden lg:block" />
        <Skeleton className="h-24 hidden lg:block" />
      </div>
      <Skeleton className="h-64" />
    </div>
  );
}

/**
 * Role-aware dashboard router.
 *   ASSOCIATE        → personal landing (clock-in, shift, paystub, time-off)
 *   MANAGER          → team-scoped (direct reports, pending approvals)
 *   SHIFT_SUPERVISOR → client-site-scoped ("your site today")
 *   anyone else      → org-wide AdminDashboard, role-filtered internally
 */
export function Dashboard() {
  const { user } = useAuth();
  const Variant =
    user?.role === 'ASSOCIATE'
      ? AssociateDashboard
      : user?.role === 'MANAGER'
        ? ManagerDashboard
        : user?.role === 'SHIFT_SUPERVISOR'
          ? SupervisorDashboard
          : AdminDashboard;
  return (
    <Suspense fallback={<DashboardFallback />}>
      <Variant />
    </Suspense>
  );
}
