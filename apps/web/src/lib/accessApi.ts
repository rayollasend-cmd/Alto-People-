import type { DeliveryModeKey } from '@alto-people/shared';
import { apiFetch } from './api';

/**
 * Access pack — the person's own sign-in and delivery settings: the
 * devices two-step has remembered, and when outside channels reach them
 * (quiet hours; per channel, how often).
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

/**
 * REALTIME each as it comes · DIGEST once an hour together · IMPORTANT only
 * what needs the person (email) · DAILY one summary each morning (email) ·
 * OFF only urgent and required notices (owner, 2026-11-02).
 */
export type DeliveryMode = DeliveryModeKey;

/** The settings themselves — what a person can change. */
export interface DeliverySettings {
  /** Minutes after midnight in their zone; both null = quiet hours off. */
  quietHoursStart: number | null;
  quietHoursEnd: number | null;
  deliveryEmail: DeliveryMode;
  deliveryPush: DeliveryMode;
  deliverySms: DeliveryMode;
}

/** The EFFECTIVE settings (their role's defaults until they choose), and those defaults. */
export interface DeliveryPrefs extends DeliverySettings {
  timezone: string | null;
  /** True while the person has never chosen: the values are their role's defaults. */
  isDefault: boolean;
  /** What their role gets by default — the "Recommended for you" mark. */
  defaults: DeliverySettings;
}

export const getDeliveryPrefs = () => apiFetch<DeliveryPrefs>('/auth/me/notification-delivery');
/** Quiet hours go both or neither (null + null turns them off). */
export const patchDeliveryPrefs = (input: Partial<DeliverySettings>) =>
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
