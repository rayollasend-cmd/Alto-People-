import type {
  ClientPaymentInput,
  ClientPaymentListResponse,
  ClientPaymentRow,
  ClientReceivablesResponse,
  PostingBackfillResult,
  PostingGap,
  ReceivablesAgingResponse,
  ReceivablesDepositAccount,
  ReceivableStatement,
} from '@alto-people/shared';
import { apiFetch } from '@/lib/api';

/** Receivables: what clients owe, the money they pay, and the posting catch-up (packages/shared/src/books/receivables.ts). */

const B = '/books/receivables';

export const RECEIVABLES_KEY = ['books', 'receivables'] as const;

export const getReceivablesAging = (asOf?: string) => apiFetch<ReceivablesAgingResponse>(`${B}${asOf ? `?asOf=${asOf}` : ''}`);
export const listClientPayments = (opts: { clientId?: string; includeUndone?: boolean } = {}) => {
  const p = new URLSearchParams();
  if (opts.clientId) p.set('clientId', opts.clientId);
  if (opts.includeUndone) p.set('includeUndone', 'true');
  const q = p.toString();
  return apiFetch<ClientPaymentListResponse>(`${B}/payments${q ? `?${q}` : ''}`);
};
export const recordClientPayment = (input: ClientPaymentInput) => apiFetch<{ payment: ClientPaymentRow }>(`${B}/payments`, { method: 'POST', body: input });
export const undoClientPayment = (id: string, reason: string) => apiFetch<void>(`${B}/payments/${id}`, { method: 'DELETE', body: { reason } });
export const getClientReceivables = (clientId: string) => apiFetch<ClientReceivablesResponse>(`${B}/clients/${clientId}`);
export const listDepositAccounts = () => apiFetch<{ accounts: ReceivablesDepositAccount[] }>(`${B}/deposit-accounts`);
export const backfillPosting = (since?: string) => apiFetch<PostingBackfillResult>(`${B}/backfill`, { method: 'POST', body: since ? { since } : {} });
export const getPostingGaps = (period: string) => apiFetch<{ gaps: PostingGap[] }>(`${B}/gaps?period=${period}`);

/** Spread `amountCents` over a client's open statements, oldest due first: statementId → cents. */
export function autoApply(statements: ReceivableStatement[], amountCents: number): Record<string, number> {
  const out: Record<string, number> = {};
  let left = amountCents;
  for (const s of [...statements].sort((a, b) => a.dueOn.localeCompare(b.dueOn))) {
    if (left <= 0) break;
    const take = Math.min(left, Math.round(s.open * 100));
    if (take > 0) out[s.statementId] = take;
    left -= take;
  }
  return out;
}
