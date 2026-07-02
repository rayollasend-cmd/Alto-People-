import { useEffect, useState } from 'react';
import { apiFetch } from './api';
import { useAuth } from './auth';

interface ApprovalsCount {
  swaps: number;
  pickups: number;
  timeOff: number;
  timesheets: number;
  total: number;
}

const POLL_MS = 60_000;

/**
 * Pending-approvals total for the nav badge. Fetches only for users who
 * can manage scheduling (everyone else gets null and no request), then
 * refreshes every minute and on tab refocus — same cadence family as the
 * notifications bell. Failures return the last known value; a nav badge
 * must never surface an error state.
 */
export function useApprovalsCount(): number | null {
  const { can } = useAuth();
  const allowed = can('manage:scheduling');
  const [total, setTotal] = useState<number | null>(null);

  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await apiFetch<ApprovalsCount>('/approvals/count');
        if (!cancelled) setTotal(res.total);
      } catch {
        // Keep the previous value — transient failures shouldn't blank
        // the badge, and a wrong-but-stale count beats a flickering one.
      }
    };
    void load();
    const timer = setInterval(load, POLL_MS);
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [allowed]);

  return allowed ? total : null;
}
