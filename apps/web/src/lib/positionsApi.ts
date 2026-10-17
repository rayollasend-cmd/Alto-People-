import type {
  PendingApprovalResponse,
  Position,
  PositionAssignInput,
  PositionHeadcount,
  PositionInput,
  PositionListResponse,
  PositionStatus,
} from '@alto-people/shared';
import { apiFetch } from './api';

export function listPositions(filters: {
  clientId?: string;
  status?: PositionStatus;
} = {}): Promise<PositionListResponse> {
  const sp = new URLSearchParams();
  if (filters.clientId) sp.set('clientId', filters.clientId);
  if (filters.status) sp.set('status', filters.status);
  const qs = sp.toString();
  return apiFetch<PositionListResponse>(`/positions${qs ? `?${qs}` : ''}`);
}

export function getHeadcount(clientId?: string): Promise<PositionHeadcount> {
  const q = clientId ? `?clientId=${encodeURIComponent(clientId)}` : '';
  return apiFetch<PositionHeadcount>(`/positions/headcount${q}`);
}

export function createPosition(input: PositionInput): Promise<Position> {
  return apiFetch<Position>('/positions', { method: 'POST', body: input });
}

export function updatePosition(
  id: string,
  input: Partial<PositionInput>,
): Promise<Position> {
  return apiFetch<Position>(`/positions/${id}`, { method: 'PUT', body: input });
}

/** Opening a seat may answer 202 — the requisition went to a second person (approval engine). */
export function setPositionStatus(
  id: string,
  status: PositionStatus,
): Promise<Position | PendingApprovalResponse> {
  return apiFetch<Position | PendingApprovalResponse>(`/positions/${id}/status`, {
    method: 'POST',
    body: { status },
  });
}

export function assignPosition(
  id: string,
  input: PositionAssignInput,
): Promise<Position> {
  return apiFetch<Position>(`/positions/${id}/assign`, {
    method: 'POST',
    body: input,
  });
}

export function vacatePosition(id: string): Promise<Position> {
  return apiFetch<Position>(`/positions/${id}/vacate`, { method: 'POST' });
}

export function deletePosition(id: string): Promise<void> {
  return apiFetch<void>(`/positions/${id}`, { method: 'DELETE' });
}

/** The headcount plan (GET /positions/plan): budget against the seat's real cost. */
export interface PlanPosition {
  id: string;
  code: string;
  title: string;
  status: string;
  departmentId: string | null;
  departmentName: string | null;
  fteAuthorized: string;
  filledByAssociateId: string | null;
  filledByName: string | null;
  budgetAmount: string | null;
  budgetPeriod: 'ANNUAL' | 'MONTHLY' | null;
  annualBudget: number | null;
  projectedAnnualCost: number | null;
  paidYearToDate: number;
  variance: number | null;
}
export interface PlanDepartment {
  departmentId: string | null;
  departmentName: string;
  positions: number;
  filled: number;
  budget: number;
  projected: number;
  paidYearToDate: number;
  unbudgeted: number;
  variance: number;
}
export interface HeadcountPlan {
  year: number;
  positions: PlanPosition[];
  departments: PlanDepartment[];
  totals: { positions: number; filled: number; budget: number; projected: number; paidYearToDate: number; unbudgeted: number; variance: number };
}
export function getHeadcountPlan(params: { clientId?: string; year?: number } = {}): Promise<HeadcountPlan> {
  const q = new URLSearchParams();
  if (params.clientId) q.set('clientId', params.clientId);
  if (params.year) q.set('year', String(params.year));
  const qs = q.toString();
  return apiFetch<HeadcountPlan>(`/positions/plan${qs ? `?${qs}` : ''}`);
}
