import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { router } from './App';
import { AuthProvider } from '@/lib/auth';
import { ThemeProvider } from '@/lib/theme';
import { DensityProvider } from '@/lib/density';
import { PageTitleProvider } from '@/lib/pageTitle';
import './index.css';

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

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <ThemeProvider>
      <DensityProvider>
        <AuthProvider>
          <PageTitleProvider>
            <RouterProvider router={router} />
          </PageTitleProvider>
        </AuthProvider>
      </DensityProvider>
    </ThemeProvider>
  </React.StrictMode>
);
