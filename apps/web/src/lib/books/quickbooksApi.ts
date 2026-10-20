import type {
  QboAccountOption,
  QboConflictRow,
  QboLinkSummary,
  QboMappingRow,
  QboOutboxRow,
  QboSyncEventRow,
  QboSyncRunResult,
  QboSyncSettings,
  QboSyncStatus,
} from '@alto-people/shared';
import { apiFetch } from '@/lib/api';

/** The company QuickBooks, kept in step both ways — contract in packages/shared/src/books/quickbooks.ts. */

const B = '/books/quickbooks';

export const QBO_KEY = ['books', 'quickbooks'] as const;

export const getQboStatus = () => apiFetch<QboSyncStatus>(`${B}/status`);
export const startQboConnect = () => apiFetch<{ authorizeUrl: string }>(`${B}/connect`);
export const disconnectQbo = () => apiFetch<{ ok: true }>(`${B}/disconnect`, { method: 'POST' });
export const pauseQbo = () => apiFetch<{ ok: true }>(`${B}/pause`, { method: 'POST' });
export const resumeQbo = () => apiFetch<{ ok: true }>(`${B}/resume`, { method: 'POST' });
export const syncQboNow = () => apiFetch<QboSyncRunResult>(`${B}/sync-now`, { method: 'POST' });
export const relinkQboCharts = () => apiFetch<QboLinkSummary>(`${B}/link`, { method: 'POST' });
export const importQboHistory = (since: string) => apiFetch<QboSyncRunResult['pulled']>(`${B}/import-history`, { method: 'POST', body: { since } });

export const listQboOutbox = (status?: QboOutboxRow['status']) => apiFetch<{ rows: QboOutboxRow[] }>(`${B}/outbox${status ? `?status=${status}` : ''}`);
export const retryQboOutbox = (id: string) => apiFetch<{ ok: true }>(`${B}/outbox/${id}/retry`, { method: 'POST' });
export const retryQboFailed = () => apiFetch<{ retried: number }>(`${B}/outbox/retry-failed`, { method: 'POST' });

export const listQboEvents = (opts: { cursor?: string | null; limit?: number; result?: QboSyncEventRow['result'] } = {}) => {
  const p = new URLSearchParams();
  if (opts.cursor) p.set('cursor', opts.cursor);
  if (opts.limit) p.set('limit', String(opts.limit));
  if (opts.result) p.set('result', opts.result);
  const qs = p.toString();
  return apiFetch<{ events: QboSyncEventRow[]; nextCursor: string | null }>(`${B}/events${qs ? `?${qs}` : ''}`);
};

export const listQboConflicts = (status: QboConflictRow['status'] | 'ALL' = 'OPEN') => apiFetch<{ conflicts: QboConflictRow[] }>(`${B}/conflicts?status=${status}`);
export const resolveQboConflict = (id: string, keep: 'SITE' | 'QUICKBOOKS' | 'DISMISS') => apiFetch<QboConflictRow>(`${B}/conflicts/${id}/resolve`, { method: 'POST', body: { keep } });

export type QboMappingKind = 'accounts' | 'vendors' | 'customers';
export const listQboMappings = (kind: QboMappingKind) => apiFetch<{ rows: QboMappingRow[] }>(`${B}/mappings?kind=${kind}`);
export const listQboAccounts = () => apiFetch<{ accounts: QboAccountOption[] }>(`${B}/qbo-accounts`);
export const relinkQboAccount = (accountId: string, qboId: string) => apiFetch<{ ok: true }>(`${B}/mappings/accounts/${accountId}`, { method: 'PUT', body: { qboId } });

export const saveQboSettings = (s: Partial<QboSyncSettings>) => apiFetch<QboSyncSettings>(`${B}/settings`, { method: 'PUT', body: s });
