import { Router } from 'express';
import { registerLiveStream } from '../lib/liveEvents.js';
import { HttpError } from '../middleware/error.js';

/**
 * GET /events/stream — per-user SSE channel for "something changed"
 * nudges (see lib/liveEvents.ts). Any authenticated user; events are
 * typed pings with no payload, so no extra capability gating is needed.
 */
export const eventsRouter = Router();

eventsRouter.get('/stream', (req, res) => {
  const user = req.user;
  if (!user) throw new HttpError(401, 'unauthenticated', 'Sign in first');

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  // no-transform keeps the compression middleware from buffering the
  // stream (it skips responses that opt out of transformation).
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  // Open the stream immediately so EventSource fires `open` and the
  // client knows the live channel is up.
  res.write(': connected\n\n');

  registerLiveStream(user.id, res);
});
