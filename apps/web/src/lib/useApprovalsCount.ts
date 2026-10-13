import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './api';
import { useAuth } from './auth';
import { onLiveEvent } from './liveEvents';

interface ApprovalsCount {
  swaps: number;
  pickups: number;
  timeOff: number;
  timesheets: number;
  /** Walk-in clock-ins parked by the kiosk schedule gate. */
  clockIns: number;
  total: number;
}

const POLL_MS = 60_000;
const KEY = ['approvals', 'count'] as const;

/**
 * Pending-approvals total for the nav badge. Fetches only for users who
 * can manage scheduling (everyone else gets null and no request), then
 * refreshes every minute while the tab is visible and on tab refocus —
 * same cadence family as the notifications bell. A failed refresh keeps
 * the last known value on screen (the query layer retains data through an
 * error): a nav badge must never surface an error state, and a
 * wrong-but-stale count beats a flickering one.
 */
export function useApprovalsCount(): number | null {
  const { can } = useAuth();
  const allowed = can('manage:scheduling');
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: KEY,
    queryFn: () => apiFetch<ApprovalsCount>('/approvals/count'),
    enabled: allowed,
    // Polls pause while the tab is hidden (refetchIntervalInBackground is
    // off by default); the SSE nudge and the focus refetch cover "something
    // changed while I was away".
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
    retry: false,
    select: (res) => res.total,
  });

  // New pending items notify admins in-app, so the same live nudge that
  // refreshes the bell also refreshes this count instantly.
  useEffect(() => {
    if (!allowed) return;
    return onLiveEvent('notification', () => {
      void queryClient.invalidateQueries({ queryKey: KEY });
    });
  }, [allowed, queryClient]);

  return allowed ? (query.data ?? null) : null;
}
