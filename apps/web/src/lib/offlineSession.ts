import type { AuthUser } from '@alto-people/shared';

/**
 * WHO YOU WERE, WHEN THERE'S NO SIGNAL.
 *
 * On a cold start with no network, `/auth/me` throws before it can say who
 * you are. The bootstrap treats that as "keep the session" — but on a cold
 * start there is no session in memory to keep, so `user` stayed null and
 * RequireAuth bounced to the sign-in screen. An installed app that shows
 * you a login form on the subway is not an installed app.
 *
 * So a successful `/auth/me` leaves a copy of the identity here, and a
 * network failure at boot restores it. What that buys is the shell and the
 * persisted query cache — everything you already had permission to see.
 *
 * It is deliberately NOT a credential:
 *   - the session cookie is httpOnly and still required for every call, so
 *     nothing new can be fetched with this;
 *   - it expires on its own after MAX_AGE_MS, so a device left in a drawer
 *     doesn't keep someone's roster on screen indefinitely;
 *   - a 401 (as opposed to a network error) clears it, so a session killed
 *     server-side stops working the moment the device can hear that;
 *   - sign-out wipes it with the rest of the `alto` namespace — the key is
 *     deliberately outside DEVICE_SCOPED_PREFIXES in auth.tsx.
 */

const KEY = 'alto.offline.session';

/** A day. Long enough for an overnight shift, short enough to go stale. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface StoredSession {
  user: AuthUser;
  savedAt: number;
}

export function saveOfflineSession(user: AuthUser | null): void {
  try {
    if (!user) {
      window.localStorage.removeItem(KEY);
      return;
    }
    const payload: StoredSession = { user, savedAt: Date.now() };
    window.localStorage.setItem(KEY, JSON.stringify(payload));
  } catch {
    /* storage unavailable (private window, quota) — offline boot just won't work */
  }
}

/**
 * The last known identity, or null if there isn't one or it's too old.
 * Reading a stale entry also removes it, so it can't come back later.
 */
export function readOfflineSession(): AuthUser | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSession;
    if (!parsed?.user?.id || typeof parsed.savedAt !== 'number') {
      window.localStorage.removeItem(KEY);
      return null;
    }
    if (Date.now() - parsed.savedAt > MAX_AGE_MS) {
      window.localStorage.removeItem(KEY);
      return null;
    }
    return parsed.user;
  } catch {
    return null;
  }
}

/** When the restored session was last confirmed with the server. */
export function offlineSessionSavedAt(): number | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSession;
    return typeof parsed?.savedAt === 'number' ? parsed.savedAt : null;
  } catch {
    return null;
  }
}

export function clearOfflineSession(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
}
