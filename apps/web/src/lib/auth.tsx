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
  capabilitiesOf,
} from '@alto-people/shared';
import { ROLE_LABELS, defaultTenantProfile, termsIn, type TenantModule, type TenantProfile, type TermKey } from '@alto-people/shared';
import { termVarsFrom, useI18n } from './i18n';
import { ApiError, NetworkError, TimeoutError, apiFetch } from './api';
import { isNative } from './native/platform';
import { onApiAuthFailure, onApiConnectivity } from './sessionEvents';
import { clearOfflineSession, readOfflineSession, saveOfflineSession } from './offlineSession';
import { clearPersistedQueries, startQueryPersistence } from './queryPersist';
import { setDisplayTimeZone } from './format';
import { startWebVitals } from './webVitals';

/**
 * How long a network failure must go un-contradicted (no request getting
 * a response) before the Topbar "Reconnecting…" pill shows. A lone
 * transient failure immediately followed by a success never flashes the
 * pill. Exported for tests.
 */
export const OFFLINE_GRACE_MS = 1500;

/**
 * The session probe's retry schedule when the server is silent: 2s, 4s,
 * 8s, 16s, then every 30s. Mutable so a test can run the schedule in
 * milliseconds instead of waiting it out.
 */
export const PROBE_RETRY = { baseMs: 2_000, maxMs: 30_000 };

/** Retries the splash stays up for when nothing is remembered (≈30s). */
export const PROBE_SPLASH_ATTEMPTS = 4;

export function probeRetryDelayMs(attempt: number): number {
  return Math.min(PROBE_RETRY.maxMs, PROBE_RETRY.baseMs * 2 ** Math.max(0, attempt - 1));
}

/**
 * "The server did not answer": no network, a timeout, or a 5xx (a deploy,
 * a gateway, a crashed process). None of these says anything about the
 * session, so none of them may end it. Exported for tests.
 */
export function isServerSilence(err: unknown): boolean {
  if (err instanceof NetworkError || err instanceof TimeoutError) return true;
  return err instanceof ApiError && (err.status >= 500 || err.status === 0);
}

/** Toast id — pinning it makes "exactly one session-ended toast" cheap. */
const SESSION_ENDED_TOAST_ID = 'auth-session-ended';

interface AuthState {
  /** Initial /auth/me probe in flight. Components should hold rendering. */
  isInitializing: boolean;
  /** True iff a network call (login/logout/me) was disrupted; UI can hint. */
  isOffline: boolean;
  user: AuthUser | null;
  /** The role the account is WEARING. Capabilities and navigation follow it. */
  role: Role | null;
  /** The account's home role — differs from `role` only while switched. */
  primaryRole: Role | null;
  /**
   * Every role this one account may act as, primary first. Length 1 for
   * almost everyone: a person with two jobs (a shift supervisor who also
   * drives an Alto van) is the exception the switcher exists for.
   */
  availableRoles: Role[];
  capabilities: ReadonlySet<Capability>;
  /** Brief 2-1b: the signed-in user's tenant profile — modules and terminology. A safe default before /auth/me answers. */
  tenant: TenantSession;
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
  /**
   * Put on another of this account's roles.
   *
   * The whole app re-reads from the new role, so everything cached under
   * the old one is thrown away first — a supervisor's store lists and a
   * driver's van runs are not the same data and must never be mixed.
   * Throws if the role was never granted.
   */
  switchRole: (role: Role) => Promise<void>;
  can: (capability: Capability) => boolean;
}

/** The tenant's profile plus what its team calls the assistant (OrgSetting.assistantName); absent from an older server or an offline session. */
/** `orgName`: the tenant's display name (branding) — the portal's {org}. Absent from an older server. */
export type TenantSession = TenantProfile & { id: string; assistantName?: string; orgName?: string };

