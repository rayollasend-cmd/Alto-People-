// Phase 98 — PWA service worker.
// Strategy:
//   - Navigation requests (HTML documents): NETWORK-FIRST, cache only
//     as offline fallback. The HTML references content-hashed JS/CSS
//     bundles, and serving a stale HTML after a deploy points the
//     browser at chunk filenames that no longer exist on the server —
//     which manifests as "Something went wrong" because the lazy
//     import returns the SPA-fallback HTML instead of JS.
//   - Other static assets (hashed JS/CSS, icons, fonts): cache-first
//     with background revalidate. Safe because the filename embeds a
//     content hash; old entries naturally evict when the activate
//     handler wipes the prior cache.
//   - API requests (/api, /clients, /onboarding, etc): network-only —
//     never cache business data, since it'd diverge from the source of
//     truth and potentially leak across user sessions.

// Bumped when the SHELL list or caching strategy changes so the
// activate handler evicts the previous cache instead of leaving stale
// entries (e.g. an old index.html with chunk hashes from a prior
// deploy that no longer exist on the server) lying around.
const CACHE_NAME = 'alto-shell-v8';
const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/favicon-32.png',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        Promise.all(
          SHELL.map((url) =>
            fetch(url, { credentials: 'same-origin' })
              .then((res) => (res.ok ? cache.put(url, res) : null))
              .catch(() => null),
          ),
        ),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

function isApiPath(url) {
  // Heuristic: anything that looks like a JSON API call should bypass
  // the cache. Adjust if the API origin diverges.
  const p = url.pathname;
  return (
    p.startsWith('/auth') ||
    p.startsWith('/clients') ||
    p.startsWith('/onboarding') ||
    p.startsWith('/time') ||
    p.startsWith('/payroll') ||
    p.startsWith('/scheduling') ||
    p.startsWith('/recruiting') ||
    p.startsWith('/benefits') ||
    p.startsWith('/comp') ||
    p.startsWith('/reports') ||
    p.startsWith('/reimbursements') ||
    p.startsWith('/integrations') ||
    p.startsWith('/api')
  );
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (isApiPath(url)) return; // Network-only — let the page handle it.

  // Navigation requests (HTML documents) use network-first. A successful
  // network response always replaces the cached copy so post-deploy
  // refreshes pick up the new chunk hashes. Cached HTML only kicks in
  // when the network is unreachable, giving the SPA an offline shell.
  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, clone));
          }
          return res;
        })
        .catch(() =>
          caches.match(req).then((cached) => cached || caches.match('/') || Response.error()),
        ),
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) {
        // Background revalidate so a stale entry refreshes on next load.
        fetch(req)
          .then((res) => {
            if (res && res.ok) {
              caches.open(CACHE_NAME).then((c) => c.put(req, res.clone()));
            }
          })
          .catch(() => {});
        return cached;
      }
      return fetch(req)
        .then((res) => {
          if (res && res.ok && (req.destination === 'script' || req.destination === 'style' || req.destination === 'image' || req.destination === 'font')) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, clone));
          }
          return res;
        })
        .catch(() => Response.error());
    }),
  );
});
