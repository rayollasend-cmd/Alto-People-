import type {
  DirectoryListResponse,
  DirectoryStatus,
} from '@alto-people/shared';
import { infiniteQueryOptions } from '@tanstack/react-query';
import { apiFetch } from './api';

export interface DirectoryFilters {
  q?: string;
  status?: DirectoryStatus;
  clientId?: string;
  departmentId?: string;
  locationId?: string;
  /** Server caps at 500 (and defaults to it); pass a small value for
   *  typeahead consumers so a two-letter prefix doesn't pull a full page. */
  limit?: number;
  /** Opaque id of the last row of the previous page — see nextCursor. */
  cursor?: string;
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
  if (filters.departmentId) p.set('departmentId', filters.departmentId);
  if (filters.locationId) p.set('locationId', filters.locationId);
  if (filters.employmentType) p.set('employmentType', filters.employmentType);
  if (filters.limit) p.set('limit', String(filters.limit));
  const qs = p.toString();
  return apiFetch<DirectoryListResponse>(`/people/directory${qs ? `?${qs}` : ''}`);
}

/**
 * The People directory's query — key, fetch and page shape in one place.
 *
 * The page reads it as an infinite query ({ pages, pageParams }). The
 * People link's hover-prefetch used to write the same key as a bare array
 * of associates, so anyone who hovered the link and then opened the page
 * crashed ("Cannot read properties of undefined (reading 'length')") —
 * and the persisted cache replayed the crash on every reload. Both now
 * build the query from here, so they can't drift apart again.
 */
export function directoryQuery(filters: DirectoryFilters) {
  return infiniteQueryOptions({
    queryKey: ['directory', filters] as const,
    queryFn: ({ pageParam }) =>
      listDirectory({ ...filters, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: DirectoryListResponse) => last.nextCursor ?? undefined,
  });
}
