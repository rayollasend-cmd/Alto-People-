import type {
  AssociateDeactivateResponse,
  AssociateOrgAssignmentInput,
  AssociateOrgListResponse,
  AssociateProfilePatchInput,
  AssociateTransferInput,
  AssociateTransferResponse,
  CostCenter,
  CostCenterInput,
  CostCenterListResponse,
  Department,
  DepartmentInput,
  DepartmentListResponse,
  JobProfile,
  JobProfileInput,
  JobProfileListResponse,
  ShiftPosition,
  ShiftPositionInput,
  ShiftPositionListResponse,
  SiteType,
} from '@alto-people/shared';
import { apiFetch, ApiError, NetworkError } from './api';

export function patchAssociateProfile(
  associateId: string,
  input: AssociateProfilePatchInput,
): Promise<{ id: string; phone: string | null }> {
  return apiFetch(`/org/associates/${associateId}`, {
    method: 'PATCH',
    body: input,
  });
}

/** Temporary pause — login disabled, kiosk blocked, future shifts released. */
export function deactivateAssociate(
  associateId: string,
  reason: string,
): Promise<AssociateDeactivateResponse> {
  return apiFetch(`/org/associates/${associateId}/deactivate`, {
    method: 'POST',
    body: { reason },
  });
}

/** Undoes deactivateAssociate — record intact, login restored. */
export function reactivateAssociate(associateId: string): Promise<{ ok: true }> {
  return apiFetch(`/org/associates/${associateId}/reactivate`, {
    method: 'POST',
  });
}

// HR-side profile photo. Multipart, so it can't go through apiFetch's
// JSON body encoding — same raw-fetch pattern as selfApi.uploadProfilePhoto.
export async function uploadAssociatePhoto(
  associateId: string,
  file: Blob,
): Promise<{ photoUrl: string }> {
  const fd = new FormData();
  fd.append('file', file, 'photo.jpg');
  let res: Response;
  try {
    res = await fetch(`/api/associates/${associateId}/photo`, {
      method: 'POST',
      credentials: 'include',
      body: fd,
    });
  } catch (err) {
    throw new NetworkError(err);
  }
  if (!res.ok) {
    let parsed: { error?: { code?: string; message?: string } } | null = null;
    try {
      parsed = await res.json();
    } catch {
      /* empty body */
    }
    throw new ApiError(
      res.status,
      parsed?.error?.code ?? `http_${res.status}`,
      parsed?.error?.message ?? 'Failed to upload photo.',
    );
  }
  return (await res.json()) as { photoUrl: string };
}

export const deleteAssociatePhoto = (associateId: string) =>
  apiFetch<void>(`/associates/${associateId}/photo`, { method: 'DELETE' });

export function transferAssociate(
  associateId: string,
  input: AssociateTransferInput,
): Promise<AssociateTransferResponse> {
  return apiFetch<AssociateTransferResponse>(
    `/org/associates/${associateId}/transfer`,
    { method: 'POST', body: input },
  );
}

export interface PayoutMethodSummary {
  hasPayoutMethod: boolean;
  type?: 'BANK_ACCOUNT' | 'BRANCH_CARD';
  accountType?: string | null;
  bankName?: string | null;
  routingMasked?: string | null;
  accountLast4?: string | null;
  branchCardId?: string | null;
  verifiedAt?: string | null;
  updatedAt?: string | null;
}

export interface PayoutMethodReveal {
  type: 'BANK_ACCOUNT' | 'BRANCH_CARD';
  accountType: string | null;
  bankName: string | null;
  routingNumber: string | null;
  accountNumber: string | null;
  branchCardId: string | null;
  verifiedAt: string | null;
  updatedAt: string | null;
}

export function getAssociatePayoutMethod(
  associateId: string,
): Promise<PayoutMethodSummary> {
  return apiFetch(`/org/associates/${associateId}/payout-method`);
}

export function revealAssociatePayoutMethod(
  associateId: string,
  reason: string,
): Promise<PayoutMethodReveal> {
  return apiFetch(`/org/associates/${associateId}/payout-method/reveal`, {
    method: 'POST',
    body: { reason },
  });
}

