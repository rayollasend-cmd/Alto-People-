import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearOfflineSession,
  offlineSessionSavedAt,
  readOfflineSession,
  saveOfflineSession,
} from '@/lib/offlineSession';
import type { AuthUser } from '@alto-people/shared';

/**
 * The remembered identity that lets a cold offline start reach the shell
 * instead of the sign-in screen. It is not a credential — every call still
 * needs the httpOnly cookie — so what matters here is that it expires, that
 * it survives nothing it shouldn't, and that a bad entry fails closed.
 */

const USER = {
  id: 'u-1',
  email: 'admin@altohr.com',
  role: 'HR_ADMINISTRATOR',
  status: 'ACTIVE',
  clientId: null,
  associateId: null,
} as unknown as AuthUser;

const KEY = 'alto.offline.session';

beforeEach(() => {
  window.localStorage.clear();
  vi.useRealTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the remembered session', () => {
  it('comes back after being saved', () => {
    saveOfflineSession(USER);
    expect(readOfflineSession()).toMatchObject({ id: 'u-1', role: 'HR_ADMINISTRATOR' });
    expect(offlineSessionSavedAt()).toBeTypeOf('number');
  });

  it('is nothing at all before a first sign-in', () => {
    expect(readOfflineSession()).toBeNull();
    expect(offlineSessionSavedAt()).toBeNull();
  });

  it('expires after a day, and clears itself on the way out', () => {
    saveOfflineSession(USER);
    const stored = JSON.parse(window.localStorage.getItem(KEY)!);
    // Backdate it just past the 24h window.
    stored.savedAt = Date.now() - (24 * 60 * 60 * 1000 + 1000);
    window.localStorage.setItem(KEY, JSON.stringify(stored));

    expect(readOfflineSession()).toBeNull();
    // A stale entry doesn't sit around waiting to be read again.
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('still honours a session saved just inside the window', () => {
    saveOfflineSession(USER);
    const stored = JSON.parse(window.localStorage.getItem(KEY)!);
    stored.savedAt = Date.now() - (23 * 60 * 60 * 1000);
    window.localStorage.setItem(KEY, JSON.stringify(stored));
    expect(readOfflineSession()).toMatchObject({ id: 'u-1' });
  });

  it('fails closed on a corrupt or half-written entry', () => {
    window.localStorage.setItem(KEY, '{not json');
    expect(readOfflineSession()).toBeNull();

    window.localStorage.setItem(KEY, JSON.stringify({ user: { id: 'u-1' } })); // no savedAt
    expect(readOfflineSession()).toBeNull();
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('is dropped on sign-out', () => {
    saveOfflineSession(USER);
    clearOfflineSession();
    expect(readOfflineSession()).toBeNull();
  });

  it('saving nobody erases whoever was there', () => {
    saveOfflineSession(USER);
    saveOfflineSession(null);
    expect(readOfflineSession()).toBeNull();
  });

  it('lives under the `alto` namespace that sign-out sweeps', () => {
    // auth.tsx clears every `alto*` key that isn't device-scoped. If this
    // key ever moved outside that namespace, one person's identity would
    // survive the next person signing in on a shared tablet.
    saveOfflineSession(USER);
    expect(Object.keys(window.localStorage).some((k) => k === KEY)).toBe(true);
    expect(KEY.startsWith('alto.')).toBe(true);
    expect(KEY.startsWith('alto.theme')).toBe(false);
    expect(KEY.startsWith('alto.nav.')).toBe(false);
    expect(KEY.startsWith('alto.pwa.')).toBe(false);
    expect(KEY.startsWith('alto.kiosk.')).toBe(false);
  });
});
