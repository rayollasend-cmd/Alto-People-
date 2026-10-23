import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { isClientBoundedRole, type Capability } from '@alto-people/shared';
import { useAuth } from './auth';
import { NoAccess } from '@/components/ui/NoAccess';

/**
 * Route guard for pages that require a capability beyond `view:dashboard`.
 *
 * The sidebar already filters its module list by capability so users don't
 * see entries they can't reach via the nav. But routes without a `modules.ts`
 * entry (settings, templates, learning, reports, worktags, etc.) are still
 * mounted in App.tsx and would render on a deep-link from a logged-in user
 * who lacks the capability — even if the API would reject the underlying
 * fetches. Wrapping those routes in this component swaps the page for the
 * friendly access page (components/ui/NoAccess) instead: the chrome stays,
 * the person reads "You don't have access to this page" and who to ask —
 * not the raw "Missing capability: view:org" the page's fetches would have
 * printed, and nothing of what the page holds.
 *
 * A route that mounts a module's page carries the module's own requirement
 * (lib/modules `requires` / `requiresAny`); __tests__/lib/routeGuards.test
 * fails a module route left unguarded or guarded differently.
 */
export function RequireCapability({
  cap,
  anyOf,
  notClientBounded = false,
  selfService,
  children,
}: {
  cap: Capability;
  /** When set, holding ANY of these also grants the page (cap ∪ anyOf). */
  anyOf?: Capability[];
  /** Refuse client-bound roles (SHIFT_SUPERVISOR…) even when they hold the
   *  capability — for org-level pages like Labor costs, which the
   *  supervisor's manage:scheduling would otherwise unlock. */
  notClientBounded?: boolean;
  /** Someone with their own record (an associate) who can't open the page
   *  is sent to their own version of it instead of the access page — the
   *  org's Expirations sends them to "My credentials". */
  selfService?: string;
  children: ReactNode;
}) {
  const { can, user } = useAuth();
  const ok =
    (can(cap) || (anyOf?.some(can) ?? false)) &&
    !(notClientBounded && user && isClientBoundedRole(user.role));
  if (!ok) {
    if (selfService && user?.associateId) return <Navigate to={selfService} replace />;
    return <NoAccess />;
  }
  return <>{children}</>;
}
