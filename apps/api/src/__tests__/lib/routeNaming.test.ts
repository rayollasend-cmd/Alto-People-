import { describe, expect, it } from 'vitest';
import express, { type Request } from 'express';
import request from 'supertest';

/**
 * Sentry transaction names (lib/routeName). Express binds a route's
 * dispatch when the route is created — at its router module's import — so
 * the patch only names routes made after it is installed. Installed from
 * createApp(), it came after every router and named nothing (Nov 2026: 77%
 * of production traces were just "GET"/"POST"). instrument.ts, which Node
 * loads before the app (--import), now installs it.
 */
describe('route naming', () => {
  it('a route made before the patch is not seen; one made after instrument.ts loads is', async () => {
    const early = express.Router();
    early.get('/early', (req, res) => res.json({ pattern: (req as Request & { altoRoutePattern?: string }).altoRoutePattern ?? null }));

    // What production loads first (no DSN here, so Sentry itself stays off).
    await import('../../instrument.js');

    const late = express.Router();
    late.get('/me/inbox', (req, res) => res.json({ pattern: (req as Request & { altoRoutePattern?: string }).altoRoutePattern ?? null }));
    late.get('/associates/:id/photo', (req, res) => res.json({ pattern: (req as Request & { altoRoutePattern?: string }).altoRoutePattern ?? null }));
    const app = express();
    // As app.ts does: the browser's /api prefix is stripped before routing.
    app.use((req, _res, next) => {
      if (req.url.startsWith('/api/')) req.url = req.url.slice(4);
      next();
    });
    app.use('/early', early);
    app.use('/communications', late);

    expect((await request(app).get('/api/early/early')).body.pattern).toBeNull();
    expect((await request(app).get('/api/communications/me/inbox')).body.pattern).toBe('/communications/me/inbox');
    expect((await request(app).get('/api/communications/associates/abc/photo')).body.pattern).toBe('/communications/associates/:id/photo');
  });
});
