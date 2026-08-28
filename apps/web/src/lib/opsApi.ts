import { apiFetch } from './api';

/**
 * Store Operations client — the shift supervisor's floor tool plus the
 * leadership library/board/scorecard. Types mirror the /ops routes.
 */

export type OpsPeriod = 'MORNING' | 'EVENING' | 'CLOSING' | 'OVERNIGHT';
export type OpsResponseType =
  | 'CHECK'
  | 'YES_NO'
  | 'YES_NO_PARTIAL'
  | 'TEXT'
  | 'NUMBER'
  | 'TEMPERATURE'
  | 'PHOTO';
export type OpsTaskStatus = 'OPEN' | 'IN_PROGRESS' | 'DONE' | 'BLOCKED';
export type OpsPriority = 'HIGH' | 'MEDIUM' | 'LOW';
export type OpsHandoverKind =
  | 'NOTE'
  | 'UNFINISHED_TASK'
  | 'SPECIAL_ORDER'
  | 'COACH_COMPLAINT'
  | 'EQUIPMENT'
  | 'STOCKING';

export interface OpsShiftHeader {
  id: string;
  clientId: string;
  clientName?: string | null;
  department: string;
  period: OpsPeriod;
  position: string;
  dateKey: string;
  status: 'ACTIVE' | 'CLOSED';
  openedAt: string;
  closedAt: string | null;
  openedByEmail?: string;
  scheduledHeadcount: number;
  actualHeadcount: number;
  templateName: string | null;
  sopTotal: number;
  sopDone: number;
  taskTotal: number;
  taskDone: number;
  closedIncomplete: boolean;
  tempAlerts: number;
  closingSummary: string | null;
}

export interface OpsTaskRow {
  id: string;
  source: 'SOP' | 'ADHOC' | 'CARRYOVER';
  section: string | null;
  order: number;
  title: string;
  instructions: string | null;
  priority: OpsPriority;
  status: OpsTaskStatus;
  responseType: OpsResponseType;
  required: boolean;
  photoRequired: boolean;
  tempLabel: string | null;
  tempMin: number | null;
  tempMax: number | null;
  answerChoice: 'YES' | 'NO' | 'PARTIAL' | null;
  answerNumber: number | null;
  answerText: string | null;
  tempOutOfRange: boolean;
  note: string | null;
  blockedReason: string | null;
  completedAt: string | null;
  doneAssociate: { id: string; name: string } | null;
  photos: { id: string; filename: string; createdAt: string }[];
}

export interface OpsHandoverRow {
  id: string;
  kind: OpsHandoverKind;
  body: string;
  priority: OpsPriority;
  status: 'PENDING' | 'CARRIED' | 'DISMISSED' | 'REVIEWED';
  createdAt: string;
  decidedAt: string | null;
  from: { shiftId: string; position: string; period: OpsPeriod; dateKey: string };
  decidedByEmail: string | null;
}

export interface OpsShiftDetail {
  shift: OpsShiftHeader & { clientName: string | null };
  tasks: OpsTaskRow[];
  handoverOut: OpsHandoverRow[];
  handoverIn: OpsHandoverRow[];
  clockedIn: { id: string; name: string }[];
}

export interface OpsLibraryTemplate {
  id: string;
  name: string;
  department: string;
  period: OpsPeriod;
  description: string | null;
  active: boolean;
  taskCount: number;
  tasks: {
    id: string;
    section: string;
    order: number;
    title: string;
    instructions: string | null;
    responseType: OpsResponseType;
    required: boolean;
    photoRequired: boolean;
    tempLabel: string | null;
    tempMin: number | null;
    tempMax: number | null;
  }[];
}

export function getOpsLibrary(): Promise<{
  departments: string[];
  templates: OpsLibraryTemplate[];
}> {
  return apiFetch('/ops/library');
}

export function createOpsTemplate(body: {
  name: string;
  department: string;
  period: OpsPeriod;
  description?: string;
}): Promise<{ id: string }> {
  return apiFetch('/ops/library/templates', { method: 'POST', body });
}

export function patchOpsTemplate(
  id: string,
  body: { name?: string; description?: string | null; active?: boolean; retire?: boolean },
): Promise<{ ok: true }> {
  return apiFetch(`/ops/library/templates/${id}`, { method: 'PATCH', body });
}

export function addOpsTemplateTask(
  templateId: string,
  body: {
    section: string;
    title: string;
    instructions?: string;
    responseType?: OpsResponseType;
    required?: boolean;
    photoRequired?: boolean;
    tempLabel?: string;
    tempMin?: number;
    tempMax?: number;
  },
): Promise<{ id: string }> {
  return apiFetch(`/ops/library/templates/${templateId}/tasks`, { method: 'POST', body });
}