/** Everything on, Alto HR's words: what an older server or an offline session implies. */
export const DEFAULT_TENANT: TenantSession = { id: '', ...defaultTenantProfile('WORKFORCE_PROVIDER') };

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
  // Nav personalization caches/recents are keyed PER USER inside the
  // value keys (alto.nav.*.v2.<userId>), so surviving sign-out is safe —
  // and wiping them here was exactly what made pins "disappear by
  // themselves" on every sign-out before pins moved server-side.
  'alto.nav.',
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
  const [user, setUserState] = useState<AuthUser | null>(null);
  const [isInitializing, setIsInitializing] = useState(true);
  const [isOffline, setIsOffline] = useState(false);
  const [tenant, setTenant] = useState<TenantSession>(DEFAULT_TENANT);
  // Brief 2-1b: every dictionary string can name the tenant's words ({site}, {worker} …).
  const { lang: uiLang, setTermVars } = useI18n();
  useEffect(() => {
    setTermVars(termVarsFrom(termsIn({ terminology: tenant.terminology }, uiLang), { org: tenant.orgName }));
  }, [tenant, uiLang, setTermVars]);

  // Refs, not state, inside the listeners: the subscriptions are
  // mounted once and must always see the CURRENT user without
  // re-subscribing on every auth change.
  const userRef = useRef<AuthUser | null>(null);
  /**
   * Every write to the signed-in user goes through here so `userRef`
   * moves in the same tick as the state.
   *
   * Mirroring it in an effect left a window between the commit and the
   * effect flushing where the mid-session 401 handler below read null and
   * returned — swallowing the only signal that the session had died, so
   * the app kept a dead session until the next unlucky request. It showed
   * up as a load-dependent test flake; on a slow phone it is a user
   * staring at a page that will never load.
   */
  const setUser = useCallback((next: AuthUser | null) => {
    userRef.current = next;
    setUserState(next);
  }, []);

  // Initial /auth/me probe. Under React.StrictMode (dev) this effect mounts,
  // unmounts, and remounts — we let the second run complete naturally and
  // unconditionally clear isInitializing so the splash never gets stuck.
  //
  // Only a 401 is an answer about the session. Everything else — no
  // network, a timeout, a 5xx from a deploy or a gateway — is the server
  // not answering, and the session is kept: the remembered identity comes
  // back, the "Reconnecting…" pill shows, and the probe retries with
  // backoff until it gets a real answer. Before this, a 502 during a
  // deploy signed out every tablet on the floor (role walk floor 2, ops 3,
  // HR 24; audit Tier 1 #7).
  useEffect(() => {
    const ac = new AbortController();
    let cancelled = false;
    let retryTimer: number | null = null;
    (async () => {
      let attempt = 0;
      // With no remembered identity there is nothing to show behind the
      // splash, so it stays up through the first retries (about 30s) and
      // only then gives way to the sign-in page. With one, the shell opens
      // at once and the retries go on in the background.
      let splashHeld = false;
      for (;;) {
        try {
          // eslint-disable-next-line no-restricted-syntax -- the session probe itself: it decides whether the query layer may run and which cache to restore, so it cannot live inside it
          const me = await apiFetch<MeResponse>('/auth/me', { signal: ac.signal });
          if (cancelled) return;
          setUser(me.user);
          setTenant(me.tenant ?? DEFAULT_TENANT);
          saveOfflineSession(me.user);
          setIsOffline(false);
          return;
        } catch (err) {
          if (cancelled || ac.signal.aborted) return;
          if (err instanceof ApiError && err.status === 401) {
            // Cookie was present but stale. Server cleared it; we clear local
            // state — including the offline copy, so a dead session can't be
            // resurrected by pulling the network cable.
            clearOfflineSession();
            void clearPersistedQueries();
            setUser(null);
            return;
          }
          if (!isServerSilence(err)) {
            // A 4xx other than 401 (a bad request shape, a forbidden probe)
            // is an answer, not silence: nothing to keep.
            setUser(null);
            return;
          }
          // Offline, a cold-backend timeout, or a 5xx — keep the user's
          // session and show the "reconnecting" affordance. On a COLD start
          // there is no session in memory to keep, though — `user` is still
          // null and RequireAuth would bounce to /login. So restore the last
          // known identity, which unlocks the shell and the persisted cache.
          // It is not a credential: every call still needs the httpOnly
          // cookie, and the moment we reach the server again a dead session
          // logs out as usual.
          if (attempt === 0) {
            const remembered = readOfflineSession();
            if (remembered) setUser(remembered);
            else splashHeld = true;
            setIsOffline(true);
          }
          if (splashHeld && attempt >= PROBE_SPLASH_ATTEMPTS) {
            // Nothing remembered and the server still silent: the sign-in
            // page is the honest screen now. The retries go on; a success
            // from here lands the person back in their session.
            splashHeld = false;
            setIsInitializing(false);
          }
          attempt += 1;
          await new Promise<void>((resolve) => {
            retryTimer = window.setTimeout(resolve, probeRetryDelayMs(attempt));
          });
          if (cancelled) return;
        } finally {
          if (!cancelled && !splashHeld) setIsInitializing(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      ac.abort();
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [setUser]);

  // ---------------------------------------------------------------------
  // App-wide session death + connectivity (see lib/sessionEvents.ts).
  // apiFetch emits; this provider is the single consumer, so every page
  // gets the redirect-on-session-death and the accurate offline pill for
  // free while keeping its own per-request error banners.
  // ---------------------------------------------------------------------

  const reprobeInFlightRef = useRef(false);
  const deathToastShownRef = useRef(false);
  const offlineTimerRef = useRef<number | null>(null);

  useEffect(() => {
    // A fresh sign-in re-arms the toast for the NEXT session death. The
    // ref itself is kept current by setUser, not here.
    if (user) deathToastShownRef.current = false;
  }, [user]);

  // Mirror the query cache to IndexedDB for whoever is signed in, so the
  // installed app reopened without signal shows yesterday's schedule
  // instead of a wall of error banners. Keyed by user id: a shared store
  // tablet never restores one person's cache into another's session.
  const persistUserId = user?.id ?? null;
  useEffect(() => {
    if (!persistUserId) return;
    return startQueryPersistence(persistUserId);
  }, [persistUserId]);

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
        // The offline copy and the persisted cache go with it: a session
        // the server has killed must not survive as readable cached data.
        clearOfflineSession();
        void clearPersistedQueries();
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
          // eslint-disable-next-line no-restricted-syntax -- a one-shot re-check after a 401 that decides whether the session is dead; not a read to cache
          const me = await apiFetch<MeResponse>('/auth/me');
          if (me.user) {
            // Session is alive — the 401 was a one-off, OR the account's
            // role/capabilities changed server-side (admin edit) and this
            // endpoint 401s under the old grant. Same update-in-place
            // refreshUser does: chrome + capability gates re-render.
            setUser(me.user);
        setTenant(me.tenant ?? DEFAULT_TENANT);
            saveOfflineSession(me.user);
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
  }, [setUser]);

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

  // The login responses carry the user only; the tenant profile comes from /auth/me.
  const loadTenant = useCallback(async () => {
    try {
      const me = await apiFetch<MeResponse>('/auth/me');
      setTenant(me.tenant ?? DEFAULT_TENANT);
    } catch {
      // Keep the default; the next /auth/me read will set it.
    }
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
    void loadTenant();
    return { mfaRequired: false, mfaEnrollmentRequired: false };
  }, [setUser, loadTenant]);

  const submitMfaChallenge = useCallback(async (input: MfaChallengeInput) => {
    const res = await apiFetch<MfaChallengeResponse>('/auth/mfa-challenge', {
      method: 'POST',
      body: input,
    });
    setUser(res.user);
    saveOfflineSession(res.user);
    setIsOffline(false);
    void loadTenant();
  }, [setUser, loadTenant]);

  const signOut = useCallback(async () => {
    try {
      // Inside the native app apiFetch also names this phone (x-alto-device),
      // so the server ends its push and its Keychain credential.
      await apiFetch<void>('/auth/logout', { method: 'POST' });
    } catch {
      // Ignore — clear local state regardless so user lands at /login.
    }
    if (isNative()) await import('./native/session').then((m) => m.forgetThisDevice()).catch(() => {});
    clearUserScopedStorage();
    // clearUserScopedStorage sweeps the `alto` localStorage namespace, which
    // takes the offline session with it; the query cache lives in IndexedDB
    // and needs its own call.
    void clearPersistedQueries();
    setUser(null);
  }, [setUser]);

  // The timezone preference from Settings reaches every fmt* call site
  // through the format module's own channel — the same way the language
  // does — rather than through props. Cleared on sign-out so the next
  // person on a shared device is not shown the last person's clock.
  useEffect(() => {
    setDisplayTimeZone(user?.timezone ?? null);
  }, [user?.timezone]);

  // The web-vitals beacon rides the session cookie, so measuring starts
  // with the first signed-in render (idempotent after that).
  const signedIn = Boolean(user);
  useEffect(() => {
    if (signedIn) startWebVitals();
  }, [signedIn]);

  const switchRole = useCallback(async (role: Role) => {
    const res = await apiFetch<MeResponse>('/auth/me/active-role', {
      method: 'POST',
      body: { role },
    });
    if (!res.user) throw new Error('Could not switch role.');
    // Every cached answer was fetched as somebody else. Keeping any of it
    // is how a driver ends up looking at a store's roster.
    void clearPersistedQueries();
    setUser(res.user);
    setTenant(res.tenant ?? DEFAULT_TENANT);
    saveOfflineSession(res.user);
    setIsOffline(false);
  }, [setUser]);

  const refreshUser = useCallback(async () => {
    try {
      const me = await apiFetch<MeResponse>('/auth/me');
      setUser(me.user);
        setTenant(me.tenant ?? DEFAULT_TENANT);
      saveOfflineSession(me.user);
      setIsOffline(false);
    } catch {
      // Soft fail — keep the cached user. Network/server errors here
      // shouldn't bounce a signed-in user out of the app.
    }
  }, [setUser]);

  const value = useMemo<AuthState>(() => {
    const role = user?.role ?? null;
    // Brief 2-3 step 3: a custom role narrows the built-in set.
    const capabilities = user ? capabilitiesOf(user) : EMPTY_CAPS;
    return {
      isInitializing,
      isOffline,
      user,
      role,
      primaryRole: user?.primaryRole ?? role,
      // An older server, or an offline session saved before this existed,
      // says nothing about extra roles — which correctly means "just the
      // one", and the switcher stays hidden.
      availableRoles: user?.availableRoles ?? (role ? [role] : []),
      capabilities,
      tenant,
      signIn,
      submitMfaChallenge,
      signOut,
      refreshUser,
      switchRole,
      can: (cap) => capabilities.has(cap),
    };
  }, [
    isInitializing,
    isOffline,
    user,
    tenant,
    signIn,
    submitMfaChallenge,
    signOut,
    refreshUser,
    switchRole,
  ]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** Brief 2-1b: the tenant's profile, with a module check. Falls back to the defaults outside a provider. */
export function useTenant(): TenantSession & { moduleOn: (module: TenantModule) => boolean } {
  const ctx = useContext(AuthContext);
  const tenant = ctx?.tenant ?? DEFAULT_TENANT;
  return useMemo(() => ({ ...tenant, moduleOn: (module: TenantModule) => tenant.modules[module] }), [tenant]);
}

/** Brief 2-1b: the tenant's word for a thing, in the app's language. */
export function useTerm(): (key: TermKey) => string {
  const ctx = useContext(AuthContext);
  const { lang } = useI18n();
  const terminology = (ctx?.tenant ?? DEFAULT_TENANT).terminology;
  return useMemo(() => {
    const terms = termsIn({ terminology }, lang);
    return (key: TermKey) => terms[key];
  }, [terminology, lang]);
}

/** The role's name in the tenant's words where the terminology names it, else the shared label. */
const ROLE_TERM: Partial<Record<Role, TermKey>> = {
  ASSOCIATE: 'role.associate',
  SHIFT_SUPERVISOR: 'role.shiftSupervisor',
  FLOOR_SUPERVISOR: 'role.floorSupervisor',
  MANAGER: 'role.manager',
  CLIENT_PORTAL: 'role.clientPortal',
  TRANSPORTATION_DIRECTOR: 'role.transportationDirector',
  DRIVER: 'role.driver',
};

export function useRoleLabel(): (role: Role) => string {
  const term = useTerm();
  return useMemo(
    () => (role: Role) => {
      const key = ROLE_TERM[role];
      return key ? term(key) : (ROLE_LABELS[role] ?? role);
    },
    [term],
  );
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, isInitializing } = useAuth();
  const location = useLocation();

  if (isInitializing) {
    return <AuthSplash />;
  }
  if (!user) {
    return <Navigate to="/login" state={{ from: `${location.pathname}${location.search}${location.hash}` }} replace />;
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
