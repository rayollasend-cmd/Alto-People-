import { useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './api';
import { useAuth } from './auth';
import type { ModuleKey } from './modules';

/**
 * Sidebar personalization: user-pinned modules + auto-tracked recents.
 *
 * PINS are server-side (User.pinnedModules) so favorites follow the user
 * across devices. The localStorage-only version lost them two ways —
 * the sign-out sweep deleted the key (any sign-out or session expiry
 * "unpinned everything by itself"), and iOS evicts site storage for
 * installed web apps after ~7 days idle — and never synced anywhere.
 * localStorage remains only as a per-user fast-start cache so the
 * sidebar renders pinned sections instantly while the query refreshes.
 *
 * RECENTS stay device-local by design (your phone's recents aren't your
 * desktop's), but are now keyed per user so a shared store tablet never
 * shows one associate's trail to the next.
 *
 * Key prefix note: everything here lives under `alto.nav.` which is in
 * auth's DEVICE_SCOPED_PREFIXES (survives sign-out) — safe because every
 * key embeds the userId.
 */

const PIN_CACHE_PREFIX = 'alto.nav.pinned.v2.';
const RECENTS_PREFIX = 'alto.nav.recents.v2.';
const LEGACY_PINNED_KEY = 'alto.nav.pinned.v1';
const LEGACY_RECENTS_KEY = 'alto.nav.recents.v1';
const CHANGE_EVENT = 'alto:nav-personalization';
const MAX_RECENTS_STORED = 8;

function readList(storageKey: string): ModuleKey[] {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is ModuleKey => typeof x === 'string');
    }
  } catch {
    /* corrupt storage → empty */
  }
  return [];
}

function writeList(storageKey: string, list: ModuleKey[]): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(list));
  } catch {
    /* best-effort */
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

const getNavPins = () => apiFetch<{ pinned: ModuleKey[] }>('/auth/me/nav-pins');
const putNavPins = (pinned: ModuleKey[]) =>
  apiFetch<void>('/auth/me/nav-pins', { method: 'PUT', body: { pinned } });

export function usePinnedModules(): {
  pinned: ModuleKey[];
  isPinned: (key: ModuleKey) => boolean;
  togglePin: (key: ModuleKey) => void;
} {
  const { user } = useAuth();
  const qc = useQueryClient();
  const userId = user?.id ?? null;
  const cacheKey = userId ? `${PIN_CACHE_PREFIX}${userId}` : null;

  const { data } = useQuery({
    queryKey: ['nav-pins', userId],
    enabled: userId !== null,
    staleTime: 60_000,
    // Fast start: render the last-known pins for THIS user immediately;
    // the fetch reconciles with the server truth.
    initialData: cacheKey ? { pinned: readList(cacheKey) } : undefined,
    initialDataUpdatedAt: 0, // always refetch — initialData is just paint
    queryFn: async () => {
      const server = await getNavPins();
      // One-time migration: a device carrying legacy local-only pins for
      // a user with no server pins seeds the server from them, so nobody
      // loses the favorites they had before pins went server-side.
      const legacy = readList(LEGACY_PINNED_KEY);
      if (server.pinned.length === 0 && legacy.length > 0) {
        await putNavPins(legacy).catch(() => undefined);
        try {
          window.localStorage.removeItem(LEGACY_PINNED_KEY);
        } catch {
          /* best-effort */
        }
        if (cacheKey) writeList(cacheKey, legacy);
        return { pinned: legacy };
      }
      if (cacheKey) writeList(cacheKey, server.pinned);
      return server;
    },
  });

  const pinned = data?.pinned ?? [];

  const togglePin = useCallback(
    (key: ModuleKey) => {
      if (!userId) return;
      const current =
        (qc.getQueryData<{ pinned: ModuleKey[] }>(['nav-pins', userId])?.pinned) ?? [];
      const next = current.includes(key)
        ? current.filter((k) => k !== key)
        : [...current, key];
      // Optimistic: the star flips instantly; the PUT persists. On failure
      // we refetch so the UI settles back to server truth.
      qc.setQueryData(['nav-pins', userId], { pinned: next });
      if (cacheKey) writeList(cacheKey, next);
      putNavPins(next).catch(() => {
        void qc.invalidateQueries({ queryKey: ['nav-pins', userId] });
      });
    },
    [qc, userId, cacheKey],
  );

  const isPinned = useCallback((key: ModuleKey) => pinned.includes(key), [pinned]);
  return { pinned, isPinned, togglePin };
}

/** Most-recent-first module keys for the signed-in user on THIS device. */
export function useRecentModules(): ModuleKey[] {
  const { user } = useAuth();
  const storageKey = user ? `${RECENTS_PREFIX}${user.id}` : null;
  const [list, setList] = useState<ModuleKey[]>(() =>
    storageKey ? readList(storageKey) : [],
  );
  useEffect(() => {
    if (!storageKey) {
      setList([]);
      return;
    }
    setList(readList(storageKey));
    const sync = () => setList(readList(storageKey));
    window.addEventListener(CHANGE_EVENT, sync);
    window.addEventListener('storage', sync); // other tabs
    return () => {
      window.removeEventListener(CHANGE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, [storageKey]);
  return list;
}

/** Called by the Layout on navigation — NOT a hook. */
export function recordRecentModule(key: ModuleKey, userId: string): void {
  const storageKey = `${RECENTS_PREFIX}${userId}`;
  // Legacy un-scoped recents fold into the user's list once, then clear.
  const legacy = readList(LEGACY_RECENTS_KEY);
  const current = readList(storageKey);
  const base = current.length === 0 && legacy.length > 0 ? legacy : current;
  if (legacy.length > 0) {
    try {
      window.localStorage.removeItem(LEGACY_RECENTS_KEY);
    } catch {
      /* best-effort */
    }
  }
  if (base[0] === key && base === current) return; // already freshest
  const next = [key, ...base.filter((k) => k !== key)].slice(0, MAX_RECENTS_STORED);
  writeList(storageKey, next);
}
