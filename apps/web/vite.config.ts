import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Emit `dist/asset-manifest.json` listing the hashed JS/CSS asset URLs
 * Vite produced this build. The service worker fetches this on activate
 * and precaches every entry — so the first navigation into a lazy-
 * loaded page section doesn't pay a network round-trip for its chunk.
 *
 * We deliberately keep the manifest small and stable: just `chunks` (JS
 * + CSS only, no images/fonts) so the SW can iterate without parsing
 * Vite's richer-but-noisier `.vite/manifest.json`. Bumping the contents
 * naturally bumps the SHELL hash, which causes the SW's `activate` step
 * to evict the prior cache and re-precache the new set.
 */
function emitAssetManifest(): Plugin {
  return {
    name: 'alto-asset-manifest',
    apply: 'build',
    writeBundle(options, bundle) {
      const outDir = options.dir ?? path.resolve(__dirname, 'dist');
      // PERF: allowlist, not "everything". The SW used to precache all
      // ~166 chunks (~4 MB — face-api, every admin route, both chart
      // bundles) on every visitor's FIRST load. Precache only the shell +
      // the highest-traffic route chunks; everything else loads (and then
      // SW-caches) on demand.
      const PRECACHE_PATTERNS = [
        /^assets\/main-/,
        /^assets\/react-vendor-/,
        /^assets\/radix-/,
        /^assets\/style-utils-/,
        // Highest-traffic role surfaces.
        /^assets\/AssociateScheduleView-/,
        /^assets\/AssociateTimeOffView-/,
        /^assets\/AssociatePayrollView-/,
        /^assets\/MyTimesheet-/,
        /^assets\/TimeHome-/,
        /^assets\/MeHome-/,
        /^assets\/AssociateInboxView-/,
        /^assets\/SupervisorDashboard-/,
      ];
      const chunks: string[] = [];
      for (const fileName of Object.keys(bundle)) {
        const isAsset = fileName.endsWith('.js') || fileName.endsWith('.css');
        if (!isAsset) continue;
        if (fileName.endsWith('.css') || PRECACHE_PATTERNS.some((re) => re.test(fileName))) {
          chunks.push('/' + fileName);
        }
      }
      // Sort so successive builds with the same inputs produce a stable
      // diff — easier to reason about whether the SW cache should bust.
      chunks.sort();
      const manifest = {
        version: Date.now(),
        chunks,
      };
      fs.writeFileSync(
        path.join(outDir, 'asset-manifest.json'),
        JSON.stringify(manifest, null, 2),
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), emitAssetManifest()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
  build: {
    // Route-level lazy loading (see App.tsx) splits each page into its own
    // chunk. The chunks below pull shared vendor code into stable buckets so
    // it's downloaded once and cached across navigations.
    //
    // Heavy deps that only one route uses (face-api.js for /kiosk,
    // @dnd-kit/core for the template editor) intentionally fall through
    // into their own caller's chunk via the route's lazy() boundary.
    rollupOptions: {
      // Two HTML entries: the main SPA (index.html) and a dedicated kiosk
      // shell (kiosk.html) that statically links the kiosk manifest so the
      // kiosk installs as its own home-screen app. Both load the same
      // /src/main.tsx — the router renders KioskPage at /kiosk — so they
      // share the entry + vendor chunks.
      input: {
        main: path.resolve(__dirname, 'index.html'),
        kiosk: path.resolve(__dirname, 'kiosk.html'),
      },
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          // PERF: tiny styling utils get their own named bucket FIRST.
          // Without this, Rollup's min-chunk-size merging folded clsx
          // (imported by every component via lib/cn.ts) into the recharts
          // chunk — making 321 KB of charting code a blocking dependency
          // of first paint for every visitor.
          if (/\/node_modules\/(clsx|tailwind-merge|class-variance-authority)\//.test(id)) {
            return 'style-utils';
          }
          if (id.includes('@radix-ui')) return 'radix';
          // face-api.js is a 600+ KB ML library used only by the kiosk
          // punch flow. Naming the chunk so the build output isn't a
          // confusing second `index.js`.
          if (id.includes('/face-api.js/')) return 'face-api';
          // recharts is shared between the analytics donut and the
          // compliance scorecard donut — bucket it so it's downloaded
          // once and cached across both routes.
          if (id.includes('/recharts/') || id.includes('/d3-')) {
            return 'recharts';
          }
          // NOTE '/node_modules/react/' (not '/react/') — the loose test
          // used to also match @sentry/react, shipping the whole Sentry
          // SDK in the blocking react-vendor chunk even with no DSN set.
          if (
            id.includes('/node_modules/react/') ||
            id.includes('/react-dom/') ||
            id.includes('/react-router') ||
            id.includes('/scheduler/')
          ) {
            return 'react-vendor';
          }
        },
      },
    },
    // face-api's chunk legitimately exceeds any sane limit (it's gated
    // behind the kiosk route); everything else should stay under ~600 KB
    // raw so a regression like clsx-in-recharts warns at build time.
    chunkSizeWarningLimit: 700,
  },
});
