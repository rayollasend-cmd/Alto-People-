import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MoveRideInput, MoveRideResult, RideShareLink, TransportOpsBoard, TransportReadiness } from '@alto-people/shared';
import { apiFetch } from './api';

/**
 * The transport upgrade's data (2026-10-28): the dispatcher's live operations,
 * tomorrow's readiness, moving a rider between runs, and the rider's share
 * link. Shapes: packages/shared/src/transportOps.ts. The rest of transport is
 * lib/transportApi.ts.
 */

export const transportOpsKeys = {
  ops: (date: string | null) => ['transport', 'ops', date ?? 'today'] as const,
  readiness: (date: string | null) => ['transport', 'readiness', date ?? 'tomorrow'] as const,
};

/** The live board polls every 20 s while it is on screen (a van moves a block in that time). */
export function useTransportOps(date: string | null, opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: transportOpsKeys.ops(date),
    queryFn: () => apiFetch<TransportOpsBoard>(`/transport/ops${date ? `?date=${date}` : ''}`),
    refetchInterval: 20_000,
    enabled: opts.enabled ?? true,
  });
}

/** Tomorrow by default; any day with ?date=. */
export function useTransportReadiness(date: string | null, opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: transportOpsKeys.readiness(date),
    queryFn: () => apiFetch<TransportReadiness>(`/transport/readiness${date ? `?date=${date}` : ''}`),
    staleTime: 30_000,
    enabled: opts.enabled ?? true,
  });
}

/** Move a rider onto another run (or off every run); refreshes the board, ops and readiness. */
export function useMoveRide() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ rideId, ...input }: MoveRideInput & { rideId: string }) =>
      apiFetch<MoveRideResult>(`/transport/rides/${rideId}/move`, { method: 'POST', body: input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['transport'] });
    },
  });
}

/** The rider's link to text someone: the van and the ETA, nothing else. */
export const shareMyRide = (rideId: string) => apiFetch<RideShareLink>(`/transport/me/rides/${rideId}/share`, { method: 'POST' });