/**
 * Set the institution name on an existing bank-account payout method.
 *
 * Backfill path: bankName was added after most associates onboarded, so
 * their records carry a blank the external payroll file expects. Scoped to
 * the label — routing and account numbers stay writable only by the
 * associate (via self-service, which emails a change confirmation) so no
 * admin endpoint can redirect where money lands.
 */
export function setAssociateBankName(
  associateId: string,
  bankName: string,
): Promise<{ bankName: string }> {
  return apiFetch(`/org/associates/${associateId}/payout-method`, {
    method: 'PATCH',
    body: { bankName },
  });
}

export interface SsnSummary {
  hasSsn: boolean;
  ssnLast4: string | null;
  /** W4 = W-2 employee's W-4 submission; TIN = 1099 contractor's TIN. */
  source: 'W4' | 'TIN' | null;
}

export interface SsnReveal {
  kind: 'SSN' | 'EIN';
  source: 'W4' | 'TIN';
  number: string;
}

export function getAssociateSsn(associateId: string): Promise<SsnSummary> {
  return apiFetch(`/org/associates/${associateId}/ssn`);
}

export interface AssociatePersonalInfo {
  middleInitial: string | null;
  otherLastNames: string[];
  /** Calendar date, YYYY-MM-DD — never a timestamp. */
  dob: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}

export function getAssociatePersonalInfo(
  associateId: string,
): Promise<AssociatePersonalInfo> {
  return apiFetch(`/org/associates/${associateId}/personal-info`);
}

export interface ErasureCounts {
  userDisabled: number;
  passkeysDeleted: number;
  mfaRecoveryCodesDeleted: number;
  authTokensDeleted: number;
  pushSubscriptionsDeleted: number;
  w4SsnCleared: number;
  payoutMethodsScrubbed: number;
  documentsSoftDeleted: number;
  documentBlobsUnlinked: number;
  emergencyContactsDeleted: number;
  kioskPinsDeleted: number;
  kioskSelfiesPurged: number;
  faceReferenceCleared: number;
  notificationsScrubbed: number;
}

/**
 * Irreversible privacy erasure: anonymizes the associate's identity and
 * scrubs credentials/ciphertext while payroll and tax history is retained
 * (legal requirement). Requires retyping the associate's last name and a
 * written reason; `force` overrides the not-yet-separated guard only.
 */
export function eraseAssociatePersonalData(
  associateId: string,
  body: { reason: string; confirmName: string; force?: boolean },
): Promise<{ ok: boolean; erasedAt: string; counts: ErasureCounts }> {
  return apiFetch(`/org/associates/${associateId}/erase`, {
    method: 'POST',
    body,
  });
}

/** Audited full-number reveal — requires a written reason; every call
 *  lands an AuditLog row before the number is returned. */
export function revealAssociateSsn(
  associateId: string,
  reason: string,
): Promise<SsnReveal> {
  return apiFetch(`/org/associates/${associateId}/ssn/reveal`, {
    method: 'POST',
    body: { reason },
  });
}

// ----- HR-facing W-4 view / edit ------------------------------------------

export interface AssociateW4 {
  employmentType: string;
  hasSubmission: boolean;
  hasSsnOnFile: boolean;
  ssnLast4: string | null;
  filingStatus: 'SINGLE' | 'MARRIED_FILING_JOINTLY' | 'HEAD_OF_HOUSEHOLD' | null;
  multipleJobs: boolean;
  dependentsAmount: number | null;
  otherIncome: number | null;
  deductions: number | null;
  extraWithholding: number | null;
  signedAt: string | null;
  updatedAt: string | null;
}

export function getAssociateW4(associateId: string): Promise<AssociateW4> {
  return apiFetch(`/org/associates/${associateId}/w4`);
}

/** Edit an onboarded W-2 employee's W-4 on their behalf (audited). Never
 *  touches the SSN. Applies from the next payroll run. */
export function updateAssociateW4(
  associateId: string,
  body: {
    filingStatus: NonNullable<AssociateW4['filingStatus']>;
    multipleJobs?: boolean;
    dependentsAmount?: number;
    otherIncome?: number;
    deductions?: number;
    extraWithholding?: number;
  },
): Promise<{ ok: boolean; effectiveNote: string }> {
  return apiFetch(`/org/associates/${associateId}/w4`, {
    method: 'PATCH',
    body,
  });
}

