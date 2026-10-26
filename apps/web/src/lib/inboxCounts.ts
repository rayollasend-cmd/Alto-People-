import { QUEUE_REGISTRY, type InboxSource } from '@alto-people/shared';

/**
 * The inbox's numbers, as pure functions — kept apart from the hooks in
 * lib/inboxApi.ts so any screen (and any test that stubs the request) reads
 * the one rule.
 *
 * ── THE COUNT RULE (F500 audit 2026-10-26, "counts disagree") ──────────────
 * Every "waiting" number on a staff screen comes from this ONE response, and
 * each kind of number has ONE meaning:
 *
 *   · An inbox SOURCE (a queue) is listed on its home page — its `path`
 *     without the query or hash (`/time-attendance?tab=queue` →
 *     `/time-attendance`) — and, when the queue registry gives it an
 *     Approvals tab (packages/shared queues.ts `approvalsTab`), on
 *     `/approvals` too, where the same items are worked.
 *   · A PAGE's count — the badge beside its row in the sidebar and the
 *     "N waiting" in that page's header — is the sum of the sources listed on
 *     that page, the person's OWN queues only (`watching` sources, another
 *     desk's queue, never count). `inboxCountFor(data, '/approvals')`.
 *   · A DOOR's badge (Time & scheduling, Pay & finance…) is what waits behind
 *     it: the sources listed on any of its pages, EACH QUEUE ONCE — the 31
 *     timesheets on both Approvals and Time & attendance count 31, not 62.
 *     `inboxCountFor(data, [...the door's pages])`.
 *   · The INBOX row's badge is `total`: every owned source once, so it is ≥
 *     any door.
 *   · The bell is a different thing — NOTICES, not queues — and its badge is
 *     only the new notices that ask something of you, capped at "9+"
 *     (components/NotificationsBell bellBadge). The inbox's own "unread
 *     notices" source is listed but never counted (NOT_A_QUEUE).
 *   · A home's "Needs you N" counts the rows listed under it, nothing else.
 *
 * Tests: __tests__/lib/inboxCounts.test.ts pins this arithmetic; the API's
 * inbox tests pin that each source's count equals its list.
 */

/** The inbox query's cache key — the bell's live nudge and the Approvals page re-read it. */
export const INBOX_QUERY_KEY = ['inbox'] as const;

/** A source's home page: its path without the query string or hash. */
export function inboxHomePath(path: string): string {
  return path.split(/[?#]/, 1)[0] ?? path;
}

type CountedSource = Pick<InboxSource, 'key' | 'path' | 'count' | 'watching'>;

/**
 * Listed, never counted: the unread-notices source is the bell's number, so
 * no page, door or Inbox badge counts it again (the API's `total` skips it
 * too — routes/inbox.ts NOT_A_QUEUE).
 */
export const NOT_A_QUEUE: ReadonlySet<string> = new Set(['my-notifications']);

/** Every page a source is listed on (the count rule): its home, and Approvals when it has a tab there. */
export function inboxPagesOf(s: Pick<InboxSource, 'key' | 'path'>): string[] {
  const home = inboxHomePath(s.path);
  return QUEUE_REGISTRY[s.key]?.approvalsTab && home !== '/approvals' ? [home, '/approvals'] : [home];
}

/**
 * What waits on a page, or on a set of pages (a door): the person's own
 * sources listed on any of them, each source once. Null until the inbox loads.
 */
export function inboxCountFor(data: { sources: readonly CountedSource[] } | null | undefined, pages: string | readonly string[]): number | null {
  if (!data) return null;
  const want = new Set((typeof pages === 'string' ? [pages] : pages).map(inboxHomePath));
  let n = 0;
  for (const s of data.sources) {
    if (s.watching || !s.count || NOT_A_QUEUE.has(s.key)) continue;
    if (inboxPagesOf(s).some((p) => want.has(p))) n += s.count;
  }
  return n;
}

/**
 * The nav's badge for a row (the Inbox row reads `total`, any other row its
 * page's count) or for a door (several rows: what waits behind it, each
 * queue once). Null while the inbox loads, so a badge never flashes a wrong
 * number; 0 means nothing waits.
 */
export function navBadgeFor(
  data: { total: number; sources: readonly CountedSource[] } | null | undefined,
  rows: { key: string; path: string } | ReadonlyArray<{ key: string; path: string }>,
): number | null {
  if (!data) return null;
  const list = Array.isArray(rows) ? (rows as ReadonlyArray<{ key: string; path: string }>) : [rows as { key: string; path: string }];
  if (list.some((r) => r.key === 'inbox')) return data.total;
  return inboxCountFor(data, list.map((r) => r.path));
}

