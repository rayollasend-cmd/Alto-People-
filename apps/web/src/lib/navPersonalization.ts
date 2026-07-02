import { useCallback, useEffect, useState } from 'react';
import type { ModuleKey } from './modules';

/**
 * Sidebar personalization: user-pinned modules + auto-tracked recents.
 *
 * The module list is ~50 entries in four groups; admins live in maybe
 * six of them. Pins are explicit (star on hover in the sidebar); recents
 * are recorded by the Layout on every module navigation. Both persist in
 * localStorage and sync across components in the same tab via a custom
 * event (Sidebar and MobileNav render independently).
 */

const PINNED_KEY = 'alto.nav.pinned.v1';
const RECENTS_KEY = 'alto.nav.recents.v1';
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

function useStoredList(storageKey: string): ModuleKey[] {
  const [list, setList] = useState<ModuleKey[]>(() => readList(storageKey));
  useEffect(() => {
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

export function usePinnedModules(): {
  pinned: ModuleKey[];
  isPinned: (key: ModuleKey) => boolean;
  togglePin: (key: ModuleKey) => void;
} {
  const pinned = useStoredList(PINNED_KEY);
  const togglePin = useCallback((key: ModuleKey) => {
    const current = readList(PINNED_KEY);
    writeList(
      PINNED_KEY,
      current.includes(key) ? current.filter((k) => k !== key) : [...current, key],
    );
  }, []);
  const isPinned = useCallback((key: ModuleKey) => pinned.includes(key), [pinned]);
  return { pinned, isPinned, togglePin };
}

/** Most-recent-first module keys. Callers slice + filter (e.g. drop pinned). */
export function useRecentModules(): ModuleKey[] {
  return useStoredList(RECENTS_KEY);
}

/** Called by the Layout on navigation — NOT a hook. */
export function recordRecentModule(key: ModuleKey): void {
  const current = readList(RECENTS_KEY);
  if (current[0] === key) return; // already freshest — skip the event churn
  const next = [key, ...current.filter((k) => k !== key)].slice(0, MAX_RECENTS_STORED);
  writeList(RECENTS_KEY, next);
}
