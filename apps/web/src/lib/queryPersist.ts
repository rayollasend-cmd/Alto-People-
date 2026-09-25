import {
  persistQueryClientRestore,
  persistQueryClientSubscribe,
} from '@tanstack/react-query-persist-client';
import type { PersistedClient, Persister } from '@tanstack/react-query-persist-client';
import type { Query } from '@tanstack/react-query';
import { queryClient } from './queryClient';

/**
 * THE CACHE SURVIVES THE APP CLOSING.
 *
 * Until now "offline" meant the shell loaded and every page underneath it
 * filled with error banners: the service worker serves the chunks, but the
 * API is network-only and the query cache lived in memory, so reopening the
 * installed app without signal showed chrome and nothing else. Someone
 * checking tomorrow's shift in a basement got a wall of red.
 *
 * So the cache is written to IndexedDB — not localStorage, which is
 * synchronous (it would block the main thread on every write) and capped
 * around 5MB, which a people directory clears on its own.
 *
 * Three rules keep it honest:
 *
 *   1. It is keyed by user id. Two people sharing a store tablet never
 *      restore into each other's cache; the key simply doesn't match.
 *   2. Nothing older than MAX_AGE_MS is restored. Stale-but-labelled beats
 *      absent; stale-and-silent does not.
 *   3. Only successful queries are written. A cached error is worse than
 *      no cache, and half-finished fetches would restore as permanent
 *      loading states.
 *
 * Sign-out drops the whole database (see `clearPersistedQueries`, called
 * from AuthProvider alongside the localStorage purge).
 */

const DB_NAME = 'alto-query-cache';
const STORE = 'cache';
/** Matches the offline session window — they go stale together. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Don't write on every keystroke-driven refetch. */
const THROTTLE_MS = 3_000;

/**
 * Bumping this invalidates every persisted cache. Change it when a query's
 * shape changes in a way that would make old entries wrong rather than
 * merely stale — restoring a renamed field as `undefined` is a bug that
 * only reproduces for users who were here before the deploy.
 */
// v3: the People prefetch had persisted ['directory', {}] as a bare array.
const APP_CACHE_VERSION = 'v3';

/**
 * Queries that never touch the disk.
 *
 * The persisted cache exists so a schedule survives a basement; it is not
 * a place for E-Verify cases, I-9 records, uploaded documents,
 * garnishments, pay, tax forms or anything holding an SSN or bank detail.
 * Those load fresh every time. Matched against every string segment of the
 * key, so a domain prefix ('payroll', 'documents') and a component name
 * ('GarnishmentsView', 'CaseDrawer') are both caught; erring wide is the
 * safe direction. APP_CACHE_VERSION moved to v2 with this rule so caches
 * written before it are dropped on restore rather than read.
 */
const SENSITIVE_KEY = /everify|casedrawer|i-?9\b|i9(tab|task|docs)|document|garnish|pay|ssn|w-?4|tax|comp-records|compensation|external-payments|bank|payout|direct-?deposit|paystub/i;
export function isSensitiveQueryKey(queryKey: readonly unknown[]): boolean {
  return queryKey.some((part) => typeof part === 'string' && SENSITIVE_KEY.test(part));
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | undefined> {
  return openDb()
    .then(
      (db) =>
        new Promise<T | undefined>((resolve, reject) => {
          const tx = db.transaction(STORE, mode);
          const req = fn(tx.objectStore(STORE));
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
          tx.oncomplete = () => db.close();
        }),
    )
    // Private windows, blocked storage, quota — persistence is a bonus,
    // never a requirement. The app runs identically without it.
    .catch(() => undefined);
}

function idbPersister(userId: string): Persister {
  const key = `client:${userId}`;
  // React Query calls persistClient on every cache mutation — a list page
  // refetching six queries would otherwise mean six serializations of the
  // whole cache. Coalesce into one write per THROTTLE_MS, always keeping
  // the newest snapshot.
  let pending: PersistedClient | null = null;
  let timer: number | null = null;
  const flush = () => {
    timer = null;
    const next = pending;
    pending = null;
    if (next) void withStore('readwrite', (s) => s.put(next, key));
  };
  return {
    persistClient: (client: PersistedClient) => {
      pending = client;
      if (timer === null) timer = window.setTimeout(flush, THROTTLE_MS);
      return Promise.resolve();
    },
    restoreClient: async () =>
      (await withStore<PersistedClient>('readonly', (s) => s.get(key))) ?? undefined,
    removeClient: async () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      pending = null;
      await withStore('readwrite', (s) => s.delete(key));
    },
  };
}

/**
 * Put the saved cache back, before anything can ask for data.
 *
 * Ordering is the whole point. The first version subscribed and restored
 * together once the user was known — which is after `/auth/me`, and by then
 * every page query had already fired, failed offline, and painted its error
 * state. Restoring on top of that left the tiles blank and an error toast on
 * screen with perfectly good data sitting in IndexedDB.
 *
 * So main.tsx awaits this before the first render, using the user id from
 * the offline session (localStorage, synchronous). On a normal online boot
 * it costs one IDB read behind the branded splash that is already showing.
 */
export async function restorePersistedQueries(userId: string): Promise<void> {
  try {
    await persistQueryClientRestore({
      queryClient,
      persister: idbPersister(userId),
      maxAge: MAX_AGE_MS,
      buster: APP_CACHE_VERSION,
    });
  } catch {
    /* nothing saved, or storage unavailable */
  }
}

/**
 * Keep mirroring the cache to disk for this user. Returns a function that
 * stops it — call it when the user changes.
 */
export function startQueryPersistence(userId: string): () => void {
  try {
    return persistQueryClientSubscribe({
      queryClient,
      persister: idbPersister(userId),
      buster: APP_CACHE_VERSION,
      dehydrateOptions: {
        shouldDehydrateQuery: (query: Query) =>
          query.state.status === 'success' &&
          query.state.data !== undefined &&
          !isSensitiveQueryKey(query.queryKey),
      },
    });
  } catch {
    /* persistence unavailable — carry on in memory */
    return () => {};
  }
}

/**
 * Drop every cached answer on this device — sign-out, a dead session, a
 * role switch. The in-memory cache goes too: the next person on a shared
 * tablet signs in without a reload, and a warm cache would show them the
 * previous person's pages until each query refetched.
 */
export function clearPersistedQueries(): Promise<void> {
  queryClient.clear();
  return new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}
