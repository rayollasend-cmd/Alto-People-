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
  type MfaChallengeInput,
  type MfaChallengeResponse,
  ROLE_CAPABILITIES,
  hasCapability,
} from '@alto-people/shared';
import { ApiError, NetworkError, TimeoutError, apiFetch } from './api';

interface AuthState {
  /** Initial /auth/me probe in flight. Components should hold rendering. */
  isInitializing: boolean;
  /** True iff a network call (login/logout/me) was disrupted; UI can hint. */
  isOffline: boolean;
  user: AuthUser | null;
  role: Role | null;
  capabilities: ReadonlySet<Capability>;
  /**
   * POST /auth/login. Returns `{ mfaRequired: true }` when the account
   * has two-step sign-in turned on — the caller is expected to drive a
   * code prompt and finish the flow with `submitMfaChallenge`. Otherwise
   * the user is signed in and `user` state is set.
   */
  signIn: (email: string, password: string) => Promise<{ mfaRequired: boolean }>;
  /** POST /auth/mfa-challenge. Sets `user` state on success. */
  submitMfaChallenge: (input: MfaChallengeInput) => Promise<void>;
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

/**
 * Keys that describe the DEVICE rather than the person: theme, density,
 * language, install/what's-new dismissals, and the kiosk's own pairing.
 * Everything else under the `alto` namespace belongs to whoever was
 * signed in and must not survive them.
 */
const DEVICE_SCOPED_PREFIXES = [
  'alto.theme',
  'alto.density',
  'alto.lang',
  'alto.locale',
  'alto.pwa.',
  'alto.whatsnew',
  'alto.kiosk.',
];

/**
 * Wipe per-user state on sign-out.
 *
 * Signing out used to clear only the server cookie, leaving the previous
 * person's onboarding draft (DOB, home address, phone), their cached
 * shift roster, and cover-letter drafts in localStorage. On a shared
 * store tablet the next associate to sign in saw them. Also drops the
 * share-target intake cache so a file shared but never filed can't be
 * picked up by the next user.
 */
function clearUserScopedStorage(): void {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (!key) continue;
      if (!key.startsWith('alto')) continue;
      if (DEVICE_SCOPED_PREFIXES.some((p) => key.startsWith(p))) continue;
      doomed.push(key);
    }
    for (const key of doomed) window.localStorage.removeItem(key);
    window.sessionStorage.clear();
  } catch {
    /* storage unavailable — nothing to clear */
  }
  if ('caches' in window) {
    void caches.delete('alto-shared-intake').catch(() => undefined);
  }
}

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
        } else if (err instanceof NetworkError || err instanceof TimeoutError) {
          // Offline OR a cold-backend timeout — keep the user's session and
          // show the "reconnecting" affordance. Critically, do NOT fall to the
          // else branch, which clears the user and bounces them to login: a
          // slow cold start must never look like a logout.
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
    if ('mfaRequired' in res && res.mfaRequired) {
      // Don't touch user state — the cookie set by the server is the
      // ephemeral mfa_pending one, not a real session. Caller drives the
      // next step.
      return { mfaRequired: true };
    }
    setUser(res.user);
    setIsOffline(false);
    return { mfaRequired: false };
  }, []);

  const submitMfaChallenge = useCallback(async (input: MfaChallengeInput) => {
    const res = await apiFetch<MfaChallengeResponse>('/auth/mfa-challenge', {
      method: 'POST',
      body: input,
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
    clearUserScopedStorage();
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
      submitMfaChallenge,
      signOut,
      refreshUser,
      can: (cap) => (role ? hasCapability(role, cap) : false),
    };
  }, [isInitializing, isOffline, user, signIn, submitMfaChallenge, signOut, refreshUser]);

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
