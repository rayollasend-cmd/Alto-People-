import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

/**
 * The role's decision queue (`GET /me/decisions`) as ONE query, shared by
 * the queue that lists it (components/RoleDecisionQueue) and the home that
 * counts it (HomeTemplate's "Needs you"), so the number beside the heading
 * and the rows under it come from the same answer.
 *
 * The cache holds the API's own shape, `{ decisions: [...] }`. Read it with
 * `decisionsOf()` so a reader never cares which component fetched first.
 */
export interface MeDecisionLite {
  key: string;
}

export type MeDecisionsResponse<T extends MeDecisionLite = MeDecisionLite> = { decisions: T[] };

export const ME_DECISIONS_KEY = ['me', 'decisions'] as const;

export function meDecisionsQuery<T extends MeDecisionLite = MeDecisionLite>() {
  return {
    queryKey: ME_DECISIONS_KEY,
    queryFn: () => apiFetch<MeDecisionsResponse<T>>('/me/decisions'),
    staleTime: 30_000,
  };
}

/** The rows, whatever shape the cache holds them in (the response, or a bare list). */
export function decisionsOf<T extends MeDecisionLite = MeDecisionLite>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  const rows = (data as { decisions?: unknown } | null | undefined)?.decisions;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

/**
 * "Needs you", counted the way it is shown: the queue's rows plus the
 * page's own cards, each thing once. `cardKeys` names the page's cards in
 * the queue's key space where a card and a queue row are the same item
 * (the supervisor's coverage gap is both), so it counts once. Cards with
 * no queue twin count as `cards` (a number) or by their keys.
 *
 * `queue: false` (a home without the role queue) counts the cards alone.
 * Undefined while the queue is still loading — no number beats a wrong one.
 */
export function countNeedsYou(args: { queueKeys: readonly string[] | null; cards?: number; cardKeys?: readonly string[] }): number | undefined {
  const cardKeys = args.cardKeys ?? [];
  if (args.queueKeys === null) return undefined;
  const seen = new Set(args.queueKeys);
  let n = seen.size;
  for (const k of cardKeys) {
    if (!seen.has(k)) {
      seen.add(k);
      n += 1;
    }
  }
  return n + (args.cards ?? 0);
}

export function useNeedsYouCount({ queue = true, cards, cardKeys }: { queue?: boolean; cards?: number; cardKeys?: readonly string[] }): number | undefined {
  const q = useQuery({ ...meDecisionsQuery(), enabled: queue });
  if (!queue) return countNeedsYou({ queueKeys: [], cards, cardKeys });
  if (q.isError) return countNeedsYou({ queueKeys: [], cards, cardKeys });
  return countNeedsYou({ queueKeys: q.data === undefined ? null : decisionsOf(q.data).map((d) => d.key), cards, cardKeys });
}
