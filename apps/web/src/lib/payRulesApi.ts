import { apiFetch } from './api';

export interface Project {
  id: string;
  clientId: string;
  code: string;
  name: string;
  description: string | null;
  isBillable: boolean;
  isActive: boolean;
}

export type PremiumPayKind =
  | 'OVERTIME_DAILY'
  | 'OVERTIME_WEEKLY'
  | 'NIGHT_DIFFERENTIAL'
  | 'WEEKEND_DIFFERENTIAL'
  | 'HOLIDAY'
  | 'SHIFT_DIFFERENTIAL'
  | 'CALL_BACK'
  | 'ON_CALL';

export interface PremiumPayRule {
  id: string;
  clientId: string;
  name: string;
  kind: PremiumPayKind;
  multiplier: string | null;
  addPerHour: string | null;
  thresholdHours: string | null;
  startMinute: number | null;
  endMinute: number | null;
  dowMask: number | null;
  isActive: boolean;
}

export type TipPoolStatus = 'OPEN' | 'CLOSED' | 'PAID_OUT';

export interface TipPool {
  id: string;
  clientId: string;
  name: string;
  shiftDate: string;
  totalAmount: string;
  currency: string;
  status: TipPoolStatus;
  notes: string | null;
  closedAt: string | null;
  paidOutAt: string | null;
  allocationCount: number;
}

export interface TipAllocation {
  id: string;
  associateId: string;
  associateName: string;
  hoursWorked: string;
  sharePct: string | null;
  amount: string;
}

// Projects
export const listProjects = (clientId?: string, includeInactive = false) => {
  const q = new URLSearchParams();
  if (clientId) q.set('clientId', clientId);
  if (includeInactive) q.set('includeInactive', '1');
  const qs = q.toString();
  return apiFetch<{ projects: Project[] }>(qs ? `/projects?${qs}` : '/projects');
};
export const createProject = (input: {
  clientId: string;
  code: string;
  name: string;
  description?: string | null;
  isBillable?: boolean;
}) => apiFetch<{ id: string }>('/projects', { method: 'POST', body: input });
export const updateProject = (id: string, input: Partial<Parameters<typeof createProject>[0]> & { isActive?: boolean }) =>
  apiFetch<{ ok: true }>(`/projects/${id}`, { method: 'PUT', body: input });
export const deactivateProject = (id: string) =>
  apiFetch<void>(`/projects/${id}`, { method: 'DELETE' });

// Premium pay
export const listPremiumPayRules = (clientId?: string) =>
  apiFetch<{ rules: PremiumPayRule[] }>(
    clientId ? `/premium-pay-rules?clientId=${clientId}` : '/premium-pay-rules',
  );
export const createPremiumPayRule = (input: {
  clientId: string;
  name: string;
  kind: PremiumPayKind;
  multiplier?: number | null;
  addPerHour?: number | null;
  thresholdHours?: number | null;
  startMinute?: number | null;
  endMinute?: number | null;
  dowMask?: number | null;
}) => apiFetch<{ id: string }>('/premium-pay-rules', { method: 'POST', body: input });
export const updatePremiumPayRule = (id: string, input: Partial<Parameters<typeof createPremiumPayRule>[0]> & { isActive?: boolean }) =>
  apiFetch<{ ok: true }>(`/premium-pay-rules/${id}`, { method: 'PUT', body: input });
export const deletePremiumPayRule = (id: string) =>
  apiFetch<void>(`/premium-pay-rules/${id}`, { method: 'DELETE' });

// Tip pools
export const listTipPools = (clientId?: string) =>
  apiFetch<{ pools: TipPool[] }>(
    clientId ? `/tip-pools?clientId=${clientId}` : '/tip-pools',
  );
export const createTipPool = (input: {
  clientId: string;
  name: string;
  shiftDate: string;
  totalAmount: number;
  notes?: string | null;
}) => apiFetch<{ id: string }>('/tip-pools', { method: 'POST', body: input });
export const listAllocations = (tipPoolId: string) =>
  apiFetch<{ allocations: TipAllocation[] }>(`/tip-pools/${tipPoolId}/allocations`);
export const addAllocation = (
  tipPoolId: string,
  input: { associateId: string; hoursWorked?: number; sharePct?: number; amount: number },
) =>
  apiFetch<{ ok: true }>(`/tip-pools/${tipPoolId}/allocations`, {
    method: 'POST',
    body: input,
  });
export const autoAllocate = (
  tipPoolId: string,
  input: { from: string; to: string },
) =>
  apiFetch<{ allocated: number; totalHours: number }>(
    `/tip-pools/${tipPoolId}/auto-allocate-by-hours`,
    { method: 'POST', body: input },
  );
export const closeTipPool = (id: string) =>
  apiFetch<{ ok: true }>(`/tip-pools/${id}/close`, { method: 'PUT', body: {} });
export const payOutTipPool = (id: string) =>
  apiFetch<{ ok: true }>(`/tip-pools/${id}/pay-out`, { method: 'PUT', body: {} });
