import express, { Router, type Request, type Response } from 'express';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';

/**
 * Product analytics relay (PostHog). The browser SDK sends to /api/ux on our
 * own origin and this forwards to PostHog's US cloud (docs/analytics.md):
 *
 *  - ad blockers don't silently drop staff analytics;
 *  - the CSP stays connect-src 'self' — no PostHog host is listed;
 *  - PostHog sees this server's address, never an employee's home IP: the
 *    client address is not forwarded, and neither are cookies or any
 *    authorization header. Only the body and four plain headers go through.
 *
 * Two upstreams, the split PostHog documents for a proxy: project settings
 * and SDK files come from the assets host (/array, /static), events,
 * recordings and flags go to the ingest host.
 *
 * Mounted before express.json so the SDK's gzip bodies pass through byte for
 * byte, and before attachUser so the session never rides along.
 */

export const POSTHOG_INGEST = 'https://us.i.posthog.com';
export const POSTHOG_ASSETS = 'https://us-assets.i.posthog.com';

const FORWARD_REQUEST_HEADERS = ['content-type', 'content-encoding', 'user-agent', 'accept'] as const;
const PASS_RESPONSE_HEADERS = ['content-type', 'cache-control'] as const;

/** Where a relayed path goes, or null for one we don't forward. */
export function relayTarget(url: string): string | null {
  if (!url.startsWith('/') || url.startsWith('//')) return null;
  const upstream = url.startsWith('/static/') || url.startsWith('/array/') ? POSTHOG_ASSETS : POSTHOG_INGEST;
  const target = new URL(upstream + url);
  // The path is concatenated onto a fixed origin; this pins it there anyway.
  return target.origin === upstream ? target.toString() : null;
}

// A store's back office puts every manager behind one address, and a
// recording sends a batch every few seconds; this only stops a flood.
const relayLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: process.env.NODE_ENV === 'test' ? 100_000 : 3_000,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req: Request) => `ux:${req.ip ? ipKeyGenerator(req.ip) : 'unknown'}`,
  message: { error: { code: 'rate_limited', message: 'Too many analytics requests.' } },
});

export const analyticsRelayRouter = Router();

analyticsRelayRouter.use(relayLimiter);
// Recording batches are gzip and capped near 1 MB by the SDK.
analyticsRelayRouter.use(express.raw({ type: () => true, limit: '5mb' }));

// Middleware, not a route: the route inventory (and the suites generated
// from it) never calls out to PostHog.
analyticsRelayRouter.use(async (req: Request, res: Response) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).end();
    return;
  }
  const target = relayTarget(req.url);
  if (!target) {
    res.status(404).end();
    return;
  }
  const headers: Record<string, string> = {};
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = req.headers[name];
    if (typeof value === 'string') headers[name] = value;
  }
  const body = req.method === 'POST' && Buffer.isBuffer(req.body) && req.body.length > 0 ? req.body : undefined;
  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
    // fetch has already decoded the body, so the upstream's encoding and
    // length don't describe what we send; compression() re-encodes it.
    for (const name of PASS_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    res.status(upstream.status).send(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    // Analytics is best-effort: the SDK retries, and nothing in the app waits on it.
    if (!res.headersSent) res.status(502).end();
  }
});
