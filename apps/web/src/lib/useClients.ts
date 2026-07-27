import { useQuery } from '@tanstack/react-query';
import type { ClientSummary } from '@alto-people/shared';
import { listClients } from '@/lib/clientsApi';

/**
 * The one way to read the client list in page components.
 *
 * PERF: `listClients()` had ~28 call sites and only 4 shared the cached
 * react-query key — every other page refetched the full list on every
 * mount (AdminTimeView fetched it twice in one view via two dialogs).
 * This hook pins everyone to the same key + a 5-minute staleTime, so
 * re-opening a picker or switching tabs is instant and free.
 *
 * The client list changes ~never during a session; mutations that add a
 * client can `queryClient.invalidateQueries({ queryKey: ['clients'] })`.
 */
export function useClients(options?: { enabled?: boolean }) {
  const query = useQuery({
    queryKey: ['clients', 'list'],
    queryFn: () => listClients({ status: 'ACTIVE' }),
    staleTime: 5 * 60_000,
    enabled: options?.enabled ?? true,
  });
  return {
    clients: (query.data?.clients ?? []) as ClientSummary[],
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
  };
}
