import type {
  BooksApAging,
  BooksBill,
  BooksBillInput,
  BooksBillPayment,
  BooksBillPaymentBatchInput,
  BooksBillPaymentInput,
  BooksBillsApproveResult,
  BooksPayablesOptions,
  BooksRecurringBill,
  BooksRecurringBillInput,
  BooksVendor,
  BooksVendor1099Report,
  BooksVendorInput,
  BooksVendorUpdate,
} from '@alto-people/shared';
import { apiFetch } from '@/lib/api';

/** The books — payables (contract: packages/shared/src/books/payables.ts). */

/** The bills list's status filter — the server's ?tab=. 'late' and 'due' never overlap. */
export type BillsTab = 'approve' | 'unpaid' | 'late' | 'due' | 'paid' | 'draft' | 'all';
export interface Pending {
  pending: true;
  approvalId: string;
  title: string;
}

export const PAYABLES_KEY = ['books', 'payables'] as const;

export const listVendors = (opts: { q?: string; active?: 'true' | 'false' | 'all' } = {}) => {
  const p = new URLSearchParams();
  if (opts.q) p.set('q', opts.q);
  if (opts.active) p.set('active', opts.active);
  const qs = p.toString();
  return apiFetch<{ vendors: BooksVendor[] }>(`/books/vendors${qs ? `?${qs}` : ''}`);
};
export const getVendor = (id: string) => apiFetch<{ vendor: BooksVendor; bills: BooksBill[]; payments: BooksBillPayment[] }>(`/books/vendors/${id}`);
export const createVendor = (body: BooksVendorInput) => apiFetch<{ vendor: BooksVendor }>('/books/vendors', { method: 'POST', body });
export const updateVendor = (id: string, body: BooksVendorUpdate) =>
  apiFetch<{ vendor: BooksVendor } | (Pending & { vendor: BooksVendor })>(`/books/vendors/${id}`, { method: 'PATCH', body });

export const listBills = (opts: { tab?: BillsTab; vendorId?: string } = {}) => {
  const p = new URLSearchParams();
  if (opts.tab && opts.tab !== 'all') p.set('tab', opts.tab);
  if (opts.vendorId) p.set('vendorId', opts.vendorId);
  const qs = p.toString();
  return apiFetch<{ bills: BooksBill[] }>(`/books/bills${qs ? `?${qs}` : ''}`);
};
export const getBill = (id: string) => apiFetch<{ bill: BooksBill }>(`/books/bills/${id}`);
export const createBill = (body: BooksBillInput) => apiFetch<{ bill: BooksBill }>('/books/bills', { method: 'POST', body });
export const updateBill = (id: string, body: BooksBillInput) => apiFetch<{ bill: BooksBill }>(`/books/bills/${id}`, { method: 'PATCH', body });
export const submitBill = (id: string) => apiFetch<Pending>(`/books/bills/${id}/submit`, { method: 'POST' });
/** Approve several — each its own decision; the requester's own come back skipped. */
export const approveBills = (ids: string[]) => apiFetch<BooksBillsApproveResult>('/books/bills/approve', { method: 'POST', body: { ids }, timeoutMs: 120_000 });
export const withdrawBill = (id: string) => apiFetch<{ bill: BooksBill }>(`/books/bills/${id}/withdraw`, { method: 'POST' });
export const reopenBill = (id: string, reason: string) => apiFetch<{ bill: BooksBill }>(`/books/bills/${id}/reopen`, { method: 'POST', body: { reason } });
export const voidBill = (id: string, reason: string) => apiFetch<{ bill: BooksBill }>(`/books/bills/${id}/void`, { method: 'POST', body: { reason } });
export const billAttachmentUrl = (id: string) => `/api/books/bills/${id}/attachment`;

/** Multipart, so not apiFetch (which JSON-encodes bodies). */
export async function uploadBillAttachment(id: string, file: File): Promise<{ bill: BooksBill }> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`/api/books/bills/${id}/attachment`, { method: 'POST', body: form, credentials: 'include' });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? `Upload failed (${res.status})`);
  }
  return (await res.json()) as { bill: BooksBill };
}

export const payablesOptions = () => apiFetch<BooksPayablesOptions>('/books/payables/options');
export const payBills = (body: BooksBillPaymentInput) => apiFetch<{ payment: BooksBillPayment }>('/books/bill-payments', { method: 'POST', body });
/** Finance walk 8 — one bill run across vendors (all or nothing); answers with each payment and the cash left. */
export const payBillsBatch = (body: BooksBillPaymentBatchInput) =>
  apiFetch<{ payments: BooksBillPayment[]; cashAfter: number | null }>('/books/bill-payments/batch', { method: 'POST', body, timeoutMs: 120_000 });
export const voidBillPayment = (id: string, reason: string) => apiFetch<{ payment: BooksBillPayment }>(`/books/bill-payments/${id}/void`, { method: 'POST', body: { reason } });

export const listRecurringBills = () => apiFetch<{ recurring: BooksRecurringBill[] }>('/books/recurring-bills');
export const createRecurringBill = (body: BooksRecurringBillInput) => apiFetch<{ recurring: BooksRecurringBill }>('/books/recurring-bills', { method: 'POST', body });
export const updateRecurringBill = (id: string, body: Partial<BooksRecurringBillInput> & { isActive?: boolean }) =>
  apiFetch<{ recurring: BooksRecurringBill }>(`/books/recurring-bills/${id}`, { method: 'PATCH', body });

export const apAging = () => apiFetch<BooksApAging>('/books/payables/aging');
export const vendor1099 = (year: number) => apiFetch<BooksVendor1099Report>(`/books/payables/1099?year=${year}`);
export const vendor1099CsvUrl = (year: number) => `/api/books/payables/1099?year=${year}&format=csv`;
