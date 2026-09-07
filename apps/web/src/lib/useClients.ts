import { useQuery } from '@tanstack/react-query';
import type { ClientSummary } from '@alto-people/shared';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
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
 * SOURCE BY CAPABILITY: /clients is the accounts admin area
 * (view:clients) and its summary carries fieldglassBillRate — money.
 * Scheduler-tier roles without view:clients (the Workforce Manager)
 * used to 403 there, which rendered every client filter empty
 * (reported 2026-09-06). They now read the operational directory,
 * GET /scheduling/clients: id + name + week anchor, no money.
 *
 * The client list changes ~never during a session; mutations that add a
 * client can `queryClient.invalidateQueries({ queryKey: ['clients'] })`.
 */

interface OperationalClient {
  id: string;
  name: string;
  weekStartsOn: number;
}

export function useClients(options?: { enabled?: boolean }) {
  const { can } = useAuth();
  const fullAccess = can('view:clients');
  const query = useQuery({
    queryKey: ['clients', 'list', fullAccess ? 'full' : 'operational'],
    queryFn: async (): Promise<{ clients: ClientSummary[] }> => {
      if (fullAccess) {
        const r = await listClients({ status: 'ACTIVE' });
        return { clients: r.clients as ClientSummary[] };
      }
      const r = await apiFetch<{ clients: OperationalClient[] }>(
        '/scheduling/clients',
      );
      return {
        clients: r.clients.map((c) => ({
          id: c.id,
          name: c.name,
          industry: null,
          status: 'ACTIVE' as const,
          contactEmail: null,
          state: null,
          weekStartsOn: c.weekStartsOn,
          fieldglassSiteName: null,
          fieldglassBillRate: null,
        })),
      };
    },
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
