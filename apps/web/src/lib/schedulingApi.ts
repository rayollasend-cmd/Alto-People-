import type {
  AssociateListResponse,
  AutoFillResponse,
  AutoScheduleWeekInput,
  AutoScheduleWeekResponse,
  AvailabilityListResponse,
  AvailabilityReplaceInput,
  CalendarFeedUrlResponse,
  CopyWeekInput,
  CopyWeekResponse,
  PublishWeekInput,
  PublishWeekResponse,
  Shift,
  ShiftAssignInput,
  ShiftCancelInput,
  ShiftConflictsResponse,
  ShiftCreateInput,
  ShiftListResponse,
  ShiftStatus,
  ShiftSwapListResponse,
  ShiftSwapRequest,
  ShiftSwapStatus,
  ShiftTemplate,
  ShiftTemplateApplyInput,
  ShiftTemplateCreateInput,
  ShiftTemplateListResponse,
  ShiftUpdateInput,
  SwapCreateInput,
  SwapDecideInput,
} from '@alto-people/shared';
import { apiFetch } from './api';

interface ShiftListFilters {
  status?: ShiftStatus;
  clientId?: string;
  from?: string;
  to?: string;
}

function qs(filters: ShiftListFilters): string {
  const p = new URLSearchParams();
  if (filters.status) p.set('status', filters.status);
  if (filters.clientId) p.set('clientId', filters.clientId);
  if (filters.from) p.set('from', filters.from);
  if (filters.to) p.set('to', filters.to);
  const s = p.toString();
  return s ? `?${s}` : '';
}

export function listShifts(filters: ShiftListFilters = {}): Promise<ShiftListResponse> {
  return apiFetch<ShiftListResponse>(`/scheduling/shifts${qs(filters)}`);
}

export interface SchedulingKpis {
  from: string;
  to: string;
  openShifts: number;
  assignedShifts: number;
  draftShifts: number;
  completedShifts: number;
  totalShifts: number;
  fillRatePercent: number;
  totalScheduledMinutes: number;
  projectedLaborCost: number;
  shiftsWithoutRate: number;
}

export function getSchedulingKpis(
  filters: { from?: string; to?: string; clientId?: string } = {}
): Promise<SchedulingKpis> {
  const p = new URLSearchParams();
  if (filters.from) p.set('from', filters.from);
  if (filters.to) p.set('to', filters.to);
  if (filters.clientId) p.set('clientId', filters.clientId);
  const s = p.toString();
  return apiFetch<SchedulingKpis>(`/scheduling/kpis${s ? `?${s}` : ''}`);
}

export function listMyShifts(): Promise<ShiftListResponse> {
  return apiFetch<ShiftListResponse>('/scheduling/me/shifts');
}

export function getMyCalendarUrl(): Promise<CalendarFeedUrlResponse> {
  return apiFetch<CalendarFeedUrlResponse>('/scheduling/me/calendar-url');
}

export function createShift(body: ShiftCreateInput): Promise<Shift> {
  return apiFetch<Shift>('/scheduling/shifts', { method: 'POST', body });
}

export function updateShift(id: string, body: ShiftUpdateInput): Promise<Shift> {
  return apiFetch<Shift>(`/scheduling/shifts/${id}`, { method: 'PATCH', body });
}

export function assignShift(id: string, body: ShiftAssignInput): Promise<Shift> {
  return apiFetch<Shift>(`/scheduling/shifts/${id}/assign`, { method: 'POST', body });
}

export function unassignShift(id: string): Promise<Shift> {
  return apiFetch<Shift>(`/scheduling/shifts/${id}/unassign`, { method: 'POST' });
}

export function cancelShift(id: string, body: ShiftCancelInput): Promise<Shift> {
  return apiFetch<Shift>(`/scheduling/shifts/${id}/cancel`, { method: 'POST', body });
}

/* Phase 15 — conflicts, auto-fill, availability, swaps */

export function getShiftConflicts(
  shiftId: string,
  associateId: string
): Promise<ShiftConflictsResponse> {
  return apiFetch<ShiftConflictsResponse>(
    `/scheduling/shifts/${shiftId}/conflicts?associateId=${associateId}`
  );
}

export function getAutoFillCandidates(shiftId: string): Promise<AutoFillResponse> {
  return apiFetch<AutoFillResponse>(`/scheduling/shifts/${shiftId}/auto-fill`);
}

