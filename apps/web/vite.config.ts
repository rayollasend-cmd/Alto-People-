import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { sentryVitePlugin } from '@sentry/vite-plugin';
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
/**
 * Preload the Latin font subsets.
 *
 * Fonts are self-hosted via @fontsource-variable/*, so the browser only
 * discovers them after it has fetched and parsed the CSS — an extra round
 * trip before any text renders in the real face. It shows up most on /login,
 * where the logo uses the display font.
 *
 * Only the `latin` subsets are preloaded. Each @font-face carries a
 * unicode-range, so latin-ext / cyrillic / vietnamese are fetched only if a
 * character in those ranges is actually rendered — preloading them would
 * download ~130 KB that almost no session uses.
 *
 * Filenames are content-hashed per build, so the hrefs are read out of the
 * bundle at emit time rather than hardcoded in index.html.
 */
function preloadLatinFonts(): Plugin {
  const LATIN_SUBSET = /(geist|cormorant-garamond)-latin-wght-normal-[^/]*\.woff2$/;
  return {
    name: 'alto-preload-latin-fonts',
    apply: 'build',
    enforce: 'post',
    transformIndexHtml(html, ctx) {
      if (!ctx.bundle) return html;
      const fonts = Object.keys(ctx.bundle).filter((f) => LATIN_SUBSET.test(f));
      return {
        html,
        tags: fonts.map((fileName) => ({
          tag: 'link',
          attrs: {
            rel: 'preload',
            as: 'font',
            type: 'font/woff2',
            href: `/${fileName}`,
            // Required even same-origin: fonts are always fetched in CORS
            // mode, and without it the preload is discarded and refetched.
            crossorigin: '',
          },
          injectTo: 'head-prepend' as const,
        })),
      };
    },
  };
}

function emitAssetManifest(): Plugin {
  let version = 0;
  let outDir = path.resolve(__dirname, 'dist');
  return {
    name: 'alto-asset-manifest',
    apply: 'build',
    writeBundle(options, bundle) {
      outDir = options.dir ?? path.resolve(__dirname, 'dist');
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
        // The shell's own lazy pieces: without these the offline fallback
        // shell boots and then fails on its first import.
        /^assets\/Layout-/,
        /^assets\/CommandPalette-/,
        /^assets\/Tooltip-/,
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
      version = Date.now();
      const manifest = {
        version,
        chunks,
      };
      fs.writeFileSync(
        path.join(outDir, 'asset-manifest.json'),
        JSON.stringify(manifest, null, 2),
      );
    },
    // Stamp the service worker with the same version, AFTER Vite has copied
    // public/ into dist. A worker whose bytes never change is never
    // reinstalled, so its precache stayed frozen at whatever build was live
    // the day it first installed; stamping makes every deploy a new worker
    // that precaches its own build and drops the previous one on activate.
    closeBundle() {
      const swPath = path.join(outDir, 'sw.js');
      if (!version || !fs.existsSync(swPath)) return;
      const src = fs.readFileSync(swPath, 'utf8');
      fs.writeFileSync(swPath, src.replace('__ALTO_BUILD__', String(version)));
    },
  };
}

/**
 * Deletes the emitted .map files when there is no Sentry upload to feed.
 *
 * `sourcemap: 'hidden'` writes maps and omits the //# sourceMappingURL
 * comment, so a browser never asks for them — but the files would still
 * sit in dist, downloadable by anyone who guessed a name. When the Sentry
 * plugin runs it removes them itself after upload; when it is skipped (no
 * auth token: local builds, CI without secrets) this does the same, so a
 * build without the token ships exactly what it shipped before.
 */
function dropSourcemaps(): Plugin {
  return {
    name: 'alto-drop-sourcemaps',
    apply: 'build',
    closeBundle() {
      const dir = path.resolve(__dirname, 'dist');
      if (!fs.existsSync(dir)) return;
      const walk = (d: string) => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.name.endsWith('.map')) fs.unlinkSync(full);
        }
      };
      walk(dir);
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    emitAssetManifest(),
    preloadLatinFonts(),
    /**
     * Uploads the hidden sourcemaps, then deletes them from the build so
     * they are never served. Without this a Sentry stack is a minified
     * offset and a production bug can be watched but not read.
     *
     * Gated on the auth token: a developer build, and CI without secrets,
     * simply skips it rather than failing. Set SENTRY_AUTH_TOKEN,
     * SENTRY_ORG and SENTRY_PROJECT on the deploy for it to run.
     */
    ...(process.env.SENTRY_AUTH_TOKEN
      ? [
          sentryVitePlugin({
            authToken: process.env.SENTRY_AUTH_TOKEN,
            org: process.env.SENTRY_ORG,
            project: process.env.SENTRY_PROJECT,
            // Must match the `release` the browser SDK reports, or Sentry
            // has maps it cannot match to the stack that needs them.
            release: { name: process.env.VITE_SENTRY_RELEASE },
            sourcemaps: { filesToDeleteAfterUpload: ['**/*.map'] },
            telemetry: false,
          }),
        ]
      : [dropSourcemaps()]),
  ],
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
    /**
     * HIDDEN, NOT PUBLIC.
     *
     * Every frontend error in Sentry was a minified frame —
     * `main-Cm6ob-Sk.js:2:10531` — which is unreadable, so a production
     * TypeError could be seen but not diagnosed. 'hidden' emits the maps
     * for the Sentry plugin to upload and omits the //# sourceMappingURL
     * comment, so nothing points a browser at them; the plugin deletes
     * them after upload (filesToDeleteAfterUpload below), so the original
     * source never ships.
     *
     * Unset SENTRY_AUTH_TOKEN and the plugin is skipped — the build still
     * works, it just produces maps nobody uploads.
     */
    sourcemap: 'hidden',
    // Explicit support floor instead of Vite's implicit default, so the
    // emitted JS matches the browserslist in package.json (which drives
    // autoprefixer). Slightly wider than the browserslist floor: store
    // kiosk tablets skew old, and es2020/safari14 costs little.
    target: ['es2020', 'safari14'],
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
