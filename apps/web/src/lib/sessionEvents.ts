/**
 * App-wide session/connectivity event bus.
 *
 * apiFetch (lib/api.ts) is the single choke point every request goes
 * through, so it is the one emitter; the AuthProvider is the intended
 * consumer. Pages keep their own per-request error UX — this bus only
 * exists so the two APP-WIDE outcomes (session death → redirect to
 * /login, network loss → the Topbar "Reconnecting…" pill) are handled
 * once instead of re-implemented per page.
 *
 * Deliberately not DOM CustomEvents: a plain listener set is
 * synchronous, type-safe, and trivially resettable in tests.
 */

export type ConnectivityState = 'online' | 'offline';

type AuthFailureListener = (path: string) => void;
type ConnectivityListener = (state: ConnectivityState) => void;

const authFailureListeners = new Set<AuthFailureListener>();
const connectivityListeners = new Set<ConnectivityListener>();

// Start from 'online' so the very first successful request doesn't fire a
// spurious "recovered" notification — listeners only hear TRANSITIONS.
let lastConnectivity: ConnectivityState = 'online';

/**
 * Auth-flow endpoints where a 401 is a NORMAL outcome (wrong password,
 * expired invite/reset token, failed passkey assertion…) rather than a
 * signed-in session dying. apiFetch never emits authFailure for these.
 *
 * Prefix-matched against the path handed to apiFetch (before the /api
 * rewrite). Derived from the actual /auth usage across the app:
 *   - /auth/login, /auth/mfa-challenge      — Login.tsx / auth.tsx sign-in
 *   - /auth/forgot-password                 — ForgotPassword.tsx
 *   - /auth/reset-password                  — ResetPassword.tsx (token auth)
 *   - /auth/invite/*, /auth/accept-invite   — AcceptInvite.tsx (token auth)
 *   - /auth/webauthn/login/*                — webauthn.ts passkey sign-in
 *   - /auth/oidc/*                          — SSO probe/config (public)
 *   - /auth/email-change/confirm            — public, token-authorized
 *   - /auth/logout                          — a 401 here means "already
 *     signed out"; signOut() clears local state itself, and toasting
 *     "your session ended" during a deliberate sign-out is wrong
 *
 * NOTE /auth/me/mfa/enroll/* is intentionally NOT here. It is dual-use:
 * during org-forced enrollment on /login it runs on the ephemeral
 * mfa_enroll cookie (401 = expired enrollment window, normal), but from
 * Settings it runs on the real session (401 = session death). The
 * AuthProvider disambiguates by ignoring authFailure while no user is
 * signed in, which covers the /login case without a path rule.
 */
const AUTH_FLOW_PATH_PREFIXES = [
  '/auth/login',
  '/auth/mfa-challenge',
  '/auth/forgot-password',
  '/auth/reset-password',
  '/auth/invite/',
  '/auth/accept-invite',
  '/auth/webauthn/login/',
  '/auth/oidc/',
  '/auth/email-change/confirm',
  '/auth/logout',
] as const;

export function isAuthFlowPath(path: string): boolean {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return AUTH_FLOW_PATH_PREFIXES.some((p) => normalized.startsWith(p));
}

/**
 * Subscribe to mid-session 401s (any non-auth-flow request rejected as
 * unauthenticated). Returns an unsubscribe function.
 */
export function onApiAuthFailure(cb: AuthFailureListener): () => void {
  authFailureListeners.add(cb);
  return () => authFailureListeners.delete(cb);
}

/**
 * Subscribe to connectivity TRANSITIONS ('offline' after a
 * NetworkError/TimeoutError, 'online' once any request gets a response
 * again). Consecutive duplicates are swallowed here so listeners don't
 * hear "online" for every successful request. Returns unsubscribe.
 */
export function onApiConnectivity(cb: ConnectivityListener): () => void {
  connectivityListeners.add(cb);
  return () => connectivityListeners.delete(cb);
}

/** Emitter — called by apiFetch only (and tests). */
export function emitApiAuthFailure(path: string): void {
  for (const cb of authFailureListeners) cb(path);
}

/** Emitter — called by apiFetch only (and tests). Dedupes repeats. */
export function emitApiConnectivity(state: ConnectivityState): void {
  if (state === lastConnectivity) return;
  lastConnectivity = state;
  for (const cb of connectivityListeners) cb(state);
}

/** Test-only: drop all listeners and restore the initial 'online' state. */
export function resetSessionEventsForTest(): void {
  authFailureListeners.clear();
  connectivityListeners.clear();
  lastConnectivity = 'online';
}
