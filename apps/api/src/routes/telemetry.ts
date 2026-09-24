import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { recordVital, routeKey, WEB_VITAL_METRICS, type WebVitalMetric } from '../lib/webVitals.js';

export const telemetryRouter = Router();

/**
 * What the browser tells us about itself. Every endpoint here is
 * fire-and-forget from the client's side (a beacon on page hide, a
 * keepalive fetch as the fallback), so the contract is: validate, buffer,
 * answer 202 at once, and never let a bad sample become an error a person
 * could see.
 */

const SampleSchema = z.object({
  route: z.string().min(1).max(300),
  metric: z.enum(WEB_VITAL_METRICS as [WebVitalMetric, ...WebVitalMetric[]]),
  /** Milliseconds, or the unitless CLS score. Two minutes is already a
   *  broken page; past that it is a clock bug, not a measurement. */
  value: z.number().finite().min(0).max(120_000),
});

const BodySchema = z.object({
  samples: z.array(SampleSchema).min(1).max(50),
});

/**
 * POST /telemetry/web-vitals
 *
 * Signed-in users only — the session cookie rides along with a
 * same-origin beacon — so the table can't be filled from outside. Samples
 * whose route can't be reduced to a pattern are dropped, not stored.
 */
telemetryRouter.post('/web-vitals', requireAuth, (req, res) => {
  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body' });
    return;
  }
  let accepted = 0;
  for (const s of parsed.data.samples) {
    const route = routeKey(s.route);
    if (!route) continue;
    recordVital(route, s.metric, s.value);
    accepted += 1;
  }
  res.status(202).json({ accepted });
});
