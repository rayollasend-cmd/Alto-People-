import type {
  ChecklistRunInput,
  ChecklistTemplateInput,
  CommissioningInput,
  MaintenanceInput,
  RobotChecklistRunSummary,
  RobotChecklistTemplateSummary,
  RobotCommissioningSummary,
  RobotDetail,
  RobotEventSummary,
  RobotIncidentDetail,
  RobotIncidentInput,
  RobotIncidentSummary,
  RobotMaintenanceSummary,
  RobotProfileInput,
  RobotsResponse,
  RobotStatusSampleSummary,
  SafetyZoneInput,
  SiteSafetyZoneSummary,
} from '@alto-people/shared';
import { apiFetch } from './api';

/** Brief 3-1 — the robot registry, its fleet status and the safety rules. */

export function listRobots(): Promise<RobotsResponse> {
  return apiFetch<RobotsResponse>('/robots');
}

export function getRobot(id: string): Promise<RobotDetail> {
  return apiFetch<RobotDetail>(`/robots/${id}`);
}

export function updateRobotProfile(id: string, input: RobotProfileInput): Promise<RobotDetail> {
  return apiFetch<RobotDetail>(`/robots/${id}/profile`, { method: 'PATCH', body: input });
}

export function listRobotSamples(id: string, hours = 24): Promise<{ samples: RobotStatusSampleSummary[] }> {
  return apiFetch(`/robots/${id}/samples?hours=${hours}`);
}

export function listRobotEvents(id: string): Promise<{ events: RobotEventSummary[] }> {
  return apiFetch(`/robots/${id}/events`);
}

export function stopRobot(id: string, note?: string): Promise<RobotDetail> {
  return apiFetch<RobotDetail>(`/robots/${id}/stop`, { method: 'POST', body: { note: note ?? null } });
}

export function resumeRobot(id: string, note?: string): Promise<RobotDetail> {
  return apiFetch<RobotDetail>(`/robots/${id}/resume`, { method: 'POST', body: { note: note ?? null } });
}

export function startRobotShift(id: string, shiftId: string): Promise<{ shiftId: string; startedAt: string; warnings?: string[] }> {
  return apiFetch(`/robots/${id}/shifts/${shiftId}/start`, { method: 'POST' });
}

export function listChecklistTemplates(locationId: string | null): Promise<{ templates: RobotChecklistTemplateSummary[] }> {
  return apiFetch(`/robots/checklists/templates${locationId ? `?locationId=${locationId}` : ''}`);
}

export function createChecklistTemplate(input: ChecklistTemplateInput): Promise<RobotChecklistTemplateSummary> {
  return apiFetch(`/robots/checklists/templates`, { method: 'POST', body: input });
}

export function listChecklistRuns(id: string): Promise<{ runs: RobotChecklistRunSummary[] }> {
  return apiFetch(`/robots/${id}/checklists`);
}

export function completeChecklist(id: string, input: ChecklistRunInput): Promise<RobotChecklistRunSummary> {
  return apiFetch(`/robots/${id}/checklists`, { method: 'POST', body: input });
}

export function saveCommissioning(id: string, input: CommissioningInput): Promise<RobotCommissioningSummary> {
  return apiFetch(`/robots/${id}/commissioning`, { method: 'PUT', body: input });
}

export function signOffCommissioning(id: string, locationId: string): Promise<RobotCommissioningSummary> {
  return apiFetch(`/robots/${id}/commissioning/${locationId}/sign-off`, { method: 'POST' });
}

export function listMaintenance(id: string): Promise<{ maintenance: RobotMaintenanceSummary[] }> {
  return apiFetch(`/robots/${id}/maintenance`);
}

export function addMaintenance(id: string, input: MaintenanceInput): Promise<RobotMaintenanceSummary> {
  return apiFetch(`/robots/${id}/maintenance`, { method: 'POST', body: input });
}

export function listRobotIncidents(id: string): Promise<{ incidents: RobotIncidentSummary[] }> {
  return apiFetch(`/robots/${id}/incidents`);
}

export function reportRobotIncident(id: string, input: RobotIncidentInput): Promise<RobotIncidentDetail> {
  return apiFetch(`/robots/${id}/incidents`, { method: 'POST', body: input });
}

export function getRobotIncident(incidentId: string): Promise<RobotIncidentDetail> {
  return apiFetch(`/robots/incidents/${incidentId}`);
}

export function listSafetyZones(locationId: string): Promise<{ zones: SiteSafetyZoneSummary[] }> {
  return apiFetch(`/robots/sites/${locationId}/zones`);
}

export function createSafetyZone(locationId: string, input: SafetyZoneInput): Promise<SiteSafetyZoneSummary> {
  return apiFetch(`/robots/sites/${locationId}/zones`, { method: 'POST', body: input });
}

export function updateSafetyZone(zoneId: string, input: Partial<SafetyZoneInput>): Promise<SiteSafetyZoneSummary> {
  return apiFetch(`/robots/zones/${zoneId}`, { method: 'PATCH', body: input });
}

export function setZoneOccupied(zoneId: string, occupied: boolean): Promise<SiteSafetyZoneSummary> {
  return apiFetch(`/robots/zones/${zoneId}/occupied`, { method: 'POST', body: { occupied } });
}

export function sampleFleetNow(): Promise<{ sampled: number; errors: number }> {
  return apiFetch(`/robots/sample`, { method: 'POST' });
}
