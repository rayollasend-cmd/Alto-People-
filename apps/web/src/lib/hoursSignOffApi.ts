import { apiFetch } from './api';

/**
 * The client's sign-off on a store week's worked hours (API
 * lib/portalHoursSignOff): the portal's review-and-sign and the staff
 * client page's read of it. Hours only — never a rate.
 */

export type SignOffState = 'unsigned' | 'signed' | 'flagged' | 'changed';

export interface HoursLine {
  associateId: string;
  name: string;
  hours: number;
  punches: number;
}

export interface SignOffFlag {
  associateId: string;
  name: string;
  hours: number;
  note: string;
}

export interface SignOffRecord {
  status: 'SIGNED' | 'FLAGGED';
  signedAt: string;
  signedByName: string;
  totalHours: number;
  people: number;
  flags: SignOffFlag[];
  note: string | null;
}

export interface WeekHours {
  store: { id: string; name: string };
  week: { start: string; end: string };
  /** Weeks that can be signed, newest first. */
  weeks: string[];
  signable: boolean;
  canSign: boolean;
  lines: HoursLine[];
  totalHours: number;
  people: number;
  openPunches: number;
  state: SignOffState;
  signOff: SignOffRecord | null;
}

/** GET /client-portal/hours — `scopeQs` is the portal scope ("" or "?locationId=…"). */
export function getWeekHours(scopeQs: string, week?: string | null): Promise<WeekHours> {
  const q = new URLSearchParams(scopeQs.replace(/^\?/, ''));
  if (week) q.set('week', week);
  const s = q.toString();
  return apiFetch<WeekHours>(`/client-portal/hours${s ? `?${s}` : ''}`);
}

export function signWeekHours(
  scopeQs: string,
  body: { week: string; flags: Array<{ associateId: string; note: string }>; note?: string; expectTotalHours?: number },
): Promise<{ state: SignOffState; signOff: SignOffRecord }> {
  return apiFetch(`/client-portal/hours/sign${scopeQs}`, { method: 'POST', body });
}

export interface StaffSignOffWeek {
  locationId: string;
  storeName: string;
  weekStart: string;
  weekEnd: string;
  hours: { lines: HoursLine[]; totalHours: number; people: number; openPunches: number };
  state: SignOffState;
  signOff: SignOffRecord | null;
}

/** GET /clients/:id/hours-signoffs — `enabled` is false where the client portal is off. */
export function getClientSignOffs(clientId: string, weeks = 6): Promise<{ enabled: boolean; weeks: StaffSignOffWeek[] }> {
  return apiFetch(`/clients/${clientId}/hours-signoffs?weeks=${weeks}`);
}