/**
 * Bulk payroll-provider census export. Streams a CSV of every ACTIVE
 * associate's decrypted SSN + bank details and triggers a browser download.
 *
 * This is the most sensitive export in the app: it requires process:payroll,
 * a written reason (min 8 chars), and the server writes one audit row naming
 * the actor, the reason, and every associate in the file BEFORE the download
 * streams. Returns the row count so the caller can confirm what was pulled.
 *
 * Hand the file to the provider's secure portal — never email it — and delete
 * the local copy once the import is confirmed.
 */
export async function downloadPayrollCensus(
  reason: string,
): Promise<{ rowCount: number; decryptFailures: number }> {
  const res = await fetch('/api/org/associates/payroll-census-export', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
  if (!res.ok) {
    let message = `Could not export census (${res.status}).`;
    try {
      const body = await res.json();
      if (body?.error?.message) message = body.error.message;
    } catch {
      /* non-JSON error body — keep the default */
    }
    throw new Error(message);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const cd = res.headers.get('content-disposition') ?? '';
  const m = /filename="([^"]+)"/.exec(cd);
  const filename = m?.[1] ?? 'payroll-census.csv';
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return {
    rowCount: Number(res.headers.get('x-row-count') ?? 0),
    decryptFailures: Number(res.headers.get('x-decrypt-failures') ?? 0),
  };
}

export function listDepartments(clientId?: string): Promise<DepartmentListResponse> {
  const q = clientId ? `?clientId=${encodeURIComponent(clientId)}` : '';
  return apiFetch<DepartmentListResponse>(`/org/departments${q}`);
}
export function createDepartment(input: DepartmentInput): Promise<Department> {
  return apiFetch<Department>('/org/departments', { method: 'POST', body: input });
}
export function updateDepartment(
  id: string,
  input: Partial<DepartmentInput>,
): Promise<Department> {
  return apiFetch<Department>(`/org/departments/${id}`, { method: 'PUT', body: input });
}
export function deleteDepartment(id: string): Promise<void> {
  return apiFetch<void>(`/org/departments/${id}`, { method: 'DELETE' });
}

export function listCostCenters(clientId?: string): Promise<CostCenterListResponse> {
  const q = clientId ? `?clientId=${encodeURIComponent(clientId)}` : '';
  return apiFetch<CostCenterListResponse>(`/org/cost-centers${q}`);
}
export function createCostCenter(input: CostCenterInput): Promise<CostCenter> {
  return apiFetch<CostCenter>('/org/cost-centers', { method: 'POST', body: input });
}
export function updateCostCenter(
  id: string,
  input: Partial<CostCenterInput>,
): Promise<CostCenter> {
  return apiFetch<CostCenter>(`/org/cost-centers/${id}`, { method: 'PUT', body: input });
}
export function deleteCostCenter(id: string): Promise<void> {
  return apiFetch<void>(`/org/cost-centers/${id}`, { method: 'DELETE' });
}

export function listJobProfiles(clientId?: string): Promise<JobProfileListResponse> {
  const q = clientId ? `?clientId=${encodeURIComponent(clientId)}` : '';
  return apiFetch<JobProfileListResponse>(`/org/job-profiles${q}`);
}
export function createJobProfile(input: JobProfileInput): Promise<JobProfile> {
  return apiFetch<JobProfile>('/org/job-profiles', { method: 'POST', body: input });
}
export function updateJobProfile(
  id: string,
  input: Partial<JobProfileInput>,
): Promise<JobProfile> {
  return apiFetch<JobProfile>(`/org/job-profiles/${id}`, { method: 'PUT', body: input });
}
export function deleteJobProfile(id: string): Promise<void> {
  return apiFetch<void>(`/org/job-profiles/${id}`, { method: 'DELETE' });
}

export function listShiftPositions(
  clientId?: string,
): Promise<ShiftPositionListResponse> {
  const q = clientId ? `?clientId=${encodeURIComponent(clientId)}` : '';
  return apiFetch<ShiftPositionListResponse>(`/org/shift-positions${q}`);
}
export function createShiftPosition(
  input: ShiftPositionInput,
): Promise<ShiftPosition> {
  return apiFetch<ShiftPosition>('/org/shift-positions', {
    method: 'POST',
    body: input,
  });
}
export function updateShiftPosition(
  id: string,
  input: Partial<ShiftPositionInput>,
): Promise<ShiftPosition> {
  return apiFetch<ShiftPosition>(`/org/shift-positions/${id}`, {
    method: 'PUT',
    body: input,
  });
}
export function deleteShiftPosition(id: string): Promise<void> {
  return apiFetch<void>(`/org/shift-positions/${id}`, { method: 'DELETE' });
}

