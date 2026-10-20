import type {
  BankAccountCreateInput,
  BankAccountUpdateInput,
  BankCategorizeInput,
  BankCsvMapping,
  BankFeedAccountView,
  BankImportPreview,
  BankImportResult,
  BankLedgerAccountOption,
  BankPlaidAccount,
  BankPlaidStatus,
  BankReconciliationDetail,
  BankReconciliationSummary,
  BankRuleInput,
  BankRuleView,
  BankTxnCounts,
  BankTxnStatus,
  BankTxnSuggestions,
  BankTxnView,
} from '@alto-people/shared';
import { apiFetch } from '@/lib/api';

/** The books' bank and card accounts — the contract in packages/shared/src/books/bank.ts. */

const B = '/books/bank';
export const BANK_KEY = ['books', 'bank'] as const;

export const listLedgerAccountOptions = () => apiFetch<{ accounts: BankLedgerAccountOption[] }>(`${B}/ledger-accounts`);
export const listBankAccounts = () => apiFetch<{ accounts: BankFeedAccountView[] }>(`${B}/accounts`);
export const getBankAccount = (id: string) => apiFetch<{ account: BankFeedAccountView }>(`${B}/accounts/${id}`);
export const createBankAccount = (body: BankAccountCreateInput) => apiFetch<{ account: BankFeedAccountView }>(`${B}/accounts`, { method: 'POST', body });
export const updateBankAccount = (id: string, body: BankAccountUpdateInput) => apiFetch<{ account: BankFeedAccountView }>(`${B}/accounts/${id}`, { method: 'PATCH', body });

export function listBankTransactions(id: string, q: { status?: BankTxnStatus; q?: string } = {}) {
  const p = new URLSearchParams();
  if (q.status) p.set('status', q.status);
  if (q.q) p.set('q', q.q);
  const qs = p.toString();
  return apiFetch<{ transactions: BankTxnView[]; counts: BankTxnCounts }>(`${B}/accounts/${id}/transactions${qs ? `?${qs}` : ''}`);
}

export const previewBankImport = (id: string, body: { filename: string; content: string; mapping?: BankCsvMapping }) =>
  apiFetch<BankImportPreview>(`${B}/accounts/${id}/import/preview`, { method: 'POST', body, timeoutMs: 60_000 });
export const importBankFile = (id: string, body: { filename: string; content: string; mapping?: BankCsvMapping }) =>
  apiFetch<BankImportResult>(`${B}/accounts/${id}/import`, { method: 'POST', body, timeoutMs: 120_000 });
export const syncBankAccount = (id: string) => apiFetch<BankImportResult>(`${B}/accounts/${id}/sync`, { method: 'POST', timeoutMs: 120_000 });

export const getTxnSuggestions = (id: string) => apiFetch<BankTxnSuggestions>(`${B}/transactions/${id}/suggestions`);
export const categorizeTxn = (id: string, body: BankCategorizeInput) => apiFetch<{ transaction: BankTxnView }>(`${B}/transactions/${id}/categorize`, { method: 'POST', body });
export const matchTxn = (id: string, lineId: string) => apiFetch<{ transaction: BankTxnView }>(`${B}/transactions/${id}/match`, { method: 'POST', body: { lineId } });
export const excludeTxn = (id: string) => apiFetch<{ transaction: BankTxnView }>(`${B}/transactions/${id}/exclude`, { method: 'POST' });
export const undoTxn = (id: string) => apiFetch<{ transaction: BankTxnView }>(`${B}/transactions/${id}/undo`, { method: 'POST' });

export const listBankRules = () => apiFetch<{ rules: BankRuleView[] }>(`${B}/rules`);
export const createBankRule = (body: BankRuleInput) => apiFetch<{ rule: BankRuleView }>(`${B}/rules`, { method: 'POST', body });
export const updateBankRule = (id: string, body: Partial<BankRuleInput>) => apiFetch<{ rule: BankRuleView }>(`${B}/rules/${id}`, { method: 'PATCH', body });
export const deleteBankRule = (id: string) => apiFetch<void>(`${B}/rules/${id}`, { method: 'DELETE' });
export const applyBankRules = (feedAccountId?: string) => apiFetch<{ categorized: number }>(`${B}/rules/apply`, { method: 'POST', body: feedAccountId ? { feedAccountId } : {} });

export const getPlaidStatus = () => apiFetch<BankPlaidStatus>(`${B}/plaid/status`);
export const createPlaidLinkToken = () => apiFetch<{ linkToken: string }>(`${B}/plaid/link-token`, { method: 'POST' });
export const exchangePlaidToken = (publicToken: string) => apiFetch<{ itemId: string; accounts: BankPlaidAccount[] }>(`${B}/plaid/exchange`, { method: 'POST', body: { publicToken } });

export const listReconciliations = (id: string) => apiFetch<{ reconciliations: BankReconciliationSummary[] }>(`${B}/accounts/${id}/reconciliations`);
export const startReconciliation = (id: string, body: { statementEndDate: string; statementBalance: number }) =>
  apiFetch<BankReconciliationDetail>(`${B}/accounts/${id}/reconciliations`, { method: 'POST', body });
export const getReconciliation = (id: string) => apiFetch<BankReconciliationDetail>(`${B}/reconciliations/${id}`);
export const tickReconciliation = (id: string, lineIds: string[], cleared: boolean) =>
  apiFetch<BankReconciliationDetail>(`${B}/reconciliations/${id}/tick`, { method: 'POST', body: { lineIds, cleared } });
export const completeReconciliation = (id: string) => apiFetch<BankReconciliationDetail>(`${B}/reconciliations/${id}/complete`, { method: 'POST' });
export const undoReconciliation = (id: string) => apiFetch<BankReconciliationDetail>(`${B}/reconciliations/${id}/undo`, { method: 'POST' });
export const reconciliationReportUrl = (id: string) => `/api${B}/reconciliations/${id}/report.xlsx`;

/** Read a picked statement file as text (CSV, OFX and QFX are all text). */
export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ''));
    r.onerror = () => reject(new Error('Could not read the file.'));
    r.readAsText(file);
  });
}

/**
 * Plaid Link, loaded only when someone connects a bank. Resolves with the
 * public token, or null when they close it.
 */
export async function openPlaidLink(linkToken: string): Promise<string | null> {
  type PlaidHandler = { open: () => void; destroy: () => void };
  type PlaidGlobal = { create: (cfg: { token: string; onSuccess: (publicToken: string) => void; onExit: () => void }) => PlaidHandler };
  const w = window as unknown as { Plaid?: PlaidGlobal };
  if (!w.Plaid) {
    await new Promise<void>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Plaid didn’t load. Check the connection and try again.'));
      document.head.appendChild(s);
    });
  }
  if (!w.Plaid) throw new Error('Plaid didn’t load.');
  return new Promise((resolve) => {
    const handler = w.Plaid!.create({
      token: linkToken,
      onSuccess: (publicToken) => {
        handler.destroy();
        resolve(publicToken);
      },
      onExit: () => {
        handler.destroy();
        resolve(null);
      },
    });
    handler.open();
  });
}
