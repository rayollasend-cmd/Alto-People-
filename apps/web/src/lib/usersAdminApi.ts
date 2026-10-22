import type { Role } from '@alto-people/shared';
import { apiFetch } from './api';

export type UserStatus = 'ACTIVE' | 'DISABLED' | 'INVITED';

export interface AdminUser {
  id: string;
  email: string;
  /** The account's PRIMARY role — what an administrator manages it as. */
  role: Role;
  /** Other roles this one account may switch into. A shift supervisor who
   *  also drives holds DRIVER here rather than a second login. */
  additionalRoles?: Role[];
  /** Which granted role they are working as right now; null = the primary. */
  activeRole?: Role | null;
  /** Brief 2-3 step 3: the custom role narrowing `role`, if any. */
  tenantRoleId?: string | null;
  status: UserStatus;
  createdAt: string;
  associateId: string | null;
  associateName: string | null;
  /** The account's face (associate headshot, else the login's own photo); null when none is on file. */
  photoUrl?: string | null;
  clientId: string | null;
  clientName: string | null;
  /** CLIENT_PORTAL store scope — one Location under the client, or null
   *  for the whole client (a market manager). */
  locationId: string | null;
  locationName: string | null;
  /** CLIENT_PORTAL command-center scope (a region; client + store are null). */
  regionId: string | null;
  regionName: string | null;
  /** Non-null iff the account is currently brute-force locked (the server
   *  only surfaces locks that are still in the future). */
  lockedUntil: string | null;
  /** Access pack: an internal role narrowed to these sites/regions (empty = whole tenant). */
  scopeSiteIds?: string[];
  scopeRegionIds?: string[];
  /** Access pack: may sign in with password + two-step while SSO is required. */
  breakGlass?: boolean;
  mfaEnabled?: boolean;
  /** SHIFT_SUPERVISOR: the store shift windows they lead ("their shift"). */
  shiftWindows?: Array<{ locationId: string; locationName: string; label: string }>;
  /** A floor supervisor's shift supervisor (null when unassigned or the
   *  link no longer holds). */
  leadUserId?: string | null;
  leadName?: string | null;
  /** Brief 1A-4: last sign-in and the reversible deactivation state. */
  lastSeenAt?: string | null;
  deactivatedAt?: string | null;
  deactivationReason?: string | null;
  /** When set, the account is DISABLED and will be deleted on this day unless reactivated. */
  purgeAfter?: string | null;
}

export interface ListUsersFilters {
  role?: Role;
  status?: UserStatus;
  q?: string;
}

export interface ListUsersResponse {
  users: AdminUser[];
  /** Total matching rows server-side — may exceed users.length when the
   *  list is capped, so callers can render "Showing N of M". */
  total: number;
}

export function listAdminUsers(
  filters: ListUsersFilters = {},
): Promise<ListUsersResponse> {
  const params = new URLSearchParams();
  if (filters.role) params.set('role', filters.role);
  if (filters.status) params.set('status', filters.status);
  if (filters.q) params.set('q', filters.q);
  const qs = params.toString();
  return apiFetch<ListUsersResponse>(
    `/admin/users${qs ? `?${qs}` : ''}`,
  );
}

export interface UserCountsResponse {
  counts: Record<UserStatus, number>;
  total: number;
}

/** Uncapped per-status account counts — the honest source for seat math. */
export function getUserCounts(): Promise<UserCountsResponse> {
  return apiFetch<UserCountsResponse>('/admin/users/counts');
}

export function patchAdminUser(
  id: string,
  body: {
    role?: Role;
    /** Sent whole — the array replaces what is there, so [] revokes all. */
    additionalRoles?: Role[];
    status?: UserStatus;
    clientId?: string | null;
    locationId?: string | null;
    regionId?: string | null;
    /** Brief 1A-4: required when regionId names a new region — an active
     *  account that holds manage:org, recorded in the audit log. */
    approvedByUserId?: string;
    /** Access pack: sent whole; [] clears. Needs approvedByUserId when non-empty. */
    scopeSiteIds?: string[];
    scopeRegionIds?: string[];
    /** Access pack: needs approvedByUserId when turning on; the account must hold two-step. */
    breakGlass?: boolean;
  },
): Promise<void | { pending: true; approvalId: string; title: string }> {
  // 204 when it landed; 202 with the approval when more access waits for a second administrator.
  return apiFetch<void | { pending: true; approvalId: string; title: string }>(`/admin/users/${id}`, { method: 'PATCH', body });
}

