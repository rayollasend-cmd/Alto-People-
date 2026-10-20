import type {
  AccrualCreateInput,
  BudgetCreateInput,
  BudgetDetail,
  BudgetLinesInput,
  BudgetListResponse,
  BudgetUpdateInput,
  BudgetVsActual,
  CloseAccrualsResponse,
  CloseListResponse,
  ClosePeriodDetail,
  CloseTaskUpdateInput,
  DepreciationRunResult,
  FixedAssetCreateInput,
  FixedAssetDetail,
  FixedAssetDisposeInput,
  FixedAssetListResponse,
  FixedAssetUpdateInput,
} from '@alto-people/shared';
import { apiFetch } from '../api';

/**
 * The books — the month-end close, budgets and fixed assets
 * (packages/shared/src/books/close.ts lists every endpoint).
 */

/* ---- Close ---------------------------------------------------------------- */

export const listCloseMonths = () => apiFetch<CloseListResponse>('/books/close');
export const getCloseMonth = (periodKey: string) => apiFetch<ClosePeriodDetail>(`/books/close/${periodKey}`);
export const updateCloseTask = (periodKey: string, key: string, body: CloseTaskUpdateInput) =>
  apiFetch<ClosePeriodDetail>(`/books/close/${periodKey}/tasks/${key}`, { method: 'POST', body });
export const markCloseReady = (periodKey: string) => apiFetch<ClosePeriodDetail>(`/books/close/${periodKey}/ready`, { method: 'POST' });
export const unmarkCloseReady = (periodKey: string) => apiFetch<ClosePeriodDetail>(`/books/close/${periodKey}/unready`, { method: 'POST' });
export const signOffClose = (periodKey: string) => apiFetch<ClosePeriodDetail>(`/books/close/${periodKey}/sign-off`, { method: 'POST' });
export const requestCloseReopen = (periodKey: string, reason: string) =>
  apiFetch<{ pending: true; approvalId: string; title: string }>(`/books/close/${periodKey}/reopen`, { method: 'POST', body: { reason } });
export const listAccruals = (periodKey: string) => apiFetch<CloseAccrualsResponse>(`/books/close/${periodKey}/accruals`);
export const createAccrual = (body: AccrualCreateInput) => apiFetch<{ entryId: string }>('/books/close/accruals', { method: 'POST', body });

/* ---- Budgets -------------------------------------------------------------- */

export const listBudgets = () => apiFetch<BudgetListResponse>('/books/budgets');
export const getBudget = (id: string) => apiFetch<{ budget: BudgetDetail }>(`/books/budgets/${id}`);
export const createBudget = (body: BudgetCreateInput) => apiFetch<{ budget: BudgetDetail }>('/books/budgets', { method: 'POST', body });
export const updateBudget = (id: string, body: BudgetUpdateInput) =>
  apiFetch<{ budget: BudgetDetail; demoted: string | null }>(`/books/budgets/${id}`, { method: 'PATCH', body });
export const deleteBudget = (id: string) => apiFetch<void>(`/books/budgets/${id}`, { method: 'DELETE' });
export const saveBudgetLines = (id: string, body: BudgetLinesInput) => apiFetch<{ budget: BudgetDetail }>(`/books/budgets/${id}/lines`, { method: 'PUT', body });
export const budgetFromActuals = (id: string, growthPct: number) =>
  apiFetch<{ budget: BudgetDetail }>(`/books/budgets/${id}/from-actuals`, { method: 'POST', body: { growthPct } });
export const getBudgetVsActual = (id: string, through?: string) =>
  apiFetch<BudgetVsActual>(`/books/budgets/${id}/vs-actual${through ? `?through=${through}` : ''}`);
export const budgetVsActualXlsxUrl = (id: string, through?: string) => `/api/books/budgets/${id}/vs-actual.xlsx${through ? `?through=${through}` : ''}`;

/* ---- Fixed assets --------------------------------------------------------- */

export const listFixedAssets = () => apiFetch<FixedAssetListResponse>('/books/assets');
export const getFixedAsset = (id: string) => apiFetch<{ asset: FixedAssetDetail }>(`/books/assets/${id}`);
export const createFixedAsset = (body: FixedAssetCreateInput) => apiFetch<{ asset: FixedAssetDetail }>('/books/assets', { method: 'POST', body });
export const updateFixedAsset = (id: string, body: FixedAssetUpdateInput) => apiFetch<{ asset: FixedAssetDetail }>(`/books/assets/${id}`, { method: 'PATCH', body });
export const disposeFixedAsset = (id: string, body: FixedAssetDisposeInput) =>
  apiFetch<{ asset: FixedAssetDetail }>(`/books/assets/${id}/dispose`, { method: 'POST', body });
export const runDepreciation = (through?: string) =>
  apiFetch<DepreciationRunResult>(`/books/assets/depreciation/run${through ? `?through=${through}` : ''}`, { method: 'POST' });

/** Ledger accounts for pickers (the ledger area's /books/accounts list). */
export interface BooksAccountOption {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype: string;
  systemKey?: string | null;
  isActive?: boolean;
}
export const listAccountOptions = () => apiFetch<{ accounts: BooksAccountOption[] }>('/books/accounts');
