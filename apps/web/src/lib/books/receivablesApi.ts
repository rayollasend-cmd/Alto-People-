import type {
  BankTxnView,
  ClientPaymentInput,
  ClientPaymentListResponse,
  ClientPaymentRow,
  PostingBackfillResult,
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
export const recordClientPayment = (input: ClientPaymentInput) => apiFetch<{ payment: ClientPaymentRow; bankTransaction?: BankTxnView | null; depositMatched?: boolean }>(`${B}/payments`, { method: 'POST', body: input });
export const undoClientPayment = (id: string, reason: string) => apiFetch<void>(`${B}/payments/${id}`, { method: 'DELETE', body: { reason } });
export const listDepositAccounts = () => apiFetch<{ accounts: ReceivablesDepositAccount[] }>(`${B}/deposit-accounts`);
export const backfillPosting = (since?: string) => apiFetch<PostingBackfillResult>(`${B}/backfill`, { method: 'POST', body: since ? { since } : {} });

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

/* ---- Collections (finance walk 7) ------------------------------------------ */

export type CollectionNoteKind = 'PROMISE' | 'CALL' | 'NOTE';

export interface CollectionNote {
  id: string;
  kind: CollectionNoteKind;
  note: string;
  promisedOn: string | null;
  promisedAmount: number | null;
  createdAt: string;
}

/** One open statement on the collections worklist: where the reminder cadence stands and what to do next. */
export interface CollectionItem extends ReceivableStatement {
  reminderStage: number;
  lastReminderAt: string | null;
  nextReminderOn: string | null;
  paused: boolean;
  pauseNote: string | null;
  contactEmail: string | null;
  lastNote: CollectionNote | null;
  /** The day the next action falls due — the worklist's sort. */
  nextActionOn: string;
}

export interface CollectionsWorklist {
  asOf: string;
  items: CollectionItem[];
  totals: { open: number; statements: number };
}

export interface DsoMonth {
  key: string;
  label: string;
  /** Average days from finalized to paid for statements paid that month; null with none paid. */
  days: number | null;
  statements: number;
  collected: number;
}

export const getCollectionsWorklist = () => apiFetch<CollectionsWorklist>(`${B}/worklist`);
export interface DsoResponse {
  months: DsoMonth[];
  /** Statements paid in the last 90 days: average days from finalized to paid (null with none). */
  last90: { days: number | null; statements: number };
  /** Client payments received this calendar month, undone ones left out. */
  collectedThisMonth: { amount: number; payments: number };
}
export const getDsoTrend = (months = 6) => apiFetch<DsoResponse>(`${B}/dso?months=${months}`);
export const sendReminderNow = (clientId: string, statementId: string) =>
  apiFetch<{ stage: number; recipients: number }>(`/clients/${clientId}/dunning/send-now`, { method: 'POST', body: { statementId } });
export const addCollectionNote = (
  clientId: string,
  body: { kind: CollectionNoteKind; note: string; statementId?: string | null; promisedOn?: string | null; promisedAmount?: number | null },
) => apiFetch<{ note: CollectionNote }>(`/clients/${clientId}/collection-notes`, { method: 'POST', body });
