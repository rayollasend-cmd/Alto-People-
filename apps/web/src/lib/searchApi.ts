import type { SearchResponse } from '@alto-people/shared';
import { apiFetch } from './api';

/** One query, every record kind the caller may see, grouped. */
export function universalSearch(q: string, limit = 5): Promise<SearchResponse> {
  return apiFetch<SearchResponse>(`/search?q=${encodeURIComponent(q)}&limit=${limit}`);
}
