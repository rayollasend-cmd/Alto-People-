import { apiFetch } from './api';

/**
 * The supervisor corps, placed by field leadership
 * (routes/workforceOverview.ts): who leads which store and shift.
 */

export interface CorpsSupervisor {
  userId: string;
  role: 'SHIFT_SUPERVISOR' | 'FLOOR_SUPERVISOR';
  email: string;
  name: string;
  phone: string | null;
  associateId: string | null;
  photoUrl?: string | null;
  clientId: string | null;
  clientName: string | null;
  locationId: string | null;
  windows: Array<{ locationId: string; label: string }>;
  lead: { userId: string; name: string } | null;
}

export function listSupervisorCorps(): Promise<{ supervisors: CorpsSupervisor[] }> {
  return apiFetch('/workforce/supervisors');
}

export function placeSupervisor(
  userId: string,
  input: { clientId?: string | null; locationId?: string | null },
): Promise<{ userId: string; clientId: string | null; locationId: string | null; windowsDropped: boolean }> {
  return apiFetch(`/workforce/supervisors/${userId}`, { method: 'PATCH', body: input });
}
