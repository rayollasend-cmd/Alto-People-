import { useAuth } from './auth';
import { useInbox } from './inboxApi';
import { inboxCountFor } from './inboxCounts';

/**
 * What waits on the Approvals page, for a nav badge (the phone tab bar, the
 * scheduling header's link). It is the Approvals page's inbox count — the
 * count rule in lib/inboxApi.ts — so the tab, the sidebar row and the
 * page's own "N waiting" are one number. It used to read /approvals/count,
 * whose total also held the timesheets (31 on the admin's tab over a page
 * whose sidebar badge said 1). Timesheets are counted on Time & attendance.
 *
 * Null for people who do not work the scheduling desk (no request), and
 * while the inbox loads. The inbox refreshes every minute and on the live
 * nudge (Layout invalidates it), and a failed refresh keeps the last value.
 */
export function useApprovalsCount(): number | null {
  const { can } = useAuth();
  const allowed = can('manage:scheduling');
  // The one inbox request every nav surface already shares — no request of its own.
  const data = useInbox().data;
  return allowed ? inboxCountFor(data, '/approvals') : null;
}
