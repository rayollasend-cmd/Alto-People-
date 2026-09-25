import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { initSentry } from '@/lib/sentry';
import { watchHistoryChurn } from '@/lib/historyChurn';
import { readOfflineSession } from '@/lib/offlineSession';
import { restorePersistedQueries } from '@/lib/queryPersist';
import { installStaleBuildGuard } from '@/lib/chunkLoading';

// Initialise error tracking before any render path can throw. No-op
// when VITE_SENTRY_DSN is unset; safe in dev.
initSentry();
// After initSentry so the capture has somewhere to go, and before React
// mounts so the very first navigation is counted. Diagnostic only — see
// lib/historyChurn for why the SecurityError's own stack is useless.
watchHistoryChurn();

import { router } from './App';
import { AuthProvider } from '@/lib/auth';
import { I18nProvider } from '@/lib/i18n';
import { ThemeProvider } from '@/lib/theme';
import { DensityProvider } from '@/lib/density';
import { PageTitleProvider } from '@/lib/pageTitle';
import { ConfirmProvider } from '@/lib/confirm';
import { StoreScopeProvider } from '@/lib/storeScope';
import { Toaster, toast } from '@/components/ui/Toaster';
import { GlobalErrorBoundary } from '@/components/GlobalErrorBoundary';

// TanStack Query — caches API reads so back-nav and revisits within
// a session are instant. Defaults are tuned for our cold-start-prone
// Neon Free tier: keep cached data for 5 min, mark fresh for 30 s,
// don't refetch on window focus (too aggressive when the DB might be
// suspended), and retry only once instead of three times.
import { queryClient } from '@/lib/queryClient';

// Self-hosted variable fonts. Both ship as a single woff2 covering the
// full weight range, served from our own bundle — no third-party CDN
// hop, no FOUT from Google Fonts, and the browser caches them with the
// rest of the app.
import '@fontsource-variable/geist';
import '@fontsource-variable/cormorant-garamond';

import './index.css';

// Side-effect import: attaches the `beforeinstallprompt` listener at module
// load time so the event isn't lost if it fires before the InstallAppButton
// component mounts (e.g. while the user is still on /login).
import '@/lib/installPrompt';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found');

// Phase 68 — set the theme attribute before React renders so the first
// paint already has the right colors. This avoids a brief flash of dark
// when the user has light selected (or vice versa). Mirrors the resolve
// logic in lib/theme.tsx: no stored choice or 'system' follows the OS
// (`prefers-color-scheme`); explicit light/dark map 1:1. Also swaps the
// theme-color meta so the browser/status-bar chrome matches from frame 1.
try {
  const stored = window.localStorage.getItem('alto.theme');
  let resolved: 'light' | 'dark';
  if (stored === 'light' || stored === 'dark') {
    resolved = stored;
  } else {
    resolved = window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }
  document.documentElement.dataset.theme = resolved;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', resolved === 'dark' ? '#0B1832' : '#F8FAFC');
} catch {
  document.documentElement.dataset.theme = 'dark';
}

// Installed vs. browser tab, decided before first paint so the tab bar
// never renders with the wrong bottom padding and then corrects itself.
//
// Only an installed app actually reaches the bottom of the screen. In a
// browser tab Safari's toolbar is already sitting over the home indicator,
// so reserving the safe-area inset there stacks a dead strip on top of the
// browser's own chrome. navigator.standalone is the iOS-specific half —
// Safari has been unreliable about the display-mode media feature for
// home-screen apps, and the Tailwind `standalone:` variant matches either.
try {
  const installed =
    (window.navigator as { standalone?: boolean }).standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches;
  if (installed) document.documentElement.classList.add('pwa-standalone');
} catch {
  /* matchMedia unavailable — treat as a browser tab, which reserves nothing */
}

// Phase 69 — same trick for density.
try {
  const stored = window.localStorage.getItem('alto.density');
  if (stored === 'compact' || stored === 'comfortable') {
    document.documentElement.dataset.density = stored;
  } else {
    document.documentElement.dataset.density = 'comfortable';
  }
} catch {
  document.documentElement.dataset.density = 'comfortable';
}

// Phase 98 — register the service worker for PWA install + offline shell.
// Skipped in dev so we don't pollute the dev experience with stale caches.
//
// Updates are user-controlled: when a new worker finishes installing while
// an old one is running, we toast "New version available" and only skip
// waiting (then reload) when the user opts in — deploys used to swap the
// bundle silently mid-session.
// A chunk that vanished with a deploy reloads the tab once, wherever the
// failure surfaces — a route import, a preloaded dependency, a component's
// own import(). Installed before anything can load a chunk.
installStaleBuildGuard();

