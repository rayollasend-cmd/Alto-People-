import { apiFetch } from './api';

/**
 * The floor from a phone (routes/floor.ts): an incident with a photo, a
 * flag from the watch-only lead, the week, a text to the crew, the
 * handover notes, and "Cover this shift".
 */

export type IncidentSeverity = 'FIRST_AID' | 'MEDICAL_TREATMENT' | 'RESTRICTED_DUTY' | 'DAYS_AWAY';

export interface IncidentReportInput {
  description: string;
  severity: IncidentSeverity;
  nearMiss: boolean;
  location?: string;
  associateId?: string | null;
  clientId?: string | null;
  photo?: File | null;
}

/** Multipart — the photo rides with the words. */
export async function reportIncident(input: IncidentReportInput): Promise<{ id: string; isRecordable: boolean; photo: boolean }> {
  const fd = new FormData();
  fd.append('description', input.description);
  fd.append('severity', input.severity);
  fd.append('nearMiss', input.nearMiss ? 'true' : 'false');
  if (input.location) fd.append('location', input.location);
  if (input.associateId) fd.append('associateId', input.associateId);
  if (input.clientId) fd.append('clientId', input.clientId);
  if (input.photo) fd.append('photo', input.photo);
  const res = await fetch('/api/floor/incidents', { method: 'POST', body: fd, credentials: 'include' });
  if (!res.ok) {
    let message = 'Could not file the incident.';
    try {
      const j = (await res.json()) as { error?: { message?: string } };
      message = j.error?.message ?? message;
    } catch {
      /* keep default */
    }
    throw new Error(message);
  }
  return (await res.json()) as { id: string; isRecordable: boolean; photo: boolean };
}

export type FloorFlagKind = 'NO_SHOW' | 'HAZARD' | 'OTHER';

export interface FloorFlag {
  id: string;
  kind: FloorFlagKind;
  note: string;
  status: 'OPEN' | 'ACKNOWLEDGED';
  createdAt: string;
  acknowledgedAt: string | null;
  associate: { id: string; name: string } | null;
  shiftId: string | null;
  raisedBy: string;
}

export function raiseFloorFlag(input: { kind: FloorFlagKind; note: string; associateId?: string | null; shiftId?: string | null; clientId?: string | null }): Promise<{ id: string }> {
  return apiFetch('/floor/flags', { method: 'POST', body: input });
}

export function listFloorFlags(status: 'open' | 'all' = 'open'): Promise<{ flags: FloorFlag[] }> {
  return apiFetch(`/floor/flags${status === 'all' ? '?status=all' : ''}`);
}

export function acknowledgeFloorFlag(id: string): Promise<{ ok: true }> {
  return apiFetch(`/floor/flags/${id}/ack`, { method: 'POST' });
}

export interface FloorWeekDay {
  date: string;
  scheduled: number;
  open: number;
  confirmed: number;
}

export function getFloorWeek(): Promise<{ today: string; timezone: string; days: FloorWeekDay[] }> {
  return apiFetch('/floor/week');
}

export function textCrew(input: { shiftIds: string[]; body: string; clientId?: string | null }): Promise<{ sent: number; noPhone: string[] }> {
  return apiFetch('/floor/crew-text', { method: 'POST', body: input });
}

export interface HandoverNote {
  id: string;
  kind: string;
  body: string;
  priority: 'LOW' | 'MEDIUM' | 'HIGH';
  createdAt: string;
  from: { shiftId: string; position: string; period: string; dateKey: string; department: string; by: string | null };
}

export function getHandover(): Promise<{ items: HandoverNote[] }> {
  return apiFetch('/floor/handover');
}

export interface CoverStep {
  key: 'post' | 'bench' | 'agent';
  status: 'done' | 'waiting' | 'skipped';
  detail: string;
}

export function coverShift(shiftId: string, input: { release?: boolean; reason?: string } = {}): Promise<{ shiftId: string; steps: CoverStep[] }> {
  return apiFetch(`/floor/cover/${shiftId}`, { method: 'POST', body: input });
}
