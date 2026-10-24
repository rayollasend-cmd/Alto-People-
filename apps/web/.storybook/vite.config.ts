import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Storybook's own Vite config — the app's (vite.config.ts) is not used.
 *
 * The app's config is a production build: two HTML entries (main + kiosk),
 * manual vendor chunks, a service-worker asset manifest written into dist/,
 * source-map deletion and the Sentry upload. None of that belongs in a
 * component workshop, and the asset manifest would land in Storybook's
 * output. What stories need from it is the React plugin and the `@` alias.
 * Tailwind comes from postcss.config.js, which Vite finds from apps/web.
 *
 * vitest.storybook.config.ts (the story tests) extends this file, so the
 * workshop and its tests compile stories the same way.
 */
const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  // apps/web/public is the app's (icons, the service worker, 6.5 MB of
  // face models): no story reads it, so it stays out of storybook-static.
  publicDir: false,
  resolve: {
    alias: {
      '@': path.resolve(dirname, '../src'),
    },
  },
  // Pre-bundled up front. Discovered mid-run instead, Vite re-optimizes and
  // reloads the page under the story tests ("Vite unexpectedly reloaded a
  // test"), and every story in flight fails on a cold cache — which is
  // every CI run.
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'react-dom/client',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      'react-router-dom',
      '@tanstack/react-query',
      '@tanstack/react-virtual',
      '@radix-ui/react-checkbox',
      '@radix-ui/react-dialog',
      '@radix-ui/react-dropdown-menu',
      '@radix-ui/react-label',
      '@radix-ui/react-select',
      '@radix-ui/react-slot',
      '@radix-ui/react-tooltip',
      'recharts',
      'lucide-react',
      'sonner',
      'clsx',
      'tailwind-merge',
      'class-variance-authority',
      'zod',
    ],
  },
});
