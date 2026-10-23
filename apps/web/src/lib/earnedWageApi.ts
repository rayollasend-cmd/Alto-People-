import { apiFetch } from './api';

/** Earned-wage access — the associate's side and Finance's desk. */

export interface EwaAvailability {
  enabled: boolean;
  blocker: 'OFF' | 'NO_SCHEDULE' | 'NO_VERIFIED_ACCOUNT' | 'NOTHING_EARNED' | 'LIMIT_REACHED' | null;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  hoursWorked: number;
  earnedGross: number;
  earnedNet: number;
  capPct: number;
  cap: number;
  maxPerPeriod: number;
  drawn: number;
  available: number;
  fee: number;
}

export interface EwaAdvance {
  id: string;
  periodStart: string;
  periodEnd: string;
  amount: number;
  fee: number;
  status: 'REQUESTED' | 'PAID' | 'FAILED' | 'RECOVERED' | 'CANCELLED';
  provider: string | null;
  failureReason: string | null;
  requestedAt: string;
  paidAt: string | null;
  recovered: number;
  recoveredAt: string | null;
  associate?: { id: string; name: string };
}

export function getMyEarnedWage(): Promise<EwaAvailability> {
  return apiFetch('/me/earned-wage');
}

export function requestEarnedWage(amount: number): Promise<{ id: string; status: 'PAID' | 'REQUESTED' | 'FAILED'; amount: number; fee: number; failureReason: string | null }> {
  return apiFetch('/me/earned-wage', { method: 'POST', body: { amount } });
}

export interface EwaDesk {
  settings: { enabled: boolean; capPct: number; fee: number; maxPerPeriod: number };
  outstanding: { count: number; amount: number };
  /** Advances drawn on the pay period running today. */
  thisPeriod?: { count: number; amount: number };
  /** What the latest payroll that recovered anything took back. */
  lastRecovery?: { runId: string; on: string; amount: number; advances: number } | null;
  /** Paid advances whose period ended and the check couldn't fully recover. */
  rolledOver?: { count: number; amount: number };
  /** People who drew an advance in the last 90 days. */
  people?: number;
  advances: EwaAdvance[];
}

export function getEarnedWageDesk(status: 'OPEN' | 'ALL' | 'PAID' | 'RECOVERED' | 'FAILED' = 'ALL'): Promise<EwaDesk> {
  return apiFetch(`/payroll/earned-wage?status=${status}`);
}

export function updateEarnedWageSettings(body: Partial<EwaDesk['settings']>): Promise<EwaDesk['settings']> {
  return apiFetch('/payroll/earned-wage/settings', { method: 'PATCH', body });
}
