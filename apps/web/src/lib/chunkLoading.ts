import { useSyncExternalStore } from 'react';

/**
 * IS A PAGE STILL ON THE WIRE?
 *
 * Every route in this app is a `React.lazy` chunk (see `lazyNamed` in
 * App.tsx). That means the thing the user waits for on a slow connection is
 * a dynamic `import()`, and React Router knows nothing about it: with no
 * route declaring a `loader`, `useNavigation().state` never leaves `'idle'`,
 * so anything driving off it — the top progress bar did — never fires.
 *
 * This is the missing signal. `lazyNamed` reports each chunk fetch here as
 * it starts and finishes, and the chrome subscribes. It counts rather than
 * flags, so two chunks in flight (a route plus a nested one) only clear the
 * bar when both have landed.
 *
 * React.lazy memoizes, so a chunk already downloaded never re-enters this
 * count — the bar appears on a route's first visit and stays quiet after,
 * which is exactly when there is something to wait for.
 */
let inFlight = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function beginChunk(): void {
  inFlight += 1;
  emit();
}

export function endChunk(): void {
  inFlight = Math.max(0, inFlight - 1);
  emit();
}

/**
 * A page chunk that will never arrive, because the deploy moved on.
 *
 * Every bundle filename carries a content hash, so a deploy replaces the
 * whole set. A tab left open across one still holds the old index.html
 * and asks for names the server no longer has: the import rejects, the
 * route never mounts, and the user gets an error screen on a page that
 * works perfectly — one reload away. Chrome, Firefox and Safari each word
 * the rejection differently, hence the several patterns.
 */
const STALE_BUILD = /dynamically imported module|importing a module script failed|error loading dynamically imported module|failed to fetch/i;

/** One reload per tab per minute — a chunk missing for any other reason
 *  must surface as an error, not as a reload loop. */
const RELOAD_KEY = 'alto:chunk-reload-at';
const RELOAD_COOLDOWN_MS = 60_000;

function reloadOnceForNewBuild(): boolean {
  let last: number;
  try {
    last = Number(window.sessionStorage.getItem(RELOAD_KEY) ?? 0);
  } catch {
    // Private mode / blocked storage: without a memory of the last
    // attempt, reloading risks a loop. Show the error instead.
    return false;
  }
  if (Number.isFinite(last) && Date.now() - last < RELOAD_COOLDOWN_MS) return false;
  try {
    window.sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    return false;
  }
  // The new index.html names the new chunks; everything downstream follows.
  window.location.reload();
  return true;
}

/** Wrap a dynamic import so the chrome can see it. */
export function trackChunk<T>(load: () => Promise<T>): Promise<T> {
  beginChunk();
  return load()
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (STALE_BUILD.test(message) && reloadOnceForNewBuild()) {
        // The page is on its way out. Never settling keeps the error
        // boundary from flashing a failure the user will never act on.
        return new Promise<T>(() => {});
      }
      throw err;
    })
    .finally(endChunk);
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

const getSnapshot = () => inFlight > 0;

/** True while at least one page chunk is still downloading. */
export function useChunkLoading(): boolean {
  // Server snapshot is `false`: nothing is ever in flight during SSR/tests.
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
