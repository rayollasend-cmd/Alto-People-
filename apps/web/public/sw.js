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
const CACHE_NAME = 'alto-shell-v13';
const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  // Kiosk installs as its own home-screen app (start_url /kiosk) from a
  // dedicated HTML shell; cache it + its manifest + badged icons so a
  // re-launch works offline.
  '/kiosk.html',
  '/kiosk.webmanifest',
  '/kiosk-icon-192.png',
  '/kiosk-icon-512.png',
  '/kiosk-apple-touch-icon.png',
  '/favicon.svg',
  '/favicon-32.png',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
];

// Fetch the build's asset manifest (emitted by the vite plugin in
// vite.config.ts) and precache every JS/CSS chunk listed there. This
// makes the FIRST navigation into any lazy-loaded page section instant
// instead of paying a network round-trip for the chunk. Failures are
// silent — if the manifest is missing (dev, or a build without the
// plugin) the cache-on-first-fetch fallback below still works.
async function precacheChunksFromManifest(cache) {
  try {
    const res = await fetch('/asset-manifest.json', {
      credentials: 'same-origin',
      cache: 'no-cache',
    });
    if (!res.ok) return;
    const manifest = await res.json();
    const chunks = Array.isArray(manifest?.chunks) ? manifest.chunks : [];
    // Don't fail the whole install if one chunk is missing — that can
    // happen mid-deploy on Railway when index.html lands before all
    // assets are uploaded. Best-effort each entry.
    await Promise.all(
      chunks.map((url) =>
        fetch(url, { credentials: 'same-origin' })
          .then((r) => (r.ok ? cache.put(url, r) : null))
          .catch(() => null),
      ),
    );
  } catch {
    // No manifest, no precache — fine, the cache-first fetch handler
    // below will still cache chunks lazily as the user encounters them.
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(async (cache) => {
        await Promise.all(
          SHELL.map((url) =>
            fetch(url, { credentials: 'same-origin' })
              .then((res) => (res.ok ? cache.put(url, res) : null))
              .catch(() => null),
          ),
        );
        await precacheChunksFromManifest(cache);
      })
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

// ---- Web push -------------------------------------------------------------
// Payload contract (set by the API's push sender): JSON
//   { title, body, url? }  — url is a relative in-app path to open on tap.
// Everything is defensive: a malformed payload still shows SOMETHING so a
// user-visible push is never silently dropped (required by Chrome anyway
// when userVisibleOnly is true).

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Alto People', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Alto People';
  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: data.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        // Focus an existing app window and navigate it, else open fresh.
        for (const client of clientList) {
          if ('focus' in client) {
            client.focus();
            if ('navigate' in client) return client.navigate(url);
            return undefined;
          }
        }
        return self.clients.openWindow(url);
      }),
  );
});

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
        .catch(() => {
          // Offline: serve the matching cached shell. The kiosk has its own
          // HTML entry (with the kiosk manifest in its head), so /kiosk
          // navigations fall back to it rather than the main index.html.
          const fallback =
            url.pathname === '/kiosk' || url.pathname.startsWith('/kiosk/')
              ? '/kiosk.html'
              : '/';
          return caches
            .match(req)
            .then((cached) => cached || caches.match(fallback) || Response.error());
        }),
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
