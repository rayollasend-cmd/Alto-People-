import type {
  BooksBalanceSheet,
  BooksCashFlow,
  BooksCompareKind,
  BooksDimensions,
  BooksDimensionsFilter,
  BooksJournalEntryDetail,
  BooksJournalList,
  BooksManualEntryInput,
  BooksOpeningBalancesInput,
  BooksOverview,
  BooksProfitAndLoss,
  BooksTrialBalance,
  LedgerAccountCreateInput,
  LedgerAccountDetail,
  LedgerAccountRow,
  LedgerAccountUpdateInput,
} from '@alto-people/shared';
import { apiFetch } from '@/lib/api';

/** The ledger, the statements and the Books overview (packages/shared/src/books/ledger.ts). */

const B = '/books';

function qs(params: Record<string, string | number | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

export const getBooksOverview = () => apiFetch<BooksOverview>(`${B}/overview`);
export const getBooksDimensions = () => apiFetch<BooksDimensions>(`${B}/dimensions`);

export const listLedgerAccounts = (asOf?: string) => apiFetch<{ accounts: LedgerAccountRow[] }>(`${B}/accounts${qs({ asOf })}`);
export const createLedgerAccount = (body: LedgerAccountCreateInput) => apiFetch<{ account: LedgerAccountRow }>(`${B}/accounts`, { method: 'POST', body });
export const updateLedgerAccount = (id: string, body: LedgerAccountUpdateInput) => apiFetch<{ account: LedgerAccountRow }>(`${B}/accounts/${id}`, { method: 'PATCH', body });
export const deleteLedgerAccount = (id: string) => apiFetch<void>(`${B}/accounts/${id}`, { method: 'DELETE' });
export const getAccountDetail = (id: string, range: { from: string; to: string } & BooksDimensionsFilter) => apiFetch<LedgerAccountDetail>(`${B}/accounts/${id}/detail${qs(range)}`);

export interface JournalFilters {
  from?: string;
  to?: string;
  source?: string;
  origin?: 'SITE' | 'QUICKBOOKS';
  status?: 'POSTED' | 'VOID';
  accountId?: string;
  q?: string;
  /** The server orders the whole filtered set; default newest first. */
  sort?: 'date' | 'number' | 'amount';
  dir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}
export const listJournal = (f: JournalFilters = {}) => apiFetch<BooksJournalList>(`${B}/journal${qs({ ...f })}`);
/** Every entry the filters match (not just the page on screen), as CSV. */
export const downloadJournalCsv = (f: Omit<JournalFilters, 'limit' | 'offset'> = {}) => downloadFile(`${B}/journal.csv${qs({ ...f })}`, 'journal.csv');
export const getJournalEntry = (id: string) => apiFetch<{ entry: BooksJournalEntryDetail }>(`${B}/journal/${id}`);
export const postManualEntry = (body: BooksManualEntryInput) => apiFetch<{ entry: { id: string; number: number } }>(`${B}/journal`, { method: 'POST', body });
export const voidJournalEntry = (id: string, reason: string) => apiFetch<{ voided: boolean; reversalId: string | null }>(`${B}/journal/${id}/void`, { method: 'POST', body: { reason } });
export const getOpeningBalances = () => apiFetch<{ date: string | null; lines: Array<{ accountId: string; amount: number }> }>(`${B}/opening-balances`);
export const postOpeningBalances = (body: BooksOpeningBalancesInput) => apiFetch<{ entry: { id: string; number: number } }>(`${B}/opening-balances`, { method: 'POST', body });

export type ReportKind = 'profit-and-loss' | 'balance-sheet' | 'cash-flow' | 'trial-balance';
export interface ReportParams extends BooksDimensionsFilter {
  from?: string;
  to?: string;
  asOf?: string;
  columns?: 'none' | 'month' | 'client';
  /** Beside the statement: the same one for the period (prior) or year (yoy) before. */
  compare?: BooksCompareKind;
}
export const getProfitAndLoss = (p: ReportParams) => apiFetch<BooksProfitAndLoss>(`${B}/reports/profit-and-loss${qs({ ...p })}`);
export const getBalanceSheet = (p: ReportParams) => apiFetch<BooksBalanceSheet>(`${B}/reports/balance-sheet${qs({ ...p })}`);
export const getCashFlow = (p: ReportParams) => apiFetch<BooksCashFlow>(`${B}/reports/cash-flow${qs({ ...p })}`);
export const getTrialBalance = (p: ReportParams) => apiFetch<BooksTrialBalance>(`${B}/reports/trial-balance${qs({ ...p })}`);

/** Download a statement as a PDF or a workbook. */
export async function downloadReport(kind: ReportKind, format: 'pdf' | 'xlsx', p: ReportParams): Promise<void> {
  const { compare: _compare, ...rest } = p;
  return downloadFile(`${B}/reports/${kind}.${format}${qs({ ...rest })}`, `${kind}.${format}`);
}

/** Fetch a file the API sends as an attachment and hand it to the browser. */
async function downloadFile(path: string, fallbackName: string): Promise<void> {
  const res = await fetch(`/api${path}`, { credentials: 'include' });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error?.message ?? 'The download failed.');
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const m = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '');
  const a = document.createElement('a');
  a.href = url;
  a.download = m?.[1] ?? fallbackName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
