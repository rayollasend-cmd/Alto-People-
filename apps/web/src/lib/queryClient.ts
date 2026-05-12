import { QueryClient } from '@tanstack/react-query';

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
 * only once instead of three times.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});
