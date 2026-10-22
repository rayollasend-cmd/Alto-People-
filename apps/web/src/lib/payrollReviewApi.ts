import { apiFetch } from './api';

/** The pre-payroll review (apps/api/src/lib/payrollReview.ts). */

export type ReviewFlag = 'FIRST_PAYCHECK' | 'NET_UP' | 'NET_DOWN' | 'GROSS_SWING' | 'ZERO_NET' | 'NO_FICA' | 'NO_FEDERAL';

export const FLAG_LABEL: Record<ReviewFlag, string> = {
  FIRST_PAYCHECK: 'First paycheck',
  NET_UP: 'Net pay up sharply',
  NET_DOWN: 'Net pay down sharply',
  GROSS_SWING: 'Gross pay swung sharply',
  ZERO_NET: 'Nothing left to pay',
  NO_FICA: 'No Social Security or Medicare withheld',
  NO_FEDERAL: 'No federal income tax withheld',
};

/** Flags that point at a likely error, not just a change worth a glance. */
export const SERIOUS_FLAGS: ReadonlySet<ReviewFlag> = new Set(['ZERO_NET', 'NO_FICA']);

export interface ReviewRow {
  itemId: string;
  associateId: string;
  name: string;
  department: string | null;
  state: string | null;
  type: 'W2' | 'CONTRACTOR';
  hours: number;
  rate: number;
  gross: number;
  preTax: number;
  federal: number;
  socialSecurity: number;
  medicare: number;
  stateTax: number;
  localTax: number;
  /** State disability and paid-leave contributions withheld (CA SDI, NJ TDI/FLI, WA PFML …). */
  stateProgram?: number;
  postTax: number;
  other: number;
  reimbursements: number;
  net: number;
  employerTaxes: number;
  prior: { gross: number; net: number; periodEnd: string } | null;
  netChange: number | null;
  netChangeShare: number | null;
  flags: ReviewFlag[];
}

export interface ReviewGroup {
  name: string;
  people: number;
  gross: number;
  net: number;
  employerTaxes: number;
}

export interface PayrollReviewReport {
  company: string;
  generatedAt: string;
  fingerprint: string;
  run: {
    id: string;
    status: 'DRAFT' | 'FINALIZED' | 'DISBURSED' | 'CANCELLED';
    kind: 'REGULAR' | 'OFF_CYCLE' | 'AMENDMENT' | 'DAILY' | 'MANUAL';
    clientName: string | null;
    periodStart: string;
    periodEnd: string;
    createdByName: string | null;
    createdAt: string;
    finalizedAt: string | null;
    /** The gross stored on the run (absent from older responses). */
    storedGross?: number;
    /** The net stored on the run; with totalsAgree, the check against its paychecks (apps/api/src/lib/payrollRunTotals.ts). */
    storedNet?: number;
    totalsAgree?: boolean;
  };
  totals: {
    people: number;
    contractors: number;
    hours: number;
    gross: number;
    preTax: number;
    employeeTaxes: number;
    postTax: number;
    other: number;
    reimbursements: number;
    net: number;
    employerTaxes: number;
    employerCost: number;
  };
  cash: { lines: Array<{ key: string; label: string; amount: number }>; total: number };
  taxes: { employee: Array<{ key: string; label: string; amount: number }>; employer: Array<{ key: string; label: string; amount: number }>; total: number };
  byDepartment: ReviewGroup[];
  byState: ReviewGroup[];
  previous: { runId: string; periodStart: string; periodEnd: string; people: number; gross: number; net: number; employerTaxes: number } | null;
  flagCounts: Partial<Record<ReviewFlag, number>>;
  rows: ReviewRow[];
  /** Paychecks set to pay by paper check this time. How, not how much: outside the fingerprint. */
  payByCheck?: Array<{ itemId: string; name: string; reason: string; net: number }>;
}

export interface Signoff {
  id: string;
  signedByName: string | null;
  signedAt: string;
  note: string | null;
  soleReviewer: boolean;
}

export interface ReviewState {
  required: boolean;
  current: Signoff | null;
  stale: Signoff | null;
  history: Signoff[];
  canSign: boolean;
  cannotSignReason: string | null;
}

export interface ReviewQueue {
  waiting: Array<{
    id: string;
    status: string;
    kind: string;
    clientName: string | null;
    periodStart: string;
    periodEnd: string;
    people: number;
    totalGross: number;
    totalNet: number;
    createdByName: string | null;
    changedSinceSignoff: boolean;
  }>;
  recent: Array<{ id: string; runId: string; clientName: string | null; periodStart: string; periodEnd: string; signedByName: string | null; signedAt: string; soleReviewer: boolean }>;
}

export function getPayrollReview(runId: string): Promise<{ report: PayrollReviewReport; signoff: ReviewState }> {
  return apiFetch(`/payroll/runs/${runId}/review`);
}

export function getPayrollReviewStatus(runId: string): Promise<{ fingerprint: string; signoff: ReviewState }> {
  return apiFetch(`/payroll/runs/${runId}/review/status`);
}

export function signPayrollReview(runId: string, body: { fingerprint: string; note?: string | null }): Promise<{ signoff: Signoff }> {
  return apiFetch(`/payroll/runs/${runId}/review/sign`, { method: 'POST', body });
}

export function getReviewQueue(): Promise<ReviewQueue> {
  return apiFetch('/payroll/reviews');
}

/** Download the report as a PDF or a workbook, with the server's file name. */
export async function downloadPayrollReview(runId: string, format: 'pdf' | 'xlsx'): Promise<void> {
  const res = await fetch(`/api/payroll/runs/${runId}/review.${format}`, { method: 'GET', credentials: 'include' });
  if (!res.ok) throw new Error(`Could not download the report (${res.status}).`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const m = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '');
  const a = document.createElement('a');
  a.href = url;
  a.download = m?.[1] ?? `payroll-review.${format}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
