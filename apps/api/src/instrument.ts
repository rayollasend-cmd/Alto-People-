/**
 * Sentry, before anything else.
 *
 * The API is ESM, and ESM evaluates every static import of index.ts before
 * a single statement of its body runs — so `initSentry()` in index.ts
 * always ran AFTER express had been imported, and Sentry's Express
 * instrumentation never attached. Transactions kept the bare method the
 * HTTP layer gives them ("GET") instead of the route ("GET /api/time/me/
 * earnings").
 *
 * Node loads this file first:
 *
 *   node --import ./dist/instrument.js dist/index.js
 *
 * (railway.json and the start script both do.) index.ts still calls
 * initSentry() as a no-op fallback, so running the API without the flag
 * degrades to the old behaviour rather than failing.
 */
import { initSentry } from './lib/sentry.js';

initSentry();

// Route names (lib/routeName) patch Express's Route.prototype.dispatch, and
// Express binds each route's dispatch when the route is created — at the
// router module's import. Installed from createApp() alone, it came after
// every router existed and named nothing: Nov 2026, 77% of traces were
// just "GET"/"POST" (Sentry's own naming keeps a route only when the URL
// starts with it, and stripApiPrefix has removed /api). So it goes in here,
// before index.js loads a single router, and after initSentry so express
// is imported under Sentry's instrumentation.
const { installRouteNaming } = await import('./lib/routeName.js');
installRouteNaming();
