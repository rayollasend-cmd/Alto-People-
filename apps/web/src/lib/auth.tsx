import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import {
  type AuthUser,
  type Capability,
  type Role,
  type LoginResponse,
  type MeResponse,
  ROLE_CAPABILITIES,
  hasCapability,
} from '@alto-people/shared';
import { ApiError, NetworkError, apiFetch } from './api';

interface AuthState {
  /** Initial /auth/me probe in flight. Components should hold rendering. */
  isInitializing: boolean;
  /** True iff a network call (login/logout/me) was disrupted; UI can hint. */
  isOffline: boolean;
  user: AuthUser | null;
  role: Role | null;
  capabilities: ReadonlySet<Capability>;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  /**
   * Re-fetch /auth/me. Use after self-service mutations (profile name,
   * profile photo) so the chrome avatar/display name update without a
   * full page reload. Network failures are swallowed — the cached user
   * stays put and the next poll/route change can retry.
   */
  refreshUser: () => Promise<void>;
  can: (capability: Capability) => boolean;
}

export const AuthContext = createContext<AuthState | null>(null);

const EMPTY_CAPS: ReadonlySet<Capability> = new Set();

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isInitializing, setIsInitializing] = useState(true);
  const [isOffline, setIsOffline] = useState(false);

  // Initial /auth/me probe. Under React.StrictMode (dev) this effect mounts,
  // unmounts, and remounts — we let the second run complete naturally and
  // unconditionally clear isInitializing so the splash never gets stuck.
  useEffect(() => {
    const ac = new AbortController();
    let cancelled = false;
    (async () => {
      try {
        const me = await apiFetch<MeResponse>('/auth/me', { signal: ac.signal });
        if (cancelled) return;
        setUser(me.user);
        setIsOffline(false);
      } catch (err) {
        if (cancelled || ac.signal.aborted) return;
        if (err instanceof ApiError && err.status === 401) {
          // Cookie was present but stale. Server cleared it; we clear local state.
          setUser(null);
        } else if (err instanceof NetworkError) {
          // Keep user state untouched; show "reconnecting" affordance.
          setIsOffline(true);
        } else {
          setUser(null);
        }
      } finally {
        if (!cancelled) setIsInitializing(false);
      }
    })();

    return () => {
      cancelled = true;
      ac.abort();
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const res = await apiFetch<LoginResponse>('/auth/login', {
      method: 'POST',
      body: { email, password },
    });
    setUser(res.user);
    setIsOffline(false);
  }, []);

  const signOut = useCallback(async () => {
    try {
      await apiFetch<void>('/auth/logout', { method: 'POST' });
    } catch {
      // Ignore — clear local state regardless so user lands at /login.
    }
    setUser(null);
  }, []);

  const refreshUser = useCallback(async () => {
    try {
      const me = await apiFetch<MeResponse>('/auth/me');
      setUser(me.user);
      setIsOffline(false);
    } catch {
      // Soft fail — keep the cached user. Network/server errors here
      // shouldn't bounce a signed-in user out of the app.
    }
  }, []);

  const value = useMemo<AuthState>(() => {
    const role = user?.role ?? null;
    const capabilities = role ? ROLE_CAPABILITIES[role] : EMPTY_CAPS;
    return {
      isInitializing,
      isOffline,
      user,
      role,
      capabilities,
      signIn,
      signOut,
      refreshUser,
      can: (cap) => (role ? hasCapability(role, cap) : false),
    };
  }, [isInitializing, isOffline, user, signIn, signOut, refreshUser]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, isInitializing } = useAuth();
  const location = useLocation();

  if (isInitializing) {
    return <AuthSplash />;
  }
  if (!user) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }
  return <>{children}</>;
}

function AuthSplash() {
  return (
    <div
      className="min-h-screen flex items-center justify-center bg-midnight"
      role="status"
      aria-live="polite"
      aria-label="Loading"
    >
      <div className="flex flex-col items-center text-center">
        <div className="font-display text-4xl text-white leading-none">
          Alto <span className="text-gold">People</span>
        </div>
        <div
          className="mt-6 h-0.5 w-32 overflow-hidden rounded-full bg-navy-secondary"
          aria-hidden="true"
        >
          <div className="h-full w-1/3 rounded-full bg-gold animate-splash-sweep" />
        </div>
      </div>
    </div>
  );
}
