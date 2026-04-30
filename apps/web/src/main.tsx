import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { router } from './App';
import { AuthProvider } from '@/lib/auth';
import { ThemeProvider } from '@/lib/theme';
import { DensityProvider } from '@/lib/density';
import { PageTitleProvider } from '@/lib/pageTitle';
import { ConfirmProvider } from '@/lib/confirm';
import { Toaster } from '@/components/ui/Toaster';

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
// when the user has light selected (or vice versa).
try {
  const stored = window.localStorage.getItem('alto.theme');
  if (stored === 'light' || stored === 'dark') {
    document.documentElement.dataset.theme = stored;
  } else {
    document.documentElement.dataset.theme = 'dark';
  }
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
  </React.StrictMode>
);
