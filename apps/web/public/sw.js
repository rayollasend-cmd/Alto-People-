// Phase 98 — PWA service worker.
// Strategy:
//   - App shell (HTML / icons / manifest): cache-first, falling back to
//     network. This gives users an immediate "you're offline" UX even on
//     the first navigation after losing connectivity.
//   - JS / CSS bundles (hashed filenames): cache-first; old hashes evict
//     when SW activates.
//   - API requests (/api, /clients, /onboarding, etc): network-only —
//     never cache business data, since it'd diverge from the source of
//     truth and potentially leak across user sessions.

// Bumped when the SHELL list or any cached page chrome changes so the
// activate handler evicts the previous shell cache instead of leaving
// stale entries (e.g. the old Login page with the picture logo above
// "Alto People", or the now-broken 125x91 logo.png) lying around
// indefinitely.
const CACHE_NAME = 'alto-shell-v7';
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

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) {
        // Background revalidate so a stale shell gets fresh on next load.
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
          if (res && res.ok && (req.destination === 'script' || req.destination === 'style' || req.destination === 'document' || req.destination === 'image')) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, clone));
          }
          return res;
        })
        .catch(() => {
          // Offline + nothing cached: fall back to the cached shell so
          // the SPA can render an offline state.
          if (req.destination === 'document') {
            return caches.match('/');
          }
          return Response.error();
        });
    }),
  );
});
