import { useQuery } from '@tanstack/react-query';
import type { HugoThreadView } from '@alto-people/shared';
import { getHugoProfile, getHugoThread } from '@/lib/hugoApi';

/**
 * The conversation follows the account, not the tab (owner, 2026-10-29).
 * The server keeps it (GET /hugo/thread, the person's last 50 turns, 90
 * days); this tab's session copy is only a first-paint cache, and sign-out
 * clears it (lib/auth clearUserScopedStorage). The persisted query cache
 * never writes it to disk (lib/queryPersist: 'hugoThread' is sensitive —
 * a conversation can be about pay).
 */

export const HUGO_THREAD_KEY = ['hugo', 'hugoThread'] as const;
export const HUGO_PROFILE_KEY = ['hugo', 'profile'] as const;

/** What the panel needs of a turn to line it up with the server's. */
export interface ThreadTurnLike {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  intent?: string;
  linkUrl?: string | null;
  /** When this tab added it (Date.now()); a turn the server sent has none. */
  localAt?: number;
}

/**
 * The server's thread, with what only this tab knows kept:
 *  - a server turn this tab also has keeps its extras (action cards and
 *    their results, tables, offers, a hand-off button) — matched by id;
 *  - a turn this tab added after the server's copy was fetched stays at the
 *    end (a question on its way, an error said) until the server has it;
 *  - anything else is gone: started over on another device, past its time,
 *    or never kept (a session copy from before the conversation moved to the
 *    server).
 */
export function mergeThread<T extends ThreadTurnLike>(server: HugoThreadView, fetchedAt: number, local: readonly T[]): T[] {
  const byId = new Map(local.map((t) => [t.id, t]));
  const ids = new Set(server.turns.map((s) => s.id));
  const fromServer = server.turns.map(
    (s) =>
      ({
        ...(byId.get(s.id) ?? {}),
        id: s.id,
        role: s.role,
        text: s.text,
        intent: s.intent ?? undefined,
        linkUrl: s.linkUrl,
        localAt: undefined,
      }) as T,
  );
  const newer = local.filter((t) => !ids.has(t.id) && (t.localAt ?? 0) > fetchedAt);
  return [...fromServer, ...newer];
}

/** The person's thread from the server, while the panel is open; a focus back on the tab brings another device's turns. */
export function useHugoThread(enabled: boolean) {
  return useQuery({ queryKey: HUGO_THREAD_KEY, queryFn: () => getHugoThread(), enabled, staleTime: 30_000, refetchOnWindowFocus: true, retry: false });
}

/** The person's Hugo settings (read aloud, how long the conversation is kept), on every device. */
export function useHugoProfile(enabled: boolean) {
  return useQuery({ queryKey: HUGO_PROFILE_KEY, queryFn: () => getHugoProfile(), enabled, staleTime: 5 * 60_000, retry: false });
}