export function deleteOpsTemplateTask(taskId: string): Promise<void> {
  return apiFetch(`/ops/library/tasks/${taskId}`, { method: 'DELETE' });
}

export function getOpsOpenOptions(): Promise<{
  clientId: string;
  dateKey: string;
  resumeShift: { id: string; position: string; department: string } | null;
  positions: {
    position: string;
    scheduledCount: number;
    department: string | null;
    period: OpsPeriod;
  }[];
  departments: string[];
}> {
  return apiFetch('/ops/open-options');
}

export function openOpsShift(body: {
  clientId?: string;
  position: string;
  department?: string;
}): Promise<{ shiftId: string; resumed: boolean }> {
  return apiFetch('/ops/shifts/open', { method: 'POST', body });
}

export function getOpsShift(id: string): Promise<OpsShiftDetail> {
  return apiFetch(`/ops/shifts/${id}`);
}

export function addOpsAdhocTask(
  shiftId: string,
  body: {
    title: string;
    instructions?: string;
    priority?: OpsPriority;
    responseType?: OpsResponseType;
  },
): Promise<{ task: OpsTaskRow }> {
  return apiFetch(`/ops/shifts/${shiftId}/tasks`, { method: 'POST', body });
}

export function patchOpsTask(
  taskId: string,
  body: {
    status?: OpsTaskStatus;
    answerChoice?: 'YES' | 'NO' | 'PARTIAL' | null;
    answerNumber?: number | null;
    answerText?: string | null;
    note?: string | null;
    blockedReason?: string | null;
    doneAssociateId?: string | null;
    priority?: OpsPriority;
  },
): Promise<{ task: OpsTaskRow }> {
  return apiFetch(`/ops/tasks/${taskId}`, { method: 'PATCH', body });
}

export async function uploadOpsTaskPhoto(
  taskId: string,
  file: File,
): Promise<{ photo: { id: string; filename: string; createdAt: string } }> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`/api/ops/tasks/${taskId}/photos`, {
    method: 'POST',
    credentials: 'include',
    body: form,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new Error(body?.error?.message ?? `Upload failed (${res.status})`);
  }
  return (await res.json()) as { photo: { id: string; filename: string; createdAt: string } };
}

export function opsPhotoUrl(photoId: string): string {
  return `/api/ops/photos/${photoId}`;
}

export function addOpsHandover(
  shiftId: string,
  items: { kind: OpsHandoverKind; body: string; priority?: OpsPriority }[],
): Promise<{ added: number }> {
  return apiFetch(`/ops/shifts/${shiftId}/handover`, { method: 'POST', body: { items } });
}

export function decideOpsHandover(
  itemId: string,
  body: { action: 'CARRY' | 'DISMISS' | 'REVIEW'; shiftId: string },
): Promise<{ ok: true; carriedTaskId: string | null }> {
  return apiFetch(`/ops/handover/${itemId}/decide`, { method: 'POST', body });
}

export function closeOpsShift(
  shiftId: string,
  summary?: string,
): Promise<{ shift: OpsShiftHeader }> {
  return apiFetch(`/ops/shifts/${shiftId}/close`, {
    method: 'POST',
    body: summary ? { summary } : {},
  });
}

export function listOpsShifts(params?: {
  clientId?: string;
  status?: 'ACTIVE' | 'CLOSED';
  dateKey?: string;
}): Promise<{ shifts: (OpsShiftHeader & { clientName: string; openedByEmail: string })[] }> {
  const q = new URLSearchParams();
  if (params?.clientId) q.set('clientId', params.clientId);
  if (params?.status) q.set('status', params.status);
  if (params?.dateKey) q.set('dateKey', params.dateKey);
  const qs = q.toString();
  return apiFetch(`/ops/shifts${qs ? `?${qs}` : ''}`);
}

export function getOpsBoard(): Promise<{
  dateKey: string;
  active: (OpsShiftHeader & { clientName: string; openedByEmail: string })[];
  closedToday: (OpsShiftHeader & { clientName: string; openedByEmail: string })[];
}> {
  return apiFetch('/ops/board');
}

export function getOpsScorecard(weeks = 4): Promise<{
  weeks: number;
  rows: {
    clientName: string;
    department: string;
    shifts: number;
    sopPct: number | null;
    incomplete: number;
    tempAlerts: number;
  }[];
  totals: {
    shifts: number;
    tempChecks: number;
    tempOutOfRange: number;
    handoverCreated: number;
    handoverCarried: number;
  };
}> {
  return apiFetch(`/ops/scorecard?weeks=${weeks}`);
}