export function listOrgAssociates(clientId?: string): Promise<AssociateOrgListResponse> {
  const q = clientId ? `?clientId=${encodeURIComponent(clientId)}` : '';
  return apiFetch<AssociateOrgListResponse>(`/org/associates${q}`);
}
export function assignOrgFields(
  associateId: string,
  input: AssociateOrgAssignmentInput,
): Promise<{
  id: string;
  managerId: string | null;
  departmentId: string | null;
  costCenterId: string | null;
  jobProfileId: string | null;
}> {
  return apiFetch(`/org/associates/${associateId}/org`, {
    method: 'PUT',
    body: input,
  });
}

export interface AssociateHistoryEntry {
  id: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  managerId: string | null;
  departmentId: string | null;
  costCenterId: string | null;
  jobProfileId: string | null;
  state: string | null;
  hourlyRate: string | null;
  reason: string | null;
  actorEmail: string | null;
  createdAt: string;
}

export function listAssociateHistory(
  associateId: string,
): Promise<{ history: AssociateHistoryEntry[] }> {
  return apiFetch(`/org/associates/${associateId}/history`);
}

export function getAssociateAsOf(
  associateId: string,
  when?: string,
): Promise<{
  when: string;
  snapshot: {
    managerId: string | null;
    departmentId: string | null;
    costCenterId: string | null;
    jobProfileId: string | null;
    state: string | null;
    hourlyRate: string | null;
  } | null;
}> {
  const q = when ? `?when=${encodeURIComponent(when)}` : '';
  return apiFetch(`/org/associates/${associateId}/as-of${q}`);
}

/**
 * Brief 2-1b steps 4–7 — the organization behind the people: employers of
 * record, the organizational tree, and the sites.
 */

/* ----- Employers of record --------------------------------------------- */

export type EmployerKind = 'TENANT' | 'CLIENT' | 'THIRD_PARTY';

export interface EmployerRow {
  id: string;
  kind: EmployerKind;
  legalName: string;
  ein: string | null;
  address: { line1: string | null; line2: string | null; city: string | null; state: string | null; zip: string | null };
  sutaRateOverride: number | null;
  sutaWageBaseOverride: number | null;
  clientId: string | null;
  clientName: string | null;
  isDefault: boolean;
  /** Open employment spells on this employer. */
  employments: number;
}

export interface EmployerFactsInput {
  legalName?: string;
  ein?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  sutaRateOverride?: number | null;
  sutaWageBaseOverride?: number | null;
}

export const listEmployers = () => apiFetch<{ employers: EmployerRow[] }>('/admin/employers');
export const createEmployer = (body: EmployerFactsInput & { legalName: string }) =>
  apiFetch<{ employer: EmployerRow }>('/admin/employers', { method: 'POST', body });
export const updateEmployer = (id: string, body: EmployerFactsInput) =>
  apiFetch<{ employer: EmployerRow }>(`/admin/employers/${encodeURIComponent(id)}`, { method: 'PATCH', body });

export interface EmploymentSpell {
  id: string;
  employer: { id: string; kind: EmployerKind; legalName: string; ein: string | null; clientId: string | null };
  employmentType: string;
  hireDate: string;
  endDate: string | null;
  applicationId: string | null;
  site: { id: string; name: string } | null;
}

export const getEmploymentHistory = (associateId: string) =>
  apiFetch<{ employment: EmploymentSpell[] }>(`/org/associates/${encodeURIComponent(associateId)}/employment`);

/* ----- The organizational tree ----------------------------------------- */

export type OrgUnitType = 'DIVISION' | 'REGION' | 'BUSINESS_UNIT' | 'COST_CENTER';

export const ORG_UNIT_TYPES: OrgUnitType[] = ['DIVISION', 'REGION', 'BUSINESS_UNIT', 'COST_CENTER'];
export const ORG_UNIT_TYPE_LABEL: Record<OrgUnitType, string> = {
  DIVISION: 'Division',
  REGION: 'Region',
  BUSINESS_UNIT: 'Business unit',
  COST_CENTER: 'Cost center',
};

