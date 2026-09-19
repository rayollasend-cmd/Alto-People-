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

/** Wrap a dynamic import so the chrome can see it. */
export function trackChunk<T>(load: () => Promise<T>): Promise<T> {
  beginChunk();
  return load().finally(endChunk);
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
