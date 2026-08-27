import type {
  AdminOpenShiftClaimListResponse,
  AssociateListResponse,
  AutoFillResponse,
  AutoScheduleWeekInput,
  AutoScheduleWeekResponse,
  AvailabilityExceptionCreateInput,
  AvailabilityExceptionListResponse,
  AvailabilityException,
  AvailabilityListResponse,
  AvailabilityOverviewResponse,
  AvailabilityReplaceInput,
  MyShiftHistoryResponse,
  OpenShiftClaim,
  OpenShiftsResponse,
  TradeOptionsResponse,
  BulkCreateShiftsInput,
  BulkCreateShiftsResponse,
  CalendarFeedUrlResponse,
  CopyWeekInput,
  CopyWeekResponse,
  DedupeDraftsInput,
  DedupeDraftsResponse,
  FloorNowResponse,
  OtOutlookResponse,
  LaborCostReportResponse,
  MyShiftDetailResponse,
  StaffingTargetInput,
  StaffingTargetsResponse,
  PublishWeekInput,
  PublishWeekResponse,
  Shift,
  ShiftAssignInput,
  ShiftCancelInput,
  ShiftRateDefault,
  ShiftRateDefaultInput,
  ShiftRateDefaultListResponse,
  ShiftConflictsResponse,
  ShiftCreateInput,
  ShiftListResponse,
  ShiftTeam as ShiftTeamData,
  ShiftTeamCreateInput,
  ShiftTeamDetailResponse,
  ShiftTeamListResponse,
  ShiftTeamUpdateInput,
  ShiftStatus,
  ShiftSwapListResponse,
  ShiftSwapRequest,
  ShiftSwapStatus,
  ShiftTemplate,
  ShiftTemplateApplyInput,
  ShiftTemplateCreateInput,
  ShiftTemplateListResponse,
  ShiftUpdateInput,
  SwapCandidateListResponse,
  SwapCreateInput,
  SwapDecideInput,
} from '@alto-people/shared';
import { apiFetch } from './api';

interface ShiftListFilters {
  status?: ShiftStatus;
  clientId?: string;
  locationId?: string;
  from?: string;
  to?: string;
}

function qs(filters: ShiftListFilters): string {
  const p = new URLSearchParams();
  if (filters.status) p.set('status', filters.status);
  if (filters.clientId) p.set('clientId', filters.clientId);
  if (filters.locationId) p.set('locationId', filters.locationId);
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

/** One of my shifts + the teammates working alongside it. */
export function getMyShiftDetail(id: string): Promise<MyShiftDetailResponse> {
  return apiFetch<MyShiftDetailResponse>(`/scheduling/me/shifts/${id}`);
}

/** Older shifts, newest-first, 50/page. Omit `before` for the first page. */
export function listMyShiftHistory(before?: string): Promise<MyShiftHistoryResponse> {
  const q = before ? `?before=${encodeURIComponent(before)}` : '';
  return apiFetch<MyShiftHistoryResponse>(`/scheduling/me/shifts/history${q}`);
}

/** "I'll be there." Idempotent; returns the updated shift. */
export function acknowledgeMyShift(id: string): Promise<Shift> {
  return apiFetch<Shift>(`/scheduling/me/shifts/${id}/acknowledge`, {
    method: 'POST',
  });
}

/** Open shifts I'm eligible to pick up (conflict/PTO-filtered server-side). */
export function listMyOpenShifts(): Promise<OpenShiftsResponse> {
  return apiFetch<OpenShiftsResponse>('/scheduling/me/open-shifts');
}

export function claimOpenShift(shiftId: string): Promise<OpenShiftClaim> {
  return apiFetch<OpenShiftClaim>(`/scheduling/me/open-shifts/${shiftId}/claim`, {
    method: 'POST',
  });
}

export function withdrawOpenShiftClaim(claimId: string): Promise<void> {
  return apiFetch<void>(`/scheduling/me/open-shift-claims/${claimId}/withdraw`, {
    method: 'POST',
  });
}

/** Admin: pending pickup requests awaiting a decision. */
export function listOpenShiftClaims(): Promise<AdminOpenShiftClaimListResponse> {
  return apiFetch<AdminOpenShiftClaimListResponse>('/scheduling/open-shift-claims');
}

export function approveOpenShiftClaim(id: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`/scheduling/open-shift-claims/${id}/approve`, {
    method: 'POST',
  });
}

export function rejectOpenShiftClaim(id: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`/scheduling/open-shift-claims/${id}/reject`, {
    method: 'POST',
  });
}

/** One-off "can't work this day" exceptions. */
export function listMyAvailabilityExceptions(): Promise<AvailabilityExceptionListResponse> {
  return apiFetch<AvailabilityExceptionListResponse>(
    '/scheduling/me/availability/exceptions',
  );
}

