import { apiFetch } from './api';

/**
 * Access pack — the person's own sign-in and delivery settings: the
 * devices two-step has remembered, and when outside channels reach them
 * (quiet hours; real time or a digest, per channel).
 */

export interface TrustedDeviceRow {
  id: string;
  label: string;
  ip: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

export const listMyDevices = () => apiFetch<{ enabled: boolean; days: number; devices: TrustedDeviceRow[] }>('/auth/me/devices');
export const forgetMyDevice = (id: string) => apiFetch<void>(`/auth/me/devices/${id}`, { method: 'DELETE' });

export type DeliveryMode = 'REALTIME' | 'DIGEST';

export interface DeliveryPrefs {
  quietHoursStart: number | null;
  quietHoursEnd: number | null;
  deliveryEmail: DeliveryMode;
  deliveryPush: DeliveryMode;
  deliverySms: DeliveryMode;
  timezone: string | null;
}

export const getDeliveryPrefs = () => apiFetch<DeliveryPrefs>('/auth/me/notification-delivery');
export const patchDeliveryPrefs = (input: Partial<Omit<DeliveryPrefs, 'timezone'>>) =>
  apiFetch<DeliveryPrefs>('/auth/me/notification-delivery', { method: 'PATCH', body: input });

/** "22:00" ↔ 1320. */
export const minutesToHhmm = (m: number | null): string => (m === null ? '' : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
export const hhmmToMinutes = (s: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h > 23 || mm > 59) return null;
  return h * 60 + mm;
};
