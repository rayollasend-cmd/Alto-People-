import { ApiError, apiFetch, NetworkError } from './api';

export interface SelfProfile {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  employmentType: string;
  photoUrl: string | null;
  department: { name: string } | null;
  jobProfile: { title: string } | null;
}

export interface EmergencyContact {
  id: string;
  name: string;
  relation: 'SPOUSE' | 'PARENT' | 'CHILD' | 'SIBLING' | 'FRIEND' | 'OTHER';
  phone: string;
  email: string | null;
  isPrimary: boolean;
}

export interface Dependent {
  id: string;
  firstName: string;
  lastName: string;
  relation: 'SPOUSE' | 'CHILD' | 'DOMESTIC_PARTNER' | 'OTHER';
  dob: string | null;
  ssnLast4: string | null;
  isCovered: boolean;
}

export interface Beneficiary {
  id: string;
  name: string;
  relation: 'SPOUSE' | 'CHILD' | 'DOMESTIC_PARTNER' | 'OTHER';
  kind: 'PRIMARY' | 'CONTINGENT';
  percentage: number;
  dependentId: string | null;
}

export interface LifeEvent {
  id: string;
  kind: string;
  eventDate: string;
  status: 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED';
  notes: string | null;
  createdAt: string;
}

export interface TaxDoc {
  id: string;
  kind: 'W2' | 'W3' | 'N_1099_NEC' | 'N_1095_C';
  taxYear: number;
  issuedAt: string;
  fileSize: number | null;
}

export const getProfile = () => apiFetch<SelfProfile>('/self/me/profile');
export const updateSelfProfile = (input: Partial<Pick<SelfProfile, 'phone' | 'addressLine1' | 'addressLine2' | 'city' | 'state' | 'zip'>>) =>
  apiFetch<{ ok: true }>('/self/me/profile', { method: 'PUT', body: input });

export const listEmergency = () =>
  apiFetch<{ contacts: EmergencyContact[] }>('/self/me/emergency-contacts');
export const createEmergency = (
  input: Omit<EmergencyContact, 'id' | 'isPrimary'> & { isPrimary?: boolean },
) =>
  apiFetch<{ ok: true }>('/self/me/emergency-contacts', {
    method: 'POST',
    body: input,
  });
export const updateEmergency = (id: string, input: Partial<EmergencyContact>) =>
  apiFetch<{ ok: true }>(`/self/me/emergency-contacts/${id}`, {
    method: 'PUT',
    body: input,
  });
export const deleteEmergency = (id: string) =>
  apiFetch<void>(`/self/me/emergency-contacts/${id}`, { method: 'DELETE' });

export const listDependents = () =>
  apiFetch<{ dependents: Dependent[] }>('/self/me/dependents');
export const createDependent = (input: Omit<Dependent, 'id'>) =>
  apiFetch<{ id: string }>('/self/me/dependents', {
    method: 'POST',
    body: input,
  });
export const updateDependent = (id: string, input: Partial<Dependent>) =>
  apiFetch<{ ok: true }>(`/self/me/dependents/${id}`, {
    method: 'PUT',
    body: input,
  });
export const deleteDependent = (id: string) =>
  apiFetch<void>(`/self/me/dependents/${id}`, { method: 'DELETE' });

export const listBeneficiaries = () =>
  apiFetch<{ beneficiaries: Beneficiary[] }>('/self/me/beneficiaries');
export const createBeneficiary = (input: Omit<Beneficiary, 'id'>) =>
  apiFetch<{ ok: true }>('/self/me/beneficiaries', {
    method: 'POST',
    body: input,
  });
export const updateBeneficiary = (id: string, input: Partial<Beneficiary>) =>
  apiFetch<{ ok: true }>(`/self/me/beneficiaries/${id}`, {
    method: 'PUT',
    body: input,
  });
export const deleteBeneficiary = (id: string) =>
  apiFetch<void>(`/self/me/beneficiaries/${id}`, { method: 'DELETE' });

export const listLifeEvents = () =>
  apiFetch<{ events: LifeEvent[] }>('/self/me/life-events');
export const createLifeEvent = (input: {
  kind: string;
  eventDate: string;
  notes?: string | null;
}) =>
  apiFetch<{ id: string }>('/self/me/life-events', {
    method: 'POST',
    body: input,
  });

export const listTaxDocs = () =>
  apiFetch<{ documents: TaxDoc[] }>('/self/me/tax-documents');

// Profile photo upload — separate codepath because apiFetch JSON-encodes
// the body. We post the raw FormData and rely on the browser to set the
// multipart boundary header.
export async function uploadProfilePhoto(file: File): Promise<void> {
  const fd = new FormData();
  fd.append('file', file);
  let res: Response;
  try {
    res = await fetch('/api/me/profile-photo', {
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
}

export const deleteProfilePhoto = () =>
  apiFetch<void>('/me/profile-photo', { method: 'DELETE' });
