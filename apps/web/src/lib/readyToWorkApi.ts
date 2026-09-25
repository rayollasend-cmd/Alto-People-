import { apiFetch } from './api';

/**
 * Ready-to-work handoffs — what happens when HR issues a clock-in number:
 * the store's shift supervisors get the associate's card, the associate gets
 * the supervisors' card, and HR can see whether a first shift followed.
 * Shapes mirror apps/api/src/lib/readyToWork.ts.
 */

export interface StoreCard {
  id: string;
  name: string;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  timezone: string;
}

export interface SupervisorCard {
  userId: string;
  name: string;
  email: string;
  phone: string | null;
  windows: string[];
}

export interface AssociateCard {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  position: string | null;
  hireDate: string | null;
}

export interface HandoffStatus {
  associate: AssociateCard;
  client: { id: string; name: string };
  store: StoreCard | null;
  supervisors: SupervisorCard[];
  fallbackToClient: boolean;
  issuedAt: string;
  supervisorsNotifiedAt: string | null;
  nudgedAt: string | null;
  firstShiftAt: string | null;
  firstPunchAt: string | null;
  closed: boolean;
}

export interface ReadyToScheduleItem {
  associate: AssociateCard;
  store: { id: string; name: string } | null;
  issuedAt: string;
  nudgedAt: string | null;
  fallbackToClient: boolean;
}

/** The signed-in associate's first-day kit; null until their number is issued
 *  and null again after their first punch. */
export const getMyReadyToWork = () =>
  apiFetch<{ kit: HandoffStatus | null }>('/self/me/ready-to-work').then((r) => r.kit);

/** A shift supervisor's queue: hires handed to them with no first shift yet. */
export const listReadyToSchedule = () =>
  apiFetch<{ items: ReadyToScheduleItem[] }>('/ready-to-work/mine').then((r) => r.items);

/** HR / Workforce: who was told, when, and whether the handoff closed. */
export const getReadyToWorkStatus = (associateId: string) =>
  apiFetch<{ status: HandoffStatus | null }>(`/ready-to-work/associates/${associateId}`).then(
    (r) => r.status,
  );

/** One line for a store's address, or null when nothing is on file. */
export function storeAddress(store: StoreCard | null): string | null {
  if (!store) return null;
  const cityState = [store.city, store.state].filter(Boolean).join(', ');
  const parts = [store.addressLine1, store.addressLine2, cityState, store.zip].filter(
    (p) => p && p.trim(),
  );
  return parts.length ? parts.join(', ') : null;
}
