import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { useAuth, useTenant } from '@/lib/auth';
import { listClients } from '@/lib/clientsApi';

// Global store (client) scope — the answer to "which store am I working?"
// asked once in the shell instead of once per module. The Topbar renders a
// one-click store bar bound to this context; Scheduling / Time / Labor /
// People consume `clientId` as their client filter and write back through
// `setClientId`, so hopping modules never re-asks the question.
//
// '' means "all stores". The choice persists per user (not per device
// session) so it survives reloads, and it deliberately does NOT write to
// the URL — deep links carry their own ?client= and the target pages give
// an explicit URL param precedence over this scope.
//
// Client-bounded roles (supervisors, client portal, associates) are pinned
// to their own client server-side; for them the switcher is disabled and
// `clientId` mirrors their clamp so consuming pages need no special case.

const BOUNDED_ROLES = new Set<string>([
  'ASSOCIATE',
  'CLIENT_PORTAL',
  'SHIFT_SUPERVISOR',
  'FLOOR_SUPERVISOR',
]);

export interface StoreScopeClient {
  id: string;
  name: string;
}

interface StoreScopeValue {
  /** '' = all stores; otherwise a client id. */
  clientId: string;
  setClientId: (id: string) => void;
  clients: StoreScopeClient[];
  /** False for bounded roles / signed-out — hide the switcher, pin the scope. */
  enabled: boolean;
  /** True once the signed-in user's saved choice has been read — a page
   *  that follows the scope treats the value it sees then as its baseline,
   *  not as a click. */
  ready: boolean;
}

const StoreScopeContext = createContext<StoreScopeValue>({
  clientId: '',
  setClientId: () => {},
  clients: [],
  enabled: false,
  ready: false,
});

// Which pages follow the scope (deep audit LEAD-16): the picker showed on
// the executive pages, Analytics, Clients, Reports and the ops home, which
// never read it — picking "Coastal" left every number company-wide. A page
// follows the scope by reading it (useStoreScope); the shell asks
// useStoreScopeFollowed() whether any page on screen does, and shows the
// picker only then. Two contexts so a page registering never re-renders the
// others: the register function is stable, the count changes.
const FollowRegisterContext = createContext<(() => () => void) | null>(null);
/** Followers on screen; null outside a provider (a test's lone Topbar) = unknown, show the picker. */
const FollowCountContext = createContext<number | null>(null);

const storageKey = (userId: string) => `alto:storeScope:${userId}`;
const EMPTY_CLIENTS: StoreScopeClient[] = [];

export function StoreScopeProvider({ children }: { children: ReactNode }) {
  const { user, can } = useAuth();
  const { moduleOn } = useTenant();
  // The store switcher is for roles that read store data. The vans cross
  // every client and a driver has no store pages — neither transportation
  // role gets it (their /scheduling/clients read 403'd on every page).
  // A direct employer (the client module off) has no client scope at all:
  // the switcher never renders and the clients are never asked for, so a
  // hotel's screens carry no "store scope" (the hotel journey, 2026-10-15).
  const enabled =
    !!user && moduleOn('clientPortal') && !BOUNDED_ROLES.has(user.role) && (can('view:clients') || can('view:scheduling'));
  const userId = user?.id ?? null;
  // Only bounded ROLES pin to the account's clientId — an org-wide role
  // carrying an incidental clientId must not be silently scoped to it.
  const boundedClientId =
    user && BOUNDED_ROLES.has(user.role) ? (user.clientId ?? '') : '';
  const canViewClients = can('view:clients');

  const [clientId, setClientIdState] = useState('');
  const [readyFor, setReadyFor] = useState<string | null>(null);

  // Hydrate the persisted choice when the signed-in user changes. Bounded
  // roles are pinned to their clamp regardless of anything persisted.
  useEffect(() => {
    if (!userId) {
      setClientIdState('');
      setReadyFor(null);
      return;
    }
    if (!enabled) {
      setClientIdState(boundedClientId);
      setReadyFor(userId);
      return;
    }
    try {
      setClientIdState(localStorage.getItem(storageKey(userId)) ?? '');
    } catch {
      setClientIdState('');
    }
    setReadyFor(userId);
  }, [userId, enabled, boundedClientId]);

  // Scheduler-tier roles without view:clients (the WFM) read the
  // operational directory instead — /clients carries bill rates and
  // 403s for them, which used to leave the store bar empty. A failure is
  // non-fatal: the bar just doesn't render; pages fall back to their own
  // pickers.
  const clientsQuery = useQuery({
    queryKey: ['storeScope', 'clients', canViewClients],
    queryFn: async (): Promise<StoreScopeClient[]> => {
      const r = canViewClients
        ? await listClients({ status: 'ACTIVE' })
        : await apiFetch<{ clients: Array<{ id: string; name: string }> }>('/scheduling/clients');
      return r.clients.map((c) => ({ id: c.id, name: c.name }));
    },
    enabled,
    staleTime: 5 * 60_000,
  });
  const clients = useMemo(
    () => (enabled ? (clientsQuery.data ?? EMPTY_CLIENTS) : EMPTY_CLIENTS),
    [enabled, clientsQuery.data],
  );

  // A persisted store that was deleted/renamed away falls back to "all".
  useEffect(() => {
    if (!enabled || clients.length === 0 || !clientId) return;
    if (!clients.some((c) => c.id === clientId)) setClientIdState('');
  }, [clients, clientId, enabled]);

  const setClientId = useCallback(
    (id: string) => {
      if (!enabled) return;
      setClientIdState(id);
      if (userId) {
        try {
          localStorage.setItem(storageKey(userId), id);
        } catch {
          // Private mode — scope still works for the session.
        }
      }
    },
    [enabled, userId],
  );

  const ready = userId !== null && readyFor === userId;
  const value = useMemo(
    () => ({ clientId, setClientId, clients, enabled, ready }),
    [clientId, setClientId, clients, enabled, ready],
  );
  const [followers, setFollowers] = useState(0);
  const register = useCallback(() => {
    setFollowers((n) => n + 1);
    return () => setFollowers((n) => n - 1);
  }, []);
  return (
    <StoreScopeContext.Provider value={value}>
      <FollowRegisterContext.Provider value={register}>
        <FollowCountContext.Provider value={followers}>{children}</FollowCountContext.Provider>
      </FollowRegisterContext.Provider>
    </StoreScopeContext.Provider>
  );
}

/**
 * The scope, for a page that follows it: reading it is what marks the page
 * as one the shell's picker applies to. The shell's own picker passes
 * `{ shell: true }` so it never counts itself.
 */
export function useStoreScope(opts?: { shell?: boolean }): StoreScopeValue {
  const register = useContext(FollowRegisterContext);
  const shell = opts?.shell === true;
  useEffect(() => {
    if (shell || !register) return;
    return register();
  }, [register, shell]);
  return useContext(StoreScopeContext);
}

/** Whether a page on screen follows the scope (true when nothing is tracking, as before). */
export function useStoreScopeFollowed(): boolean {
  const count = useContext(FollowCountContext);
  return count === null || count > 0;
}

/** "Walmart Santa Rosa Beach" → "Santa Rosa Beach" — the bar has 4+1 slots. */
export function shortStoreName(name: string): string {
  return name.replace(/^walmart\s+/i, '').trim() || name;
}
