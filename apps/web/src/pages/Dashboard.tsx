import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from 'react';
import type { AuthUser } from '@alto-people/shared';
import { useAuth } from '@/lib/auth';
import { HomeSkeleton } from '@/components/templates/HomeSkeleton';

/** A role's home: its chunk's loader, and the lazy component over it. */
interface RoleHome {
  load: () => Promise<unknown>;
  View: LazyExoticComponent<ComponentType>;
}
function roleHome<K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K): RoleHome {
  return { load, View: lazy(() => load().then((m) => ({ default: m[name] }))) };
}

// PERF: each variant is its own chunk. All four dashboards used to ride
// statically in the main bundle (~110 KB of TSX plus their api libs) even
// though any given user renders exactly one.
const HOMES = {
  associate: roleHome(() => import('./AssociateDashboard'), 'AssociateDashboard'),
  admin: roleHome(() => import('./AdminDashboard'), 'AdminDashboard'),
  manager: roleHome(() => import('./ManagerDashboard'), 'ManagerDashboard'),
  supervisor: roleHome(() => import('./SupervisorDashboard'), 'SupervisorDashboard'),
  executive: roleHome(() => import('./ExecutiveDashboard'), 'ExecutiveDashboard'),
  clientPortal: roleHome(() => import('./portal/ClientPortalHome'), 'ClientPortalHome'),
  region: roleHome(() => import('./region/RegionHome'), 'RegionHome'),
  finance: roleHome(() => import('./FinanceDashboard'), 'FinanceDashboard'),
  recruiter: roleHome(() => import('./RecruiterDashboard'), 'RecruiterDashboard'),
  workforce: roleHome(() => import('./WorkforceDashboard'), 'WorkforceDashboard'),
  marketing: roleHome(() => import('./marketing/MarketingHome'), 'MarketingHome'),
  driver: roleHome(() => import('./transport/DriverHome'), 'DriverHome'),
  transport: roleHome(() => import('./transport/TransportHome'), 'TransportHome'),
};

/**
 * Role-aware dashboard router.
 *   ASSOCIATE        → personal landing (clock-in, shift, paystub, time-off)
 *   MANAGER          → team-scoped (direct reports, pending approvals)
 *   SHIFT_SUPERVISOR → client-site-scoped ("your site today")
 *   FLOOR_SUPERVISOR → the same floor, watch-only (no scheduling reads)
 *   DRIVER           → their van runs today: on board / no-show
 *   TRANSPORTATION_DIRECTOR → the transportation command center
 *   INTERNAL_RECRUITER → the recruiter's day: interviews, applicants,
 *                      what's waiting on them and on others
 *   anyone else      → org-wide AdminDashboard, role-filtered internally
 */
function homeFor(user: AuthUser | null): RoleHome {
  return user?.role === 'ASSOCIATE'
    ? HOMES.associate
    : user?.role === 'MANAGER'
      ? HOMES.manager
      : user?.role === 'SHIFT_SUPERVISOR' || user?.role === 'FLOOR_SUPERVISOR'
        ? HOMES.supervisor
        : user?.role === 'EXECUTIVE_CHAIRMAN'
          ? HOMES.executive
          : user?.role === 'CLIENT_PORTAL'
            ? user.regionId && !user.clientId
              ? HOMES.region
              : HOMES.clientPortal
            : user?.role === 'FINANCE_ACCOUNTANT'
              ? HOMES.finance
              : user?.role === 'WORKFORCE_MANAGER'
                ? HOMES.workforce
                : user?.role === 'INTERNAL_RECRUITER'
                  ? HOMES.recruiter
                : user?.role === 'MARKETING_MANAGER'
                  ? HOMES.marketing
                : user?.role === 'DRIVER'
                  ? HOMES.driver
                  : user?.role === 'TRANSPORTATION_DIRECTOR'
                    ? HOMES.transport
                    : HOMES.admin;
}

/**
 * Start this person's home chunk downloading now. main.tsx calls it at boot
 * for a returning visitor (see warmSignedInStart in App.tsx), so the chunk
 * arrives alongside /auth/me instead of after it; the lazy view then
 * resolves from the same module.
 */
export function preloadDashboard(user: AuthUser): void {
  void homeFor(user).load().catch(() => undefined);
}

export function Dashboard() {
  const { user } = useAuth();
  const { View } = homeFor(user);
  return (
    <Suspense fallback={<HomeSkeleton />}>
      <View />
    </Suspense>
  );
}
