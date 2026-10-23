import type { HirePaySaveResult, HirePayStatus } from '@alto-people/shared';
import { apiFetch } from './api';

export type PayType = 'HOURLY' | 'SALARY';
export type CompChangeReason =
  | 'HIRE'
  | 'MERIT'
  | 'PROMOTION'
  | 'MARKET_ADJUSTMENT'
  | 'CORRECTION'
  | 'OTHER';

export interface CompRecord {
  id: string;
  associateId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  payType: PayType;
  amount: string;
  currency: string;
  reason: CompChangeReason;
  notes: string | null;
  meritProposalId: string | null;
}

export interface CompBand {
  id: string;
  clientId: string;
  jobProfileId: string | null;
  jobProfileTitle: string | null;
  name: string;
  level: string | null;
  payType: PayType;
  minAmount: string;
  midAmount: string;
  maxAmount: string;
  currency: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export type MeritCycleStatus = 'DRAFT' | 'OPEN' | 'APPLIED' | 'CLOSED';
export type MeritProposalStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'APPROVED'
  | 'REJECTED'
  | 'APPLIED';

export interface MeritCycle {
  id: string;
  clientId: string;
  name: string;
  status: MeritCycleStatus;
  reviewPeriodStart: string;
  reviewPeriodEnd: string;
  effectiveDate: string;
  budget: string | null;
  appliedAt: string | null;
}

export interface MeritProposal {
  id: string;
  cycleId: string;
  associateId: string;
  associateName: string;
  currentAmount: string;
  currentPayType: PayType;
  proposedAmount: string;
  proposedNotes: string | null;
  status: MeritProposalStatus;
  decisionNote: string | null;
  decidedAt: string | null;
}

// Records
export const listRecords = (associateId: string) =>
  apiFetch<{ records: CompRecord[] }>(`/comp/associates/${associateId}/records`);
export const createRecord = (
  associateId: string,
  input: {
    payType: PayType;
    amount: number;
    reason: CompChangeReason;
    notes?: string | null;
    effectiveFrom?: string;
  },
) =>
  // 201 { ok } when it lands; 202 { pending, approvalId } when a second person decides it.
  apiFetch<HirePaySaveResult>(`/comp/associates/${associateId}/records`, {
    method: 'POST',
    body: input,
  });

/** A new hire's starting pay: the window, the pay in force, a wage waiting on approval, the prefill and the ceiling. */
export const getHirePay = (associateId: string) => apiFetch<HirePayStatus>(`/comp/associates/${associateId}/hire-pay`);

// Bands
export const listBands = (clientId?: string) =>
  apiFetch<{ bands: CompBand[] }>(
    clientId ? `/comp/bands?clientId=${clientId}` : '/comp/bands',
  );
export const createBand = (input: {
  clientId: string;
  jobProfileId?: string | null;
  name: string;
  level?: string | null;
  payType: PayType;
  minAmount: number;
  midAmount: number;
  maxAmount: number;
}) =>
  apiFetch<{ id: string }>('/comp/bands', {
    method: 'POST',
    body: input,
  });
export const updateBand = (id: string, input: Partial<Parameters<typeof createBand>[0]>) =>
  apiFetch<{ ok: true }>(`/comp/bands/${id}`, { method: 'PUT', body: input });
export const deleteBand = (id: string) =>
  apiFetch<void>(`/comp/bands/${id}`, { method: 'DELETE' });

// Cycles
export const listCycles = (clientId?: string) =>
  apiFetch<{ cycles: MeritCycle[] }>(
    clientId ? `/comp/cycles?clientId=${clientId}` : '/comp/cycles',
  );
export const createCycle = (input: {
  clientId: string;
  name: string;
  reviewPeriodStart: string;
  reviewPeriodEnd: string;
  effectiveDate: string;
  budget?: number;
}) => apiFetch<{ id: string }>('/comp/cycles', { method: 'POST', body: input });
export const seedCycle = (cycleId: string) =>
  apiFetch<{ created: number; total: number }>(
    `/comp/cycles/${cycleId}/proposals/seed`,
    { method: 'POST', body: {} },
  );
export const listProposals = (cycleId: string) =>
  apiFetch<{ proposals: MeritProposal[] }>(`/comp/cycles/${cycleId}/proposals`);
export const updateProposal = (
  cycleId: string,
  proposalId: string,
  input: {
    proposedAmount?: number;
    proposedNotes?: string | null;
    status?: 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED';
    decisionNote?: string | null;
  },
) =>
  apiFetch<{ ok: true }>(`/comp/cycles/${cycleId}/proposals/${proposalId}`, {
    method: 'PUT',
    body: input,
  });
export const applyCycle = (cycleId: string) =>
  apiFetch<{ applied: number; stale: number }>(
    `/comp/cycles/${cycleId}/apply`,
    { method: 'POST', body: {} },
  );

/** Compensation planning (HR pack 2026-10): the manager's worksheet and HR's calibration. */
export interface WorksheetRow {
  id: string;
  associateId: string;
  associateName: string;
  jobTitle: string | null;
  managerId: string | null;
  managerName: string | null;
  payType: PayType;
  currentAmount: string;
  proposedAmount: string;
  increasePct: number | null;
  status: MeritProposalStatus;
  proposedNotes: string | null;
  decisionNote: string | null;
  band: { name: string; min: string; mid: string; max: string } | null;
  bandPositionNow: number | null;
  bandPositionProposed: number | null;
  lastRating: number | null;
  lastReviewEnd: string | null;
}
export interface Worksheet {
  cycle: { id: string; name: string; status: MeritCycleStatus; effectiveDate: string; budget: string | null };
  budget: { share: string | null; spent: number; remaining: number | null };
  rows: WorksheetRow[];
  editable: boolean;
}
export interface Calibration {
  cycle: { id: string; name: string; status: MeritCycleStatus; budget: string | null; effectiveDate: string };
  totals: { people: number; spent: number; remaining: number | null; meanPct: number | null; medianPct: number | null; p25: number; p75: number; pending: number };
  distribution: Array<{ label: string; count: number }>;
  managers: Array<{ managerId: string | null; managerName: string; people: number; avgPct: number; spent: number; pending: number }>;
  outliers: Array<WorksheetRow & { reason: string }>;
  rows: WorksheetRow[];
}
export const getWorksheet = (cycleId: string, managerId?: string) =>
  apiFetch<Worksheet>(`/comp/cycles/${cycleId}/worksheet${managerId ? `?managerId=${managerId}` : ''}`);
export const getCalibration = (cycleId: string) => apiFetch<Calibration>(`/comp/cycles/${cycleId}/calibration`);

/** GET /comp/overview — who is paid outside their band, pay changes waiting, the live cycle (apps/api routes/compensation.ts). */
export interface CompOverview {
  /** Employed people in reach (in the client, when one is picked). */
  people: number;
  belowMin: number;
  aboveMax: number;
  inBand: number;
  /** A rate on file but no band for their client, pay type and role. */
  noBand: number;
  noRate: number;
  outsideBand: Array<{ associateId: string; name: string; payType: PayType; amount: string; band: string; min: string; max: string; where: 'BELOW' | 'ABOVE' }>;
  outsideTruncated: boolean;
  /** Pay-rate changes and promotions waiting on a second person. */
  pendingPayChanges: number;
  cycle: { id: string; name: string; status: MeritCycleStatus; effectiveDate: string; budget: string | null; spent: string; people: number; pending: number } | null;
}

export const getCompOverview = (clientId?: string) =>
  apiFetch<CompOverview>(`/comp/overview${clientId ? `?clientId=${encodeURIComponent(clientId)}` : ''}`);
