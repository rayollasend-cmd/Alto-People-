import { Router } from 'express';
import type { HealthResponse } from '@alto-people/shared';

export const healthRouter = Router();

healthRouter.get('/', (_req, res) => {
  const payload: HealthResponse = { ok: true, ts: new Date().toISOString() };
  res.json(payload);
});

// Build identity, used by the kiosk's idle-screen self-update poll. A
// wall-mounted tablet keeps its tab open for weeks, so without this every
// deploy only reaches a kiosk when someone manually refreshes it (and the
// page deliberately blocks pull-to-refresh). Railway injects the git SHA;
// outside Railway we fall back to process start time, which still changes
// on every deploy/restart — at worst the kiosk reloads once after a bare
// restart, which is harmless on the idle screen.
const BUILD_VERSION =
  process.env.RAILWAY_GIT_COMMIT_SHA ?? `boot-${Date.now()}`;

healthRouter.get('/version', (_req, res) => {
  res.json({ version: BUILD_VERSION });
});
