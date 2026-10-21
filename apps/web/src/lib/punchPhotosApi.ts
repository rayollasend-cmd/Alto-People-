import { apiFetch } from './api';

/**
 * Photo at punch — who must be photographed at the kiosk (routes/punchPhotos.ts on the API).
 * Rules sit at the company, a client, a location, or one person; the most specific wins.
 */

export type PhotoScope = 'COMPANY' | 'CLIENT' | 'SITE' | 'ASSOCIATE';

export interface PunchPhotoRule {
  id: string;
  scope: PhotoScope;
  required: boolean;
  clientId: string | null;
  clientName: string | null;
  siteId: string | null;
  siteName: string | null;
  associateId: string | null;
  associateName: string | null;
  /** "Photo required for Ana Reyes", "Photo not required at Front Beach 218". */
  label: string;
  reason: string | null;
  startsOn: string;
  endsOn: string | null;
  setBy: string | null;
  setAt: string;
  endedAt: string | null;
  endedBy: string | null;
  endReason: string | null;
}

export interface PunchPhotoOverview {
  company: PunchPhotoRule | null;
  clients: PunchPhotoRule[];
  sites: PunchPhotoRule[];
  people: PunchPhotoRule[];
  history: PunchPhotoRule[];
  noPhotoPunchesLast30Days: number;
}

export interface PersonPunchPhoto {
  associateId: string;
  name: string;
  location: string | null;
  required: boolean;
  /** The rule that decided it (theirs, their location's, their client's, the company's) — or none. */
  decidedBy: PunchPhotoRule | null;
  ownRule: PunchPhotoRule | null;
  history: PunchPhotoRule[];
  recentPunches: Array<{ id: string; action: string; at: string; kiosk: string; hasPhoto: boolean; flagged: boolean; reviewStatus: string | null }>;
  last30Days: { keptWithoutPhoto: number; refusedWithoutPhoto: number };
  canSetCompanyRules: boolean;
}

const B = '/time/punch-photos';

export const getPunchPhotoOverview = () => apiFetch<PunchPhotoOverview>(B);
export const setPunchPhotoRule = (body: { scope: 'COMPANY' | 'CLIENT' | 'SITE'; clientId?: string; siteId?: string; required: boolean; reason?: string }) =>
  apiFetch<{ rule: PunchPhotoRule }>(`${B}/rules`, { method: 'PUT', body });
export const endPunchPhotoRule = (id: string, reason: string) => apiFetch<void>(`${B}/rules/${id}`, { method: 'DELETE', body: { reason } });
export const getPersonPunchPhoto = (associateId: string) => apiFetch<PersonPunchPhoto>(`${B}/associates/${associateId}`);
export const setPersonPunchPhoto = (associateId: string, body: { required: boolean; reason?: string; endsOn?: string | null }) =>
  apiFetch<{ rule: PunchPhotoRule }>(`${B}/associates/${associateId}`, { method: 'PUT', body });
export const endPersonPunchPhoto = (associateId: string, reason: string) => apiFetch<void>(`${B}/associates/${associateId}`, { method: 'DELETE', body: { reason } });

/** The stored punch photo (viewing it is audited on the API). */
export const punchPhotoUrl = (punchId: string) => `/api/kiosk-punches/${punchId}/selfie`;
