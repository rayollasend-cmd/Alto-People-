/**
 * Hover-triggered chunk prefetch registry.
 *
 * Vite splits every lazyNamed() call in App.tsx into its own chunk, so
 * clicking a sidebar link kicks off a chunk fetch BEFORE the page can
 * start its data load — the two run serially when they could run in
 * parallel. Pages where the chunk is fat (RecruitingHome, AdminPayroll)
 * or where the network is slow (3G, kiosks on hotel wifi) feel that
 * gap.
 *
 * Solution: when the user *hovers* a nav link, fire the page's import
 * function. By the time they click, the chunk is already either in
 * cache or in flight, so the navigation only pays the data-fetch cost.
 *
 * We key the registry by the canonical *route path prefix* (e.g.
 * `/payroll`, `/scheduling`). Sidebar matches the link's path against
 * the registry to find a preload function.
 *
 * App.tsx is the only registrar — it calls registerPrefetch() alongside
 * each lazyNamed() it creates. Sidebar (and any other navigator) is the
 * only consumer.
 */

type Loader = () => Promise<unknown>;

/**
 * Optional data prefetch wired alongside a chunk loader. When provided,
 * the prefetch function is called on hover too — typically queryClient.
 * prefetchQuery for the page's primary list, so chunk download and data
 * fetch run in parallel.
 */
type DataPrefetch = () => void | Promise<unknown>;

const registry = new Map<string, Loader>();
const dataPrefetches = new Map<string, DataPrefetch>();
const inflight = new Set<string>();
const dataInflight = new Set<string>();

/**
 * Register a chunk loader against a route path. Call from App.tsx after
 * defining each lazyNamed page. Idempotent — re-registering the same
 * path overwrites the prior loader (rare; useful for HMR).
 */
export function registerPrefetch(path: string, loader: Loader): void {
  registry.set(path, loader);
}

/**
 * Optionally pair a route with a data prefetch (typically queryClient.
 * prefetchQuery). Fires alongside the chunk loader on hover so the
 * page's initial list is already in cache by the time React mounts it.
 *
 * Pass `undefined` to clear an entry (rare).
 */
export function registerDataPrefetch(
  path: string,
  prefetch: DataPrefetch,
): void {
  dataPrefetches.set(path, prefetch);
}

/**
 * Kick off (or no-op) a prefetch for the given path. Safe to call from
 * onMouseEnter / onFocus / onTouchStart — repeated calls coalesce.
 *
 * Matching is "longest prefix wins" so `/payroll/runs/123` will preload
 * the chunk registered at `/payroll` if there's no more specific
 * registration. This matches how React Router resolves the route.
 */
export function prefetchRoute(path: string): void {
  // Direct hit first.
  if (registry.has(path) || dataPrefetches.has(path)) {
    fireAll(path);
    return;
  }
  // Walk parent segments looking for the closest registered loader.
  // We don't trie because the registry is small (~50 entries) and a
  // linear best-match is plenty fast on hover events.
  let best = '';
  const keys = new Set<string>([...registry.keys(), ...dataPrefetches.keys()]);
  for (const key of keys) {
    if ((path === key || path.startsWith(key + '/')) && key.length > best.length) {
      best = key;
    }
  }
  if (best) fireAll(best);
}

function fireAll(key: string): void {
  const loader = registry.get(key);
  if (loader && !inflight.has(key)) {
    inflight.add(key);
    loader().catch(() => {
      inflight.delete(key);
    });
  }
  const data = dataPrefetches.get(key);
  if (data && !dataInflight.has(key)) {
    dataInflight.add(key);
    // Data prefetches are best-effort. Errors are swallowed; the page's
    // own useQuery will hit the same error path and surface it.
    Promise.resolve(data()).catch(() => {
      // Clear so a subsequent retry can fire again.
      dataInflight.delete(key);
    });
  }
}
