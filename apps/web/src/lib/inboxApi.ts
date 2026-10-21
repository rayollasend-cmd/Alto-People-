import { useQuery } from '@tanstack/react-query';
import type { InboxResponse } from '@alto-people/shared';
import { apiFetch } from './api';

/**
 * The Inbox: every decision waiting on the signed-in person, across
 * modules, as counts with deep links. The API already filters to the
 * sources this person may see (capability, tenant module, client scope),
 * so the page renders what comes back and nothing else.
 */
export function getInbox(): Promise<InboxResponse> {
  return apiFetch<InboxResponse>('/me/inbox');
}

export const INBOX_QUERY_KEY = ['inbox'] as const;

export function useInbox() {
  return useQuery({
    queryKey: INBOX_QUERY_KEY,
    queryFn: getInbox,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}

/**
 * A queue's link from the Inbox: it carries `from=inbox` and the queue's key
 * so the page it opens shows the slim "Back to inbox" bar (InboxReturnBar),
 * and offers the next queue once this one is empty.
 */
export function inboxLink(path: string, key: string): string {
  const [beforeHash, hash] = path.split('#', 2) as [string, string | undefined];
  const sep = beforeHash.includes('?') ? '&' : '?';
  return `${beforeHash}${sep}from=inbox&inbox=${encodeURIComponent(key)}${hash !== undefined ? `#${hash}` : ''}`;
}
