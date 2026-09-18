import { apiFetch } from './api';

/**
 * Supervisor shift windows — the store shift windows ("Overnight 10p–6a") a
 * shift supervisor leads, assigned the way their client is. Focus, not a
 * lock: their pages open on these hours and shift alerts reach them first;
 * they still see the whole store.
 */

export interface MyShiftWindow {
  locationId: string;
  locationName: string;
  timezone: string;
  label: string;
  startMinute: number;
  endMinute: number;
  targetCount: number;
}

export function getMyShiftWindows(): Promise<{ windows: MyShiftWindow[] }> {
  return apiFetch<{ windows: MyShiftWindow[] }>('/me/shift-windows');
}

export interface StoreShiftWindows {
  locationId: string;
  locationName: string;
  timezone: string;
  windows: Array<{
    label: string;
    startMinute: number;
    endMinute: number;
    targetCount: number;
    leads: Array<{ userId: string; name: string }>;
  }>;
}

/** A shift supervisor at the client, and the shifts they lead — who a
 *  floor supervisor can report to. */
export interface ClientShiftSupervisor {
  userId: string;
  name: string;
  windows: Array<{ locationId: string; label: string }>;
}

export function listClientShiftWindows(
  clientId: string,
): Promise<{ stores: StoreShiftWindows[]; supervisors?: ClientShiftSupervisor[] }> {
  return apiFetch<{ stores: StoreShiftWindows[]; supervisors?: ClientShiftSupervisor[] }>(
    `/admin/shift-windows?clientId=${encodeURIComponent(clientId)}`,
  );
}

export function setSupervisorShiftWindows(
  userId: string,
  windows: Array<{ locationId: string; label: string }>,
): Promise<{ windows: Array<{ locationId: string; label: string }> }> {
  return apiFetch(`/admin/users/${userId}/shift-windows`, {
    method: 'PUT',
    body: { windows },
  });
}

export interface ShiftCoverageGaps {
  /** Named shift windows across every active client, and how many have a lead. */
  total: number;
  covered: number;
  /** Only clients with something missing. */
  clients: Array<{
    clientId: string;
    clientName: string;
    uncovered: Array<{ locationId: string; locationName: string; label: string; startMinute: number; endMinute: number }>;
    /** Supervisors at the client with no shift (user ids). */
    noShift: string[];
    /** Floor supervisors missing a shift or a shift supervisor. */
    floorSupervisors?: Array<{
      userId: string;
      name: string;
      email: string;
      windows: Array<{ locationId: string; locationName: string; label: string }>;
      noLead: boolean;
      noShift: boolean;
    }>;
    supervisors: Array<{
      userId: string;
      name: string;
      email: string;
      windows: Array<{ locationId: string; locationName: string; label: string }>;
    }>;
  }>;
}

export function getShiftCoverageGaps(): Promise<ShiftCoverageGaps> {
  return apiFetch<ShiftCoverageGaps>('/admin/shift-windows/gaps');
}

/* ===== Floor team: floor supervisors and their shift supervisor ========== */

export interface FloorTeamWindow {
  locationId: string;
  locationName: string;
  label: string;
  startMinute: number;
  endMinute: number;
}

export interface ShiftCoverRow {
  id: string;
  fromDate: string;
  toDate: string;
  note: string | null;
  coverUserId: string;
  coverName: string;
}

/** A shift supervisor's floor supervisors and the days handed over. */
export interface LeadFloorTeam {
  role: 'lead';
  /** Today on their store's clock (YYYY-MM-DD). */
  today: string;
  team: Array<{
    userId: string;
    name: string;
    associateId: string | null;
    /** ISO clock-in time while on the clock, else null. */
    onClockSince: string | null;
    windows: FloorTeamWindow[];
    coveringToday: boolean;
  }>;
  covers: ShiftCoverRow[];
}

/** A floor supervisor's shift supervisor and the days they're covering. */
export interface FloorSupervisorTeam {
  role: 'floor';
  today: string;
  lead: {
    userId: string;
    name: string;
    associateId: string | null;
    onClockSince: string | null;
    windows: FloorTeamWindow[];
  } | null;
  covers: Array<{
    id: string;
    fromDate: string;
    toDate: string;
    note: string | null;
    leadUserId: string;
    leadName: string;
    today: boolean;
  }>;
}

export type FloorTeam = LeadFloorTeam | FloorSupervisorTeam | { role: null };

export function getMyFloorTeam(): Promise<FloorTeam> {
  return apiFetch<FloorTeam>('/me/floor-team');
}

export function getLeadFloorTeam(userId: string): Promise<LeadFloorTeam> {
  return apiFetch<LeadFloorTeam>(`/admin/users/${userId}/floor-team`);
}

export function setFloorSupervisorLead(userId: string, leadUserId: string | null): Promise<{ leadUserId: string | null }> {
  return apiFetch(`/admin/users/${userId}/lead`, { method: 'PUT', body: { leadUserId } });
}

/** Hand a shift (SOP included) to a floor supervisor for a day or days.
 *  `leadUserId` only when HR / Workforce hands over for a shift supervisor. */
export function createShiftCover(input: {
  coverUserId: string;
  fromDate: string;
  toDate: string;
  note?: string;
  leadUserId?: string;
}): Promise<{ cover: ShiftCoverRow }> {
  return apiFetch('/shift-covers', { method: 'POST', body: input });
}

export function cancelShiftCover(id: string): Promise<void> {
  return apiFetch(`/shift-covers/${id}`, { method: 'DELETE' });
}