export function forcePasswordReset(id: string): Promise<void> {
  return apiFetch<void>(`/admin/users/${id}/force-password-reset`, {
    method: 'POST',
  });
}

/** Clear a brute-force lock (failed-login counter + lockedUntil). */
export function unlockUser(id: string): Promise<void> {
  return apiFetch<void>(`/admin/users/${id}/unlock`, { method: 'POST' });
}

/* ===== Brief 1A-4: the access report and the reversible deactivation ===== */

export type AccessFlag =
  | 'PORTAL_PERSONAL_EMAIL'
  | 'REGION_SCOPE'
  | 'DUPLICATE_PERSON'
  | 'NO_EMPLOYMENT_RECORD'
  | 'EMPLOYMENT_ENDED'
  | 'NO_SIGN_IN_90D'
  | 'PENDING_DELETION';

export const ACCESS_FLAGS: readonly AccessFlag[] = [
  'PORTAL_PERSONAL_EMAIL',
  'REGION_SCOPE',
  'DUPLICATE_PERSON',
  'NO_EMPLOYMENT_RECORD',
  'EMPLOYMENT_ENDED',
  'NO_SIGN_IN_90D',
  'PENDING_DELETION',
];

export const ACCESS_FLAG_LABEL: Record<AccessFlag, string> = {
  PORTAL_PERSONAL_EMAIL: 'Portal login on a personal email',
  REGION_SCOPE: 'Region scope',
  DUPLICATE_PERSON: 'Same person, more than one account',
  NO_EMPLOYMENT_RECORD: 'No employment record',
  EMPLOYMENT_ENDED: 'Employment ended, account still on',
  NO_SIGN_IN_90D: 'No sign-in in 90 days',
  PENDING_DELETION: 'Deactivated, deletion pending',
};

export type EmploymentState = 'EMPLOYED' | 'SEPARATED' | 'DEACTIVATED' | 'ERASED' | 'NONE' | 'NOT_APPLICABLE';

export const EMPLOYMENT_LABEL: Record<EmploymentState, string> = {
  EMPLOYED: 'Employed',
  SEPARATED: 'Separated',
  DEACTIVATED: 'Deactivated',
  ERASED: 'Erased',
  NONE: 'No record',
  NOT_APPLICABLE: '—',
};

export interface AccessReportRow {
  id: string;
  email: string;
  personalEmail: boolean;
  role: Role;
  additionalRoles: Role[];
  status: UserStatus;
  /** One line: "Coastal Resort · Pier Park", "Region: Panhandle", "Org-wide". */
  scope: string;
  clientId: string | null;
  locationId: string | null;
  regionId: string | null;
  associateId: string | null;
  personName: string | null;
  employment: EmploymentState;
  createdAt: string;
  lastSignInAt: string | null;
  daysSinceSignIn: number | null;
  deactivatedAt: string | null;
  deactivationReason: string | null;
  purgeAfter: string | null;
  flags: AccessFlag[];
}

export interface AccessReport {
  generatedAt: string;
  counts: {
    totalAccounts: number;
    byStatus: Record<UserStatus, number>;
    byRole: Record<string, number>;
    /** The one definition of active (lib/activeDefinition). */
    activeAssociates: number;
    flaggedAccounts: number;
    byFlag: Record<AccessFlag, number>;
  };
  rows: AccessReportRow[];
}

export function getAccessReport(): Promise<AccessReport> {
  return apiFetch<AccessReport>('/admin/users/access-report');
}

/** The server's CSV, saved through the browser. */
export async function downloadAccessReportCsv(): Promise<void> {
  const res = await fetch('/api/admin/users/access-report?format=csv', { method: 'GET', credentials: 'include' });
  if (!res.ok) throw new Error(`Could not download the access report (${res.status}).`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const m = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '');
  const a = document.createElement('a');
  a.href = url;
  a.download = m?.[1] ?? 'access-report.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export interface DeactivateUsersResult {
  deactivated: Array<{ id: string; email: string; purgeAfter: string }>;
  skipped: Array<{ id: string; reason: string }>;
}

/** Bulk, with a reason; audited per account; reversible for 30 days. */
export function deactivateUsers(userIds: string[], reason: string): Promise<DeactivateUsersResult> {
  return apiFetch<DeactivateUsersResult>('/admin/users/deactivate', { method: 'POST', body: { userIds, reason } });
}

/** Within the 30-day grace period: everything back. */
export function reactivateUser(id: string): Promise<{ id: string; status: 'ACTIVE' | 'INVITED' }> {
  return apiFetch(`/admin/users/${id}/reactivate`, { method: 'POST' });
}