export function getMyAvailability(): Promise<AvailabilityListResponse> {
  return apiFetch<AvailabilityListResponse>('/scheduling/me/availability');
}

export function replaceMyAvailability(
  body: AvailabilityReplaceInput
): Promise<AvailabilityListResponse> {
  return apiFetch<AvailabilityListResponse>('/scheduling/me/availability', {
    method: 'PUT',
    body,
  });
}

export function createSwap(body: SwapCreateInput): Promise<ShiftSwapRequest> {
  return apiFetch<ShiftSwapRequest>('/scheduling/swap-requests', {
    method: 'POST',
    body,
  });
}

export function listSwapsIncoming(): Promise<ShiftSwapListResponse> {
  return apiFetch<ShiftSwapListResponse>('/scheduling/swap-requests/me/incoming');
}

export function listSwapsOutgoing(): Promise<ShiftSwapListResponse> {
  return apiFetch<ShiftSwapListResponse>('/scheduling/swap-requests/me/outgoing');
}

export function peerAcceptSwap(id: string): Promise<ShiftSwapRequest> {
  return apiFetch<ShiftSwapRequest>(`/scheduling/swap-requests/${id}/peer-accept`, {
    method: 'POST',
  });
}

export function peerDeclineSwap(id: string): Promise<ShiftSwapRequest> {
  return apiFetch<ShiftSwapRequest>(`/scheduling/swap-requests/${id}/peer-decline`, {
    method: 'POST',
  });
}

export function cancelSwap(id: string): Promise<ShiftSwapRequest> {
  return apiFetch<ShiftSwapRequest>(`/scheduling/swap-requests/${id}/cancel`, {
    method: 'POST',
  });
}

export function listAdminSwaps(filters: { status?: ShiftSwapStatus } = {}): Promise<ShiftSwapListResponse> {
  const qs = filters.status ? `?status=${filters.status}` : '';
  return apiFetch<ShiftSwapListResponse>(`/scheduling/swap-requests/admin${qs}`);
}

export function managerApproveSwap(id: string, body: SwapDecideInput = {}): Promise<ShiftSwapRequest> {
  return apiFetch<ShiftSwapRequest>(`/scheduling/swap-requests/${id}/manager-approve`, {
    method: 'POST',
    body,
  });
}

export function managerRejectSwap(id: string, body: SwapDecideInput = {}): Promise<ShiftSwapRequest> {
  return apiFetch<ShiftSwapRequest>(`/scheduling/swap-requests/${id}/manager-reject`, {
    method: 'POST',
    body,
  });
}

/* Phase 51 — shift templates + copy-week */

export function listShiftTemplates(
  filters: { clientId?: string } = {}
): Promise<ShiftTemplateListResponse> {
  const qs = filters.clientId ? `?clientId=${filters.clientId}` : '';
  return apiFetch<ShiftTemplateListResponse>(`/scheduling/templates${qs}`);
}

export function createShiftTemplate(
  body: ShiftTemplateCreateInput
): Promise<ShiftTemplate> {
  return apiFetch<ShiftTemplate>('/scheduling/templates', { method: 'POST', body });
}

export function deleteShiftTemplate(id: string): Promise<void> {
  return apiFetch<void>(`/scheduling/templates/${id}`, { method: 'DELETE' });
}

export function applyShiftTemplate(
  id: string,
  body: ShiftTemplateApplyInput
): Promise<Shift> {
  return apiFetch<Shift>(`/scheduling/templates/${id}/apply`, {
    method: 'POST',
    body,
  });
}

export function copyWeek(body: CopyWeekInput): Promise<CopyWeekResponse> {
  return apiFetch<CopyWeekResponse>('/scheduling/copy-week', {
    method: 'POST',
    body,
  });
}

/* Phase 53 — pivot week view + publish-week ============================== */

export function listSchedulingAssociates(): Promise<AssociateListResponse> {
  return apiFetch<AssociateListResponse>('/scheduling/associates');
}

export function publishWeek(body: PublishWeekInput): Promise<PublishWeekResponse> {
  return apiFetch<PublishWeekResponse>('/scheduling/publish-week', {
    method: 'POST',
    body,
  });
}

export function autoScheduleWeek(
  body: AutoScheduleWeekInput,
): Promise<AutoScheduleWeekResponse> {
  return apiFetch<AutoScheduleWeekResponse>('/scheduling/auto-schedule-week', {
    method: 'POST',
    body,
  });
}
