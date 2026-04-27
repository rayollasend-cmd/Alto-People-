import { apiFetch } from './api';

// ----- Admin ------------------------------------------------------------

export interface KioskDevice {
  id: string;
  clientId: string;
  clientName: string;
  name: string;
  isActive: boolean;
  lastSeenAt: string | null;
  punchCount: number;
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

export interface KioskPunchSummary {
  id: string;
  kioskDeviceId: string;
  deviceName: string;
  associateId: string | null;
  associateName: string | null;
  timeEntryId: string | null;
  action: 'CLOCK_IN' | 'CLOCK_OUT' | 'REJECTED';
  hasSelfie: boolean;
  rejectReason: string | null;
  createdAt: string;
}

export const listKioskDevices = (clientId?: string) =>
  apiFetch<{ devices: KioskDevice[] }>(
    clientId ? `/kiosk-devices?clientId=${clientId}` : '/kiosk-devices',
  );

export const createKioskDevice = (input: { clientId: string; name: string }) =>
  apiFetch<{ id: string; deviceToken: string }>('/kiosk-devices', {
    method: 'POST',
    body: input,
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
}) => {
  const q = new URLSearchParams();
  if (params?.associateId) q.set('associateId', params.associateId);
  if (params?.deviceId) q.set('deviceId', params.deviceId);
  const suffix = q.toString() ? `?${q.toString()}` : '';
  return apiFetch<{ punches: KioskPunchSummary[] }>(`/kiosk-punches${suffix}`);
};

// ----- Public kiosk endpoint ---------------------------------------------

export interface KioskPunchResult {
  action: 'CLOCK_IN' | 'CLOCK_OUT';
  associateName: string;
  at: string;
  punchId: string;
}

export const kioskPunch = (input: {
  deviceToken: string;
  pin: string;
  selfie: string | null;
}) =>
  apiFetch<KioskPunchResult>('/kiosk/punch', {
    method: 'POST',
    body: input,
    // The public kiosk endpoint doesn't need cookies and we don't want
    // to send any session that might be lurking on the kiosk's browser.
    // apiFetch's `credentials: 'include'` default is fine here — the
    // server doesn't read cookies on this route.
  });
