import type {
  DirectoryListResponse,
  DirectoryStatus,
} from '@alto-people/shared';
import { apiFetch } from './api';

export interface DirectoryFilters {
  q?: string;
  status?: DirectoryStatus;
  clientId?: string;
  employmentType?:
    | 'W2_EMPLOYEE'
    | 'CONTRACTOR_1099_INDIVIDUAL'
    | 'CONTRACTOR_1099_BUSINESS';
}

export function listDirectory(
  filters: DirectoryFilters = {},
): Promise<DirectoryListResponse> {
  const p = new URLSearchParams();
  if (filters.q) p.set('q', filters.q);
  if (filters.status) p.set('status', filters.status);
  if (filters.clientId) p.set('clientId', filters.clientId);
  if (filters.employmentType) p.set('employmentType', filters.employmentType);
  const qs = p.toString();
  return apiFetch<DirectoryListResponse>(`/people/directory${qs ? `?${qs}` : ''}`);
}
