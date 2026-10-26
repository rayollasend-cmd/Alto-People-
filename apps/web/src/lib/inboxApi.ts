import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { InboxResponse } from '@alto-people/shared';
import { apiFetch } from './api';
import { INBOX_QUERY_KEY, inboxCountFor, navBadgeFor } from './inboxCounts';

export { INBOX_QUERY_KEY, NOT_A_QUEUE, inboxCountFor, inboxHomePath, inboxPagesOf, navBadgeFor } from './inboxCounts';

/**
 * The Inbox: every decision waiting on the signed-in person, across
 * modules, as counts with deep links. The API already filters to the
 * sources this person may see (capability, tenant module, client scope),
 * so the page renders what comes back and nothing else.
 *
 * The numbers it carries follow ONE rule — read it in lib/inboxCounts.ts
 * ("THE COUNT RULE"): a page's badge and its header's "N waiting" are the
 * same number, a door counts each queue once, the Inbox row is the total,
 * and the bell counts notices, never queues.
 */
export function getInbox(): Promise<InboxResponse> {
  return apiFetch<InboxResponse>('/me/inbox');
}


export function useInbox() {
  return useQuery({
    queryKey: INBOX_QUERY_KEY,
    queryFn: getInbox,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}

/** The rail's and the phone drawer's badges, from the one inbox request. */
export function useNavBadges(): (rows: { key: string; path: string } | ReadonlyArray<{ key: string; path: string }>) => number | null {
  const data = useInbox().data;
  return useCallback((rows: { key: string; path: string } | ReadonlyArray<{ key: string; path: string }>) => navBadgeFor(data, rows), [data]);
}

/** The page header's "N waiting" — the same number as the page's sidebar badge. */
export function useInboxCount(pages: string | readonly string[], enabled = true): number | null {
  const q = useQuery({
    queryKey: INBOX_QUERY_KEY,
    queryFn: getInbox,
    refetchInterval: 60_000,
    staleTime: 30_000,
    enabled,
  });
  return enabled ? inboxCountFor(q.data, pages) : null;
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