export interface OrgUnitRow {
  id: string;
  type: OrgUnitType;
  parentId: string | null;
  name: string;
  code: string | null;
  glCode: string | null;
  /** "/<root id>/…/<this id>": depth = ids − 1. */
  path: string;
  clientId: string | null;
  isActive: boolean;
  sites: number;
  legacyRegionId: string | null;
  legacyCostCenterId: string | null;
}

export interface OrgUnitInput {
  type: OrgUnitType;
  name: string;
  parentId?: string | null;
  code?: string | null;
  glCode?: string | null;
  clientId?: string | null;
}

export const listOrgUnits = () => apiFetch<{ units: OrgUnitRow[] }>('/admin/org-units');
export const createOrgUnit = (body: OrgUnitInput) => apiFetch<{ unit: OrgUnitRow }>('/admin/org-units', { method: 'POST', body });
export const updateOrgUnit = (id: string, body: Partial<Omit<OrgUnitInput, 'type'>> & { isActive?: boolean }) =>
  apiFetch<{ unit: OrgUnitRow }>(`/admin/org-units/${encodeURIComponent(id)}`, { method: 'PATCH', body });
export const deleteOrgUnit = (id: string) => apiFetch<void>(`/admin/org-units/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const setOrgUnitSites = (id: string, locationIds: string[]) =>
  apiFetch<void>(`/admin/org-units/${encodeURIComponent(id)}/sites`, { method: 'PUT', body: { locationIds } });

export interface UnitSite {
  id: string;
  name: string;
  clientId: string | null;
  clientName: string | null;
  orgUnitId: string | null;
}
export const listOrgUnitSites = (id: string) => apiFetch<{ sites: UnitSite[] }>(`/admin/org-units/${encodeURIComponent(id)}/sites`);

/** Depth from the path: a root is 0. */
export function unitDepth(path: string): number {
  return Math.max(0, path.split('/').filter(Boolean).length - 1);
}

/* ----- Sites ------------------------------------------------------------- */

export interface SiteRow {
  id: string;
  name: string;
  type: SiteType;
  timezone: string;
  state: string | null;
  isActive: boolean;
  clientId: string | null;
  clientName: string | null;
  orgUnitId: string | null;
  orgUnitName: string | null;
  orgUnitType: OrgUnitType | null;
  /** The region it sits in (the Org chart's field view moves it). */
  regionId?: string | null;
  regionName?: string | null;
}

export interface SiteCreateInput {
  name: string;
  type?: SiteType;
  timezone?: string;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  orgUnitId?: string | null;
}

export const SITE_TYPE_LABEL: Record<SiteType, string> = {
  STORE: 'Store',
  PROPERTY: 'Property',
  OFFICE: 'Office',
  WAREHOUSE: 'Warehouse',
  OTHER: 'Other',
};

export const listSites = () => apiFetch<{ sites: SiteRow[] }>('/admin/sites');
export const createSite = (body: SiteCreateInput) => apiFetch<{ site: SiteRow }>('/admin/sites', { method: 'POST', body });

/** PATCH /admin/sites/:id — only the fields given change; the body is strict. */
export type SiteUpdateInput = Partial<SiteCreateInput> & { isActive?: boolean };
export const updateSite = (id: string, body: SiteUpdateInput) =>
  apiFetch<{ site: Omit<SiteRow, 'clientName' | 'orgUnitName' | 'orgUnitType' | 'regionId' | 'regionName'> }>(`/admin/sites/${encodeURIComponent(id)}`, { method: 'PATCH', body });

export interface ProfilePhotoHealth {
  /** 'local' or 's3'. */
  driver: string;
  /** False when uploads are written somewhere a redeploy wipes. */
  durable: boolean;
  onFile: number;
  /** Photos the database points at whose file is gone. */
  missing: number;
  truncated: boolean;
}

/** Whether this deployment keeps profile photos, and how many are already lost. */
export const getProfilePhotoHealth = () =>
  apiFetch<ProfilePhotoHealth>('/profile-photos/health');

/** Forget photos whose file is gone, so those people are asked again. */
export const clearMissingProfilePhotos = () =>
  apiFetch<{ cleared: number }>('/profile-photos/clear-missing', { method: 'POST', body: {} });
