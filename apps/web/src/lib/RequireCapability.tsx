import type { ReactNode } from 'react';
import { isClientBoundedRole, type Capability } from '@alto-people/shared';
import { useAuth } from './auth';
import { NotFound } from '@/pages/NotFound';

/**
 * Route guard for pages that require a capability beyond `view:dashboard`.
 *
 * The sidebar already filters its module list by capability so users don't
 * see entries they can't reach via the nav. But routes without a `modules.ts`
 * entry (settings, templates, learning, reports, worktags, etc.) are still
 * mounted in App.tsx and would render on a deep-link from a logged-in user
 * who lacks the capability — even if the API would reject the underlying
 * fetches. Wrapping those routes in this component swaps the page for the
 * styled in-Layout 404 instead, which keeps the chrome intact and signals
 * to the user that the page isn't theirs without leaking what's there.
 */
export function RequireCapability({
  cap,
  anyOf,
  notClientBounded = false,
  children,
}: {
  cap: Capability;
  /** When set, holding ANY of these also grants the page (cap ∪ anyOf). */
  anyOf?: Capability[];
  /** Refuse client-bound roles (SHIFT_SUPERVISOR…) even when they hold the
   *  capability — for org-level pages like Labor costs, which the
   *  supervisor's manage:scheduling would otherwise unlock. */
  notClientBounded?: boolean;
  children: ReactNode;
}) {
  const { can, user } = useAuth();
  const ok =
    (can(cap) || (anyOf?.some(can) ?? false)) &&
    !(notClientBounded && user && isClientBoundedRole(user.role));
  if (!ok) {
    return <NotFound />;
  }
  return <>{children}</>;
}