export function addAvailabilityException(
  body: AvailabilityExceptionCreateInput,
): Promise<AvailabilityException> {
  return apiFetch<AvailabilityException>('/scheduling/me/availability/exceptions', {
    method: 'POST',
    body,
  });
}

export function deleteAvailabilityException(id: string): Promise<void> {
  return apiFetch<void>(`/scheduling/me/availability/exceptions/${id}`, {
    method: 'DELETE',
  });
}

/** The counterparty's upcoming shifts — pickable as the trade half. */
export function listTradeOptions(counterpartyId: string): Promise<TradeOptionsResponse> {
  return apiFetch<TradeOptionsResponse>(
    `/scheduling/me/trade-options?counterpartyId=${encodeURIComponent(counterpartyId)}`,
  );
}

/** Who I can offer this shift to (busy = they're already booked then). */
export function listSwapCandidates(shiftId: string): Promise<SwapCandidateListResponse> {
  return apiFetch<SwapCandidateListResponse>(
    `/scheduling/me/shifts/${shiftId}/swap-candidates`,
  );
}

export function getMyCalendarUrl(): Promise<CalendarFeedUrlResponse> {
  return apiFetch<CalendarFeedUrlResponse>('/scheduling/me/calendar-url');
}

/** Invalidates the current feed URL (per-associate) and returns a fresh one. */
export function rotateMyCalendarUrl(): Promise<CalendarFeedUrlResponse> {
  return apiFetch<CalendarFeedUrlResponse>('/scheduling/me/calendar-url/rotate', {
    method: 'POST',
  });
}

export function createShift(body: ShiftCreateInput): Promise<Shift> {
  return apiFetch<Shift>('/scheduling/shifts', { method: 'POST', body });
}

/** Create one shift and assign a copy to each listed employee (+ open slots). */
export function bulkCreateShifts(
  body: BulkCreateShiftsInput,
): Promise<BulkCreateShiftsResponse> {
  return apiFetch<BulkCreateShiftsResponse>('/scheduling/shifts/bulk', {
    method: 'POST',
    body,
  });
}

export function updateShift(id: string, body: ShiftUpdateInput): Promise<Shift> {
  return apiFetch<Shift>(`/scheduling/shifts/${id}`, { method: 'PATCH', body });
}

