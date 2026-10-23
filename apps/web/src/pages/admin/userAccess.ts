import { ROLES, type Role } from '@/lib/roles';
import type { AdminUser, UserStatus } from '@/lib/usersAdminApi';

/**
 * The words and rules Users & access shares between its list, the user
 * drawer and the invite dialog — one place, so a status or a scope reads
 * the same in every one of them.
 */

export const STATUS_OPTIONS: UserStatus[] = ['ACTIVE', 'INVITED', 'DISABLED'];

/** Human labels for the status enum — never show ACTIVE/DISABLED raw. */
export const STATUS_LABELS: Record<UserStatus, string> = {
  ACTIVE: 'Active',
  INVITED: 'Invited',
  DISABLED: 'Disabled',
};

export function statusVariant(status: UserStatus) {
  switch (status) {
    case 'ACTIVE':
      return 'success' as const;
    case 'INVITED':
      return 'pending' as const;
    case 'DISABLED':
      return 'destructive' as const;
  }
}

// LIVE_ASN is excluded — it's the system-integration role; the backend
// rejects assigning it via PATCH and humans don't log in as it.
export const ROLE_OPTIONS: Role[] = (Object.keys(ROLES) as Role[]).filter((r) => r !== 'LIVE_ASN');

// The REQUIRED set mirrors the server's CLIENT_SCOPED_ROLES exactly
// (SHIFT_SUPERVISOR + FLOOR_SUPERVISOR) — those fail closed without a
// client, so clearing is blocked here before the server 400s.
export const CLIENT_REQUIRED_ROLES = new Set<Role>(['SHIFT_SUPERVISOR', 'FLOOR_SUPERVISOR']);

// Bulk role assignment can't collect a per-user client, so roles that
// REQUIRE a client are excluded — assign those one account at a time.
export const BULK_ROLE_OPTIONS: Role[] = ROLE_OPTIONS.filter((r) => !CLIENT_REQUIRED_ROLES.has(r));

/** Roles whose reach is a client or store, not a site/region scope. */
export const BOUNDED_ROLES = new Set<Role>(['ASSOCIATE', 'CLIENT_PORTAL', 'SHIFT_SUPERVISOR', 'FLOOR_SUPERVISOR', 'LIVE_ASN']);

/**
 * The list's status view, in the URL as `?status=`. The default — no
 * param — is everyone who can or soon will sign in (active + invited):
 * the disabled test and former accounts no longer lead the list.
 */
export const STATUS_VIEWS = ['open', 'ACTIVE', 'INVITED', 'DISABLED', 'all'] as const;
export type StatusView = (typeof STATUS_VIEWS)[number];

export function statusesFor(view: StatusView): UserStatus[] | undefined {
  if (view === 'open') return ['ACTIVE', 'INVITED'];
  if (view === 'all') return undefined;
  return [view];
}

/**
 * An account's reach in one phrase: what the Scope column and the drawer
 * say. "All clients" for an org-wide account; the client (and store, or
 * region) for a bounded one; "3 places" for an internal role narrowed to
 * sites and regions.
 */
export function scopeText(u: AdminUser, storeWord = 'store'): string {
  if (u.role === 'CLIENT_PORTAL') {
    if (u.regionName) return `${u.regionName} (region)`;
    if (u.clientName) return u.locationName ? `${u.clientName} · ${u.locationName}` : `${u.clientName} · every ${storeWord}`;
    return 'No client yet';
  }
  const places = (u.scopeSiteIds?.length ?? 0) + (u.scopeRegionIds?.length ?? 0);
  if (places > 0) return `${places} ${places === 1 ? 'place' : 'places'}`;
  if (u.clientName) return u.clientName;
  return CLIENT_REQUIRED_ROLES.has(u.role) ? 'No client yet' : 'All clients';
}
