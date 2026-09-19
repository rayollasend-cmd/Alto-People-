import { useQuery } from '@tanstack/react-query';
import { apiFetch } from './api';

/**
 * How many workers are waiting on Fieldglass setup (to add, transfer or
 * close) — the badge on the "Fieldglass setup" menu entry. Only fetched
 * when that entry is in the viewer's nav; every mark on the queue
 * invalidates ['finance', 'fieldglass'], so the badge follows the work.
 * A failure keeps the badge empty — never an error state in the nav.
 */
export function useFieldglassSetupCount(enabled: boolean): number | null {
  const q = useQuery({
    queryKey: ['finance', 'fieldglass', 'count'],
    queryFn: () => apiFetch<{ count: number }>('/finance/fieldglass?view=count'),
    enabled,
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
    retry: false,
  });
  return enabled ? (q.data?.count ?? null) : null;
}
