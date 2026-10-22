import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { defaultApiLimiter, loginEmailLimiter, piiRevealLimiter, tenantRateKey } from '../../middleware/rateLimit.js';
import { runWithTenant } from '../../lib/tenant.js';

/**
 * Brief 2-1 §9.6: an authenticated caller's rate-limit bucket leads with its
 * tenant; the pre-authentication limiters (IP, sign-in email) keep theirs.
 */

const T2 = '22222222-2222-4222-8222-222222222222';
type Limiter = RequestHandler & { getKey(key: string): Promise<{ totalHits: number } | undefined> | { totalHits: number } | undefined };

function appWith(limiter: RequestHandler, user: { id: string; tenantId?: string | null } | null): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (user) (req as unknown as { user: unknown }).user = user;
    next();
  });
  app.use(limiter);
  app.all('/x', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('tenantRateKey', () => {
  it('leads with the session user\'s tenant', () => {
    expect(tenantRateKey({ user: { id: 'u1', tenantId: T2 } } as never, 'user:u1')).toBe(`t:${T2}:user:u1`);
  });

  it('falls back to the request\'s tenant context (an API key or agent request)', async () => {
    expect(await runWithTenant(T2, 'api-key', () => tenantRateKey({} as never, 'apiKey:k1'))).toBe(`t:${T2}:apiKey:k1`);
  });

  it('keeps the bare key when no tenant is known', () => {
    expect(tenantRateKey({} as never, 'user:u1')).toBe('user:u1');
  });
});

describe('limiters', () => {
  it('the API-wide limiter counts a user in their tenant\'s bucket', async () => {
    const userId = `u-${Date.now()}`;
    await request(appWith(defaultApiLimiter, { id: userId, tenantId: T2 })).get('/x').expect(200);
    const limiter = defaultApiLimiter as Limiter;
    expect((await limiter.getKey(`t:${T2}:user:${userId}`))?.totalHits).toBe(1);
    expect(await limiter.getKey(`user:${userId}`)).toBeUndefined();
  });

  it('the per-actor PII limiter is tenant-keyed too', async () => {
    const userId = `p-${Date.now()}`;
    await request(appWith(piiRevealLimiter, { id: userId, tenantId: T2 })).get('/x').expect(200);
    expect((await (piiRevealLimiter as Limiter).getKey(`t:${T2}:user:${userId}`))?.totalHits).toBe(1);
  });

  it('the sign-in email limiter keeps its pre-tenant key', async () => {
    const email = `who-${Date.now()}@example.com`;
    await request(appWith(loginEmailLimiter, null)).post('/x').send({ email }).expect(200);
    expect((await (loginEmailLimiter as Limiter).getKey(`email:${email}`))?.totalHits).toBe(1);
  });
});
