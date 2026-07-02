import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { initSentry } from '@/lib/sentry';

// Initialise error tracking before any render path can throw. No-op
// when VITE_SENTRY_DSN is unset; safe in dev.
initSentry();

import { router } from './App';
import { AuthProvider } from '@/lib/auth';
import { ThemeProvider } from '@/lib/theme';
import { DensityProvider } from '@/lib/density';
import { PageTitleProvider } from '@/lib/pageTitle';
import { ConfirmProvider } from '@/lib/confirm';
import { Toaster } from '@/components/ui/Toaster';
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
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Silent fail — SW is best-effort enhancement.
    });
  });
}

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <GlobalErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <DensityProvider>
            <AuthProvider>
              <PageTitleProvider>
                <ConfirmProvider>
                  <RouterProvider router={router} />
                  <Toaster />
                </ConfirmProvider>
              </PageTitleProvider>
            </AuthProvider>
          </DensityProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </GlobalErrorBoundary>
  </React.StrictMode>
);
