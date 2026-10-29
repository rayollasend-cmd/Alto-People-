import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api';

/**
 * One retry for a failure that might pass the second time (a 5xx, a dropped
 * connection, a timeout) — never for a 4xx. A refusal (403), a missing record
 * (404) or a rule the request broke answers the same way twice, so retrying
 * only doubled the requests and held the error state back about a second
 * (deep audit 2026-10-29, CRAWL-14).
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= 1) return false;
  const status = error instanceof ApiError ? error.status : (error as { name?: unknown; status?: unknown } | null)?.name === 'ApiError' ? (error as { status: number }).status : null;
  if (typeof status === 'number' && status >= 400 && status < 500) return false;
  return true;
}

/**
 * Singleton React Query client.
 *
 * Lives outside the React tree so non-component code (hover-prefetch
 * helpers, the shared API layer) can prime the cache before render.
 * The provider in main.tsx still wraps the tree with this same
 * instance.
 *
 * Defaults are tuned for our cold-start-prone Neon Free tier: keep
 * cached data for 5 min, mark fresh for 30 s, don't refetch on window
 * focus (too aggressive when the DB might be suspended), and retry
 * only once instead of three times — and a 4xx not at all (shouldRetryQuery).
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: shouldRetryQuery,
    },
  },
});
