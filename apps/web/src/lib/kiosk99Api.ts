import { apiFetch } from './api';

// ----- Admin ------------------------------------------------------------

export interface KioskGeofence {
  latitude: number;
  longitude: number;
  radiusMeters: number;
}

export interface KioskDevice {
  id: string;
  clientId: string;
  clientName: string;
  name: string;
  isActive: boolean;
  lastSeenAt: string | null;
  punchCount: number;
  geofence: KioskGeofence | null;
  createdAt: string;
}

export interface KioskPin {
  id: string;
  associateId: string;
  associateName: string;
  associateEmail: string;
  clientId: string;
  createdAt: string;
}

export type KioskPunchReviewStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export type KioskAnomalyKind =
  | 'FACE_MISMATCH'
  | 'IMPOSSIBLE_TRAVEL'
  | 'GEOFENCE_NEAR_MISS';

export interface KioskPunchSummary {
  id: string;
  kioskDeviceId: string;
  deviceName: string;
  associateId: string | null;
  associateName: string | null;
  timeEntryId: string | null;
  action: 'CLOCK_IN' | 'CLOCK_OUT' | 'REJECTED' | 'BREAK_START' | 'BREAK_END';
  hasSelfie: boolean;
  rejectReason: string | null;
  distanceMeters: number | null;
  faceDistance: number | null;
  faceMismatch: boolean | null;
  anomalyKind: KioskAnomalyKind | null;
  anomalyDetail: string | null;
  reviewStatus: KioskPunchReviewStatus | null;
  reviewedAt: string | null;
  reviewedByEmail: string | null;
  reviewNotes: string | null;
  createdAt: string;
}

export interface KioskFaceReferenceSummary {
  id: string;
  associateId: string;
  associateName: string;
  associateEmail: string;
  enrolledByPunchId: string | null;
  enrolledAt: string;
  updatedAt: string;
}

export const listKioskDevices = (clientId?: string) =>
  apiFetch<{ devices: KioskDevice[] }>(
    clientId ? `/kiosk-devices?clientId=${clientId}` : '/kiosk-devices',
  );

export const createKioskDevice = (input: {
  clientId: string;
  name: string;
  geofence?: KioskGeofence | null;
}) =>
  apiFetch<{ id: string; deviceToken: string }>('/kiosk-devices', {
    method: 'POST',
    body: input,
  });

export const updateKioskGeofence = (
  id: string,
  geofence: KioskGeofence | null,
) =>
  apiFetch<{ ok: true }>(`/kiosk-devices/${id}/geofence`, {
    method: 'PUT',
    body: { geofence },
  });

export const revokeKioskDevice = (id: string) =>
  apiFetch<{ ok: true }>(`/kiosk-devices/${id}/revoke`, {
    method: 'POST',
    body: {},
  });

export const deleteKioskDevice = (id: string) =>
  apiFetch<void>(`/kiosk-devices/${id}`, { method: 'DELETE' });

export const listKioskPins = (clientId: string) =>
  apiFetch<{ pins: KioskPin[] }>(`/kiosk-pins?clientId=${clientId}`);

export const assignKioskPin = (input: {
  associateId: string;
  clientId: string;
  pin?: string;
}) => apiFetch<{ id: string; pin: string }>('/kiosk-pins', {
  method: 'POST',
  body: input,
});

export const deleteKioskPin = (id: string) =>
  apiFetch<void>(`/kiosk-pins/${id}`, { method: 'DELETE' });

export const listKioskPunches = (params?: {
  associateId?: string;
  deviceId?: string;
  reviewStatus?: KioskPunchReviewStatus;
}) => {
  const q = new URLSearchParams();
  if (params?.associateId) q.set('associateId', params.associateId);
  if (params?.deviceId) q.set('deviceId', params.deviceId);
  if (params?.reviewStatus) q.set('reviewStatus', params.reviewStatus);
  const suffix = q.toString() ? `?${q.toString()}` : '';
  return apiFetch<{ punches: KioskPunchSummary[] }>(`/kiosk-punches${suffix}`);
};

export const reviewKioskPunch = (
  id: string,
  decision: 'APPROVED' | 'REJECTED',
  notes?: string,
) =>
  apiFetch<{ ok: true }>(`/kiosk-punches/${id}/review`, {
    method: 'POST',
    body: { decision, notes },
  });

// ----- Face references (Phase 101) ---------------------------------------

export const listKioskFaceReferences = () =>
  apiFetch<{ references: KioskFaceReferenceSummary[] }>(
    '/kiosk-face-references',
  );

export const resetKioskFaceReference = (associateId: string) =>
  apiFetch<void>(`/kiosk-face-references/${associateId}`, { method: 'DELETE' });

// ----- Public kiosk endpoint ---------------------------------------------

export interface KioskPunchResult {
  action: 'CLOCK_IN' | 'CLOCK_OUT' | 'BREAK_START' | 'BREAK_END';
  associateName: string;
  at: string;
  punchId: string;
}

export const kioskPunch = (input: {
  deviceToken: string;
  pin: string;
  selfie: string | null;
  latitude?: number | null;
  longitude?: number | null;
  faceDescriptor?: number[] | null;
  idempotencyKey?: string | null;
  clientPunchedAt?: string | null;
  intent?: 'BREAK' | null;
}) =>
  apiFetch<KioskPunchResult>('/kiosk/punch', {
    method: 'POST',
    body: input,
    // The public kiosk endpoint doesn't need cookies and we don't want
    // to send any session that might be lurking on the kiosk's browser.
    // apiFetch's `credentials: 'include'` default is fine here — the
    // server doesn't read cookies on this route.
  });