// The shell loads a few hundred small chunks; the default resource-timing
// buffer (250) drops the later ones, and the service-worker warm-up below
// reads that buffer.
try {
  performance.setResourceTimingBufferSize(2000);
} catch {
  // Not supported — the warm-up just sees fewer entries.
}

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((reg) => {
        const promptUpdate = (worker: ServiceWorker) => {
          toast('A new version of Alto is ready.', {
            duration: Infinity,
            action: {
              label: 'Reload',
              onClick: () => worker.postMessage('SKIP_WAITING'),
            },
          });
        };
        // A worker may already be parked in waiting from a previous visit.
        if (reg.waiting && navigator.serviceWorker.controller) {
          promptUpdate(reg.waiting);
        }
        reg.addEventListener('updatefound', () => {
          const installing = reg.installing;
          if (!installing) return;
          installing.addEventListener('statechange', () => {
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              promptUpdate(installing);
            }
          });
        });
        // The browser only re-checks sw.js on a NAVIGATION (or ~daily) —
        // and this is a PWA people keep open all day with SPA routing
        // that never navigates. Post-deploy, a long-lived session never
        // learned an update existed and looked stale until a manual
        // hard-refresh. Actively check: every 15 minutes, and whenever
        // the tab regains focus/visibility (the "back from lunch" case).
        const check = () => {
          reg.update().catch(() => {});
        };
        setInterval(check, 15 * 60_000);
        window.addEventListener('focus', check);
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') check();
        });
      })
      .catch(() => {
        // Silent fail — SW is best-effort enhancement.
      });
    // Everything this page fetched before the worker took control went
    // around its fetch handler, so on a first install the cache held the
    // precache list and nothing else — the shell's own chunks (Layout, the
    // command palette) were missing, and the offline fallback booted the
    // shell straight into "Something went wrong". Hand the worker the list.
    // Only a page that started uncontrolled has anything to hand over; a
    // controlled page's fetches already pass through the worker. Entries
    // keep arriving while the worker installs (the route chunk lands about
    // then), so this watches for a minute rather than snapshotting once.
    if (!navigator.serviceWorker.controller && 'PerformanceObserver' in window) {
      navigator.serviceWorker.ready
        .then((reg) => {
          const sent = new Set<string>();
          let pending: string[] = [];
          let timer: number | undefined;
          const flush = () => {
            timer = undefined;
            const urls = pending;
            pending = [];
            if (urls.length > 0) reg.active?.postMessage({ type: 'CACHE_URLS', urls });
          };
          const observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              let pathname: string;
              try {
                pathname = new URL(entry.name).pathname;
              } catch {
                continue;
              }
              if (!pathname.startsWith('/assets/') || sent.has(pathname)) continue;
              sent.add(pathname);
              pending.push(pathname);
            }
            if (pending.length > 0 && timer === undefined) timer = window.setTimeout(flush, 500);
          });
          observer.observe({ type: 'resource', buffered: true });
          window.setTimeout(() => {
            observer.disconnect();
            flush();
          }, 60_000);
        })
        .catch(() => {});
    }
    // The moment the new worker takes over, load the new bundle. The
    // hadController guard matters: sw.js calls clients.claim() on
    // activate, so the very FIRST installation also fires
    // controllerchange on a page that's already current — reloading
    // there would flash-restart every brand-new visitor.
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading) return;
      reloading = true;
      window.location.reload();
    });
  });
}

/**
 * Put the saved query cache back BEFORE the first render.
 *
 * Ordering is everything here: pages fire their queries on mount, so a
 * restore that lands even a tick late arrives after those queries have
 * already failed offline and painted their error states — blank tiles with
 * good data sitting unused in IndexedDB. Reading the remembered user from
 * localStorage is synchronous, so we know whose cache to open without
 * waiting on /auth/me.
 *
 * Capped at 1.5s: persistence is a bonus and must never hold the app
 * hostage to a wedged IndexedDB. index.html is already showing the branded
 * splash, so on a normal boot this read is invisible.
 */
async function restoreCacheBeforeRender(): Promise<void> {
  const remembered = readOfflineSession();
  if (!remembered) return;
  await Promise.race([
    restorePersistedQueries(remembered.id),
    new Promise<void>((resolve) => window.setTimeout(resolve, 1500)),
  ]);
}

void restoreCacheBeforeRender().finally(() => {
ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <GlobalErrorBoundary>
      {/* Route transitions are pure CSS (see Layout's route-fade class);
          index.css flattens all CSS animations under
          prefers-reduced-motion, so no JS animation switch is needed. */}
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <ThemeProvider>
            <DensityProvider>
              <AuthProvider>
                <StoreScopeProvider>
                  <PageTitleProvider>
                    <ConfirmProvider>
                      {/* React Router 7 wraps router state updates in
                          React.startTransition by default (the v6
                          v7_startTransition flag). That is what lets the
                          page you're on stay painted while the next one's
                          chunk streams: Layout's Suspense boundary already
                          has content, and inside a transition React keeps
                          showing it instead of swapping to a fallback.
                          Without it every navigation blanked to a skeleton
                          even when the next page was 80ms away. */}
                      <RouterProvider router={router} />
                      <Toaster />
                    </ConfirmProvider>
                  </PageTitleProvider>
                </StoreScopeProvider>
              </AuthProvider>
            </DensityProvider>
          </ThemeProvider>
        </I18nProvider>
      </QueryClientProvider>
    </GlobalErrorBoundary>
  </React.StrictMode>
);
});