/** Hard-delete a shift (vs. cancelShift, which keeps a CANCELLED record). */
export function deleteShift(id: string): Promise<void> {
  return apiFetch<void>(`/scheduling/shifts/${id}`, { method: 'DELETE' });
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

/** Day-by-day scheduled + worked labor cost per client and store. */
export function laborCosts(params: {
  from: string;
  to: string;
  clientId?: string;
  locationId?: string;
}): Promise<LaborCostReportResponse> {
  const p = new URLSearchParams({ from: params.from, to: params.to });
  if (params.clientId) p.set('clientId', params.clientId);
  if (params.locationId) p.set('locationId', params.locationId);
  return apiFetch<LaborCostReportResponse>(`/scheduling/labor-costs?${p.toString()}`);
}

/** Every in-scope store with its current expected floor headcount. */
export function listStaffingTargets(): Promise<StaffingTargetsResponse> {
  return apiFetch<StaffingTargetsResponse>('/scheduling/staffing-targets');
}

/** Record a new effective-dated target — history is never edited. */
export function setStaffingTarget(body: StaffingTargetInput): Promise<{
  id: string;
  locationId: string;
  targetCount: number;
  effectiveFrom: string;
}> {
  return apiFetch('/scheduling/staffing-targets', { method: 'POST', body });
}

/** Clocked-in right now vs the expected headcount per store. */
/** Persist the client's grid row order (whole roster, replace-all). */
export function saveRosterOrder(
  clientId: string,
  orderedIds: string[],
): Promise<{ ok: true }> {
  return apiFetch('/scheduling/roster-order', {
    method: 'POST',
    body: { clientId, orderedIds },
  });
}

/**
 * Anchor move: put `moveId` directly above/below `anchorId` in the FULL
 * saved roster order. Safe under any filter — hidden people keep their
 * positions, which replace-all cannot guarantee from a filtered view.
 */
export function moveRosterRow(
  clientId: string,
  moveId: string,
  anchorId: string,
  place: 'before' | 'after',
): Promise<{ ok: true }> {
  return apiFetch('/scheduling/roster-order', {
    method: 'POST',
    body: {
      clientId,
      moveId,
      ...(place === 'before' ? { beforeId: anchorId } : { afterId: anchorId }),
    },
  });
}

export function floorNow(): Promise<FloorNowResponse> {
  return apiFetch<FloorNowResponse>('/scheduling/floor-now');
}

/** Everyone projected past 40h this week, by name — the OT radar's list. */
export function otOutlook(): Promise<OtOutlookResponse> {
  return apiFetch<OtOutlookResponse>('/scheduling/ot-outlook');
}

/** Delete exact-twin DRAFT shifts in the window, keeping the oldest of
 *  each group. Cleanup for pre-idempotency copy-week duplicates. */
export function dedupeDrafts(body: DedupeDraftsInput): Promise<DedupeDraftsResponse> {
  return apiFetch<DedupeDraftsResponse>('/scheduling/drafts/dedupe', {
    method: 'POST',
    body,
  });
}

/* Phase 53 — pivot week view + publish-week ============================== */

export function listSchedulingAssociates(
  filters: { clientId?: string; locationId?: string; teamId?: string } = {},
): Promise<AssociateListResponse> {
  const p = new URLSearchParams();
  if (filters.clientId) p.set('clientId', filters.clientId);
  if (filters.locationId) p.set('locationId', filters.locationId);
  if (filters.teamId) p.set('teamId', filters.teamId);
  const qs = p.toString();
  return apiFetch<AssociateListResponse>(
    `/scheduling/associates${qs ? `?${qs}` : ''}`,
  );
}

/** Fit data (availability windows + PTO-blocked days) for the visible range. */
export function getAvailabilityOverview(
  from: string,
  to: string,
): Promise<AvailabilityOverviewResponse> {
  const p = new URLSearchParams({ from, to });
  return apiFetch<AvailabilityOverviewResponse>(
    `/scheduling/availability-overview?${p.toString()}`,
  );
}

/* Shift teams — standing crews that scope the scheduling roster. */

export function listShiftTeams(
  filters: { clientId?: string; locationId?: string } = {},
): Promise<ShiftTeamListResponse> {
  const p = new URLSearchParams();
  if (filters.clientId) p.set('clientId', filters.clientId);
  if (filters.locationId) p.set('locationId', filters.locationId);
  const qs = p.toString();
  return apiFetch<ShiftTeamListResponse>(
    `/scheduling/teams${qs ? `?${qs}` : ''}`,
  );
}

export function createShiftTeam(body: ShiftTeamCreateInput): Promise<ShiftTeamData> {
  return apiFetch<ShiftTeamData>('/scheduling/teams', { method: 'POST', body });
}

export function updateShiftTeam(
  id: string,
  body: ShiftTeamUpdateInput,
): Promise<ShiftTeamData> {
  return apiFetch<ShiftTeamData>(`/scheduling/teams/${id}`, {
    method: 'PATCH',
    body,
  });
}

export function deleteShiftTeam(id: string): Promise<void> {
  return apiFetch<void>(`/scheduling/teams/${id}`, { method: 'DELETE' });
}

export function getShiftTeam(id: string): Promise<ShiftTeamDetailResponse> {
  return apiFetch<ShiftTeamDetailResponse>(`/scheduling/teams/${id}`);
}

export function addShiftTeamMember(
  teamId: string,
  associateId: string,
): Promise<void> {
  return apiFetch<void>(`/scheduling/teams/${teamId}/members`, {
    method: 'POST',
    body: { associateId },
  });
}

export function removeShiftTeamMember(
  teamId: string,
  associateId: string,
): Promise<void> {
  return apiFetch<void>(`/scheduling/teams/${teamId}/members/${associateId}`, {
    method: 'DELETE',
  });
}

/** One-click cure for "not at this site": opens an AssociateAssignment at
 *  the team's location (close-then-open, same as the org transfer). */
export function assignTeamMemberHere(
  teamId: string,
  associateId: string,
): Promise<{ assignmentId: string }> {
  return apiFetch<{ assignmentId: string }>(
    `/scheduling/teams/${teamId}/members/${associateId}/assign-here`,
    { method: 'POST' },
  );
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

/* ----- Pay-rate defaults per (client, position) -------------------------- */

export function listRateDefaults(
  clientId: string,
): Promise<ShiftRateDefaultListResponse> {
  return apiFetch<ShiftRateDefaultListResponse>(
    `/scheduling/rate-defaults?clientId=${encodeURIComponent(clientId)}`,
  );
}

export function upsertRateDefault(
  body: ShiftRateDefaultInput,
): Promise<ShiftRateDefault> {
  return apiFetch<ShiftRateDefault>('/scheduling/rate-defaults', {
    method: 'PUT',
    body,
  });
}

export function deleteRateDefault(id: string): Promise<void> {
  return apiFetch<void>(`/scheduling/rate-defaults/${id}`, {
    method: 'DELETE',
  });
}
