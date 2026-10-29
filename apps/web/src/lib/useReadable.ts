import type { Capability } from '@alto-people/shared';
import { useAuth } from './auth';

/**
 * Whether the signed-in role may make a read — pass it to the query's
 * `enabled` so a page never fires a request the API is certain to refuse.
 *
 * The deep audit of 2026-10-29 (CRAWL-15) found pages calling endpoints
 * their viewer can't read: the chairman's /payroll and /integrations asked
 * for the payroll config and the payout webhook's health (process:payroll),
 * an admin's /rides asked for "my rides" with no person record behind the
 * account, a supervisor's onboarding list loaded every client. Each one was
 * a silent 403 in the console and, on some pages, an error state where the
 * section should simply not have been.
 *
 *   const canSeeRail = useReadable('process:payroll');
 *   useQuery({ queryKey, queryFn, enabled: canSeeRail });
 *
 *   // any of several capabilities (the API's requireAnyCapability):
 *   useReadable(['manage:scheduling', 'view:executive']);
 *
 *   // a self-service read (/me/…, /transport/me) needs a person record too:
 *   useReadable('ride:transport', { self: true });
 *
 * Name the capability the API route checks (its requireCapability), not the
 * one the page's guard checks — they differ exactly where this matters.
 */
export function useReadable(cap: Capability | readonly Capability[], opts: { self?: boolean } = {}): boolean {
  const { can, user } = useAuth();
  return readable(can, user?.associateId ?? null, cap, opts);
}

/** The rule itself, for code with `can` already in hand (and for tests). */
export function readable(
  can: (c: Capability) => boolean,
  associateId: string | null | undefined,
  cap: Capability | readonly Capability[],
  opts: { self?: boolean } = {},
): boolean {
  const caps: readonly Capability[] = typeof cap === 'string' ? [cap] : cap;
  if (!caps.some((c) => can(c))) return false;
  if (opts.self && !associateId) return false;
  return true;
}
