import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { useAuth } from '@/lib/auth';
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
}

const StoreScopeContext = createContext<StoreScopeValue>({
  clientId: '',
  setClientId: () => {},
  clients: [],
  enabled: false,
});

const storageKey = (userId: string) => `alto:storeScope:${userId}`;

export function StoreScopeProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const enabled = !!user && !BOUNDED_ROLES.has(user.role);
  const userId = user?.id ?? null;
  const boundedClientId = user?.clientId ?? '';

  const [clients, setClients] = useState<StoreScopeClient[]>([]);
  const [clientId, setClientIdState] = useState('');

  // Hydrate the persisted choice when the signed-in user changes. Bounded
  // roles are pinned to their clamp regardless of anything persisted.
  useEffect(() => {
    if (!userId) {
      setClientIdState('');
      return;
    }
    if (!enabled) {
      setClientIdState(boundedClientId);
      return;
    }
    try {
      setClientIdState(localStorage.getItem(storageKey(userId)) ?? '');
    } catch {
      setClientIdState('');
    }
  }, [userId, enabled, boundedClientId]);

  useEffect(() => {
    if (!enabled) {
      setClients([]);
      return;
    }
    let alive = true;
    void listClients({ status: 'ACTIVE' })
      .then((r) => {
        if (alive) setClients(r.clients.map((c) => ({ id: c.id, name: c.name })));
      })
      .catch(() => {
        // Non-fatal: the bar just doesn't render; pages fall back to their
        // own pickers.
      });
    return () => {
      alive = false;
    };
  }, [enabled]);

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

  const value = useMemo(
    () => ({ clientId, setClientId, clients, enabled }),
    [clientId, setClientId, clients, enabled],
  );
  return <StoreScopeContext.Provider value={value}>{children}</StoreScopeContext.Provider>;
}

export function useStoreScope(): StoreScopeValue {
  return useContext(StoreScopeContext);
}

/** "Walmart Santa Rosa Beach" → "Santa Rosa Beach" — the bar has 4+1 slots. */
export function shortStoreName(name: string): string {
  return name.replace(/^walmart\s+/i, '').trim() || name;
}
