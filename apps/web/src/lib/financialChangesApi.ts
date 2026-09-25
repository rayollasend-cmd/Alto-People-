import type {
  FinancialChangeRow,
  FinancialChangeStatus,
  VerifyFinancialChangeInput,
} from '@alto-people/shared';
import { apiFetch } from '@/lib/api';

export type FinancialChangeFilter = 'OPEN' | 'ALL' | FinancialChangeStatus;

export interface FinancialChangesResponse {
  rows: FinancialChangeRow[];
  counts: { pending: number; held: number };
}

export function listFinancialChanges(
  status: FinancialChangeFilter = 'OPEN',
  days = 90,
): Promise<FinancialChangesResponse> {
  const q = new URLSearchParams({ status, days: String(days) });
  return apiFetch<FinancialChangesResponse>(`/payroll/financial-changes?${q.toString()}`);
}

export function getFinancialChangesSummary(): Promise<{ pending: number; held: number; open: number }> {
  return apiFetch(`/payroll/financial-changes/summary`);
}

export function getFinancialChange(
  id: string,
): Promise<{ change: FinancialChangeRow; trail: Array<{ id: string; action: string; actorUserId: string | null; at: string }> }> {
  return apiFetch(`/payroll/financial-changes/${id}`);
}

export function verifyFinancialChange(id: string, body: VerifyFinancialChangeInput): Promise<{ change: FinancialChangeRow }> {
  return apiFetch(`/payroll/financial-changes/${id}/verify`, { method: 'POST', body });
}

export function rejectFinancialChange(id: string, note: string): Promise<{ change: FinancialChangeRow }> {
  return apiFetch(`/payroll/financial-changes/${id}/reject`, { method: 'POST', body: { note } });
}

export function holdFinancialChange(id: string, note: string): Promise<{ change: FinancialChangeRow }> {
  return apiFetch(`/payroll/financial-changes/${id}/hold`, { method: 'POST', body: { note } });
}
