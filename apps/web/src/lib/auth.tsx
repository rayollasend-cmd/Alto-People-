import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { toast } from 'sonner';
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
import { onApiAuthFailure, onApiConnectivity } from './sessionEvents';

/**
 * How long a network failure must go un-contradicted (no request getting
 * a response) before the Topbar "Reconnecting…" pill shows. A lone
 * transient failure immediately followed by a success never flashes the
 * pill. Exported for tests.
 */
export const OFFLINE_GRACE_MS = 1500;

/** Toast id — pinning it makes "exactly one session-ended toast" cheap. */
const SESSION_ENDED_TOAST_ID = 'auth-session-ended';

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
   * code prompt and finish the flow with `submitMfaChallenge`. Returns
   * `{ mfaEnrollmentRequired: true }` when the org policy requires TOTP
   * but the account has none — the caller drives the enrollment flow
   * (QR + confirm) against /auth/me/mfa/enroll/*, which the short-lived
   * mfa_enroll cookie set by the server authorizes. Otherwise the user
   * is signed in and `user` state is set.
   */
  signIn: (
    email: string,
    password: string,
  ) => Promise<{ mfaRequired: boolean; mfaEnrollmentRequired: boolean }>;
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

  // ---------------------------------------------------------------------
  // App-wide session death + connectivity (see lib/sessionEvents.ts).
  // apiFetch emits; this provider is the single consumer, so every page
  // gets the redirect-on-session-death and the accurate offline pill for
  // free while keeping its own per-request error banners.
  // ---------------------------------------------------------------------

  // Refs, not state, inside the listeners: the subscriptions are
  // mounted once and must always see the CURRENT user without
  // re-subscribing on every auth change.
  const userRef = useRef<AuthUser | null>(null);
  const reprobeInFlightRef = useRef(false);
  const deathToastShownRef = useRef(false);
  const offlineTimerRef = useRef<number | null>(null);

  useEffect(() => {
    userRef.current = user;
    // A fresh sign-in re-arms the toast for the NEXT session death.
    if (user) deathToastShownRef.current = false;
  }, [user]);

  // Mid-session 401 → verify with ONE /auth/me re-probe (the 401 might be
  // a one-off, e.g. a race with a just-rotated token) before logging out.
  useEffect(() => {
    return onApiAuthFailure(() => {
      // Not signed in — nothing to kill. This also covers the dual-use
      // /auth/me/mfa/enroll/* endpoints during the org-forced enrollment
      // step on /login, where a 401 means "enrollment window expired".
      if (!userRef.current) return;
      // Single-flight: a page firing five queries at once produces five
      // 401s — one probe answers for all of them. (This flag also stops
      // the probe's own 401 from re-triggering the handler.)
      if (reprobeInFlightRef.current) return;
      reprobeInFlightRef.current = true;

      const die = () => {
        // Clearing the user makes RequireAuth bounce to /login with the
        // current location preserved in state.from — no hard navigation.
        setUser(null);
        if (!deathToastShownRef.current) {
          deathToastShownRef.current = true;
          toast.error('Your session ended — sign in again.', {
            id: SESSION_ENDED_TOAST_ID,
          });
        }
      };

      void (async () => {
        try {
          const me = await apiFetch<MeResponse>('/auth/me');
          if (me.user) {
            // Session is alive — the 401 was a one-off, OR the account's
            // role/capabilities changed server-side (admin edit) and this
            // endpoint 401s under the old grant. Same update-in-place
            // refreshUser does: chrome + capability gates re-render.
            setUser(me.user);
          } else {
            die();
          }
        } catch (err) {
          if (err instanceof ApiError && err.status === 401) {
            die();
          }
          // Network/5xx: inconclusive — keep the session; the
          // connectivity layer below owns that UX.
        } finally {
          reprobeInFlightRef.current = false;
        }
      })();
    });
  }, []);

  // Connectivity transitions → the isOffline flag the Topbar pill reads.
  // Flapping guard: 'offline' arms a short grace timer instead of
  // flipping immediately; any response received cancels it. The pill
  // never clears on silence — only an actual success flips it back.
  useEffect(() => {
    const unsubscribe = onApiConnectivity((state) => {
      if (state === 'online') {
        if (offlineTimerRef.current !== null) {
          window.clearTimeout(offlineTimerRef.current);
          offlineTimerRef.current = null;
        }
        setIsOffline(false);
        return;
      }
      if (offlineTimerRef.current !== null) return;
      offlineTimerRef.current = window.setTimeout(() => {
        offlineTimerRef.current = null;
        setIsOffline(true);
      }, OFFLINE_GRACE_MS);
    });
    return () => {
      unsubscribe();
      if (offlineTimerRef.current !== null) {
        window.clearTimeout(offlineTimerRef.current);
        offlineTimerRef.current = null;
      }
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
      return { mfaRequired: true, mfaEnrollmentRequired: false };
    }
    // Only the enroll variant carries this key, so a bare `in` check
    // narrows cleanly (a compound check defeats TS's negation narrowing).
    if ('mfaEnrollmentRequired' in res) {
      // Same posture: the only cookie is the ephemeral mfa_enroll one.
      // The caller drives the enrollment flow; a real session is issued
      // by /auth/me/mfa/enroll/confirm.
      return { mfaRequired: false, mfaEnrollmentRequired: true };
    }
    setUser(res.user);
    setIsOffline(false);
    return { mfaRequired: false, mfaEnrollmentRequired: false };
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
