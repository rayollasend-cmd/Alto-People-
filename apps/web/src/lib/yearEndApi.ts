import { apiFetch } from './api';

/** Year-end reconciliation (apps/api/src/lib/yearEndReconciliation.ts). */

export type PersonMetric = 'box1' | 'box2' | 'box3' | 'box4' | 'box5' | 'box6' | `state:${string}` | `stateTax:${string}`;

export interface ReconRow {
  key: string;
  label: string;
  values: Record<string, number | null>;
  variance: number;
  ok: boolean;
  drill?: PersonMetric;
  note?: string;
}

export interface ReconSection {
  key: string;
  title: string;
  sources: Array<{ key: string; label: string }>;
  rows: ReconRow[];
}

export interface ChecklistItem {
  severity: 'BLOCKING' | 'WARNING' | 'INFO';
  code: string;
  message: string;
  count: number;
  people?: Array<{ associateId: string; name: string }>;
}

export interface YearEndReconciliation {
  year: number;
  generatedAt: string;
  people: number;
  w2Count: number;
  storedW2s: number;
  sections: ReconSection[];
  checklist: ChecklistItem[];
  generatedQuarters: string[];
  summary: { rows: number; variances: number; blocking: number; warnings: number };
}

export interface PersonVariance {
  associateId: string;
  name: string;
  paychecks: number;
  w2: number;
  difference: number;
  w2Source: 'stored' | 'computed' | 'none';
  checks: Array<{ itemId: string; paidAt: string; amount: number }>;
}

export function getYearEndReconciliation(year: number): Promise<YearEndReconciliation> {
  return apiFetch(`/payroll-taxes/year-end/${year}`);
}

export function getPersonVariances(year: number, metric: PersonMetric): Promise<{ metric: PersonMetric; people: PersonVariance[] }> {
  return apiFetch(`/payroll-taxes/year-end/${year}/people?metric=${encodeURIComponent(metric)}`);
}

/** Download the reconciliation workbook with the server's file name. */
export async function downloadYearEndWorkbook(year: number): Promise<void> {
  const res = await fetch(`/api/payroll-taxes/year-end/${year}/export.xlsx`, { credentials: 'include' });
  if (!res.ok) throw new Error(`Could not download the workbook (${res.status}).`);
  const url = URL.createObjectURL(await res.blob());
  const m = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '');
  const a = document.createElement('a');
  a.href = url;
  a.download = m?.[1] ?? `year-end-reconciliation-${year}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
