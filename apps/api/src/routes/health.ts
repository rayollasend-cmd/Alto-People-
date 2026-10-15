import { Router } from 'express';
import type { HealthResponse } from '@alto-people/shared';
import { prisma } from '../db.js';

export const healthRouter = Router();

/**
 * Liveness: the process is up and serving. Railway's health check reads
 * this one, so it never depends on the database — a database restart must
 * not make the platform restart the API on top of it.
 */
healthRouter.get('/', (_req, res) => {
  const payload: HealthResponse = { ok: true, ts: new Date().toISOString() };
  res.json(payload);
});

/**
 * Readiness: can this process answer a request that needs the database
 * right now? `SELECT 1` with a short timeout; 503 while the database is
 * away. The failover test (Brief 3-6) measures the interruption window
 * from this route; a load balancer or uptime monitor should read it too.
 */
const READY_TIMEOUT_MS = 2_000;
healthRouter.get('/ready', async (_req, res) => {
  const t0 = Date.now();
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('db probe timed out')), READY_TIMEOUT_MS).unref(),
  );
  try {
    await Promise.race([prisma.$queryRaw`SELECT 1`, timeout]);
    res.json({ ok: true, db: 'ok', dbMs: Date.now() - t0, ts: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({
      ok: false,
      db: 'down',
      dbMs: Date.now() - t0,
      reason: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
      ts: new Date().toISOString(),
    });
  }
});

// Build identity, used by the kiosk's idle-screen self-update poll. A
// wall-mounted tablet keeps its tab open for weeks, so without this every
// deploy only reaches a kiosk when someone manually refreshes it (and the
// page deliberately blocks pull-to-refresh). Railway injects the git SHA;
// outside Railway we fall back to process start time, which still changes
// on every deploy/restart — at worst the kiosk reloads once after a bare
// restart, which is harmless on the idle screen.
export const BUILD_VERSION =
  process.env.RAILWAY_GIT_COMMIT_SHA ?? `boot-${Date.now()}`;

healthRouter.get('/version', (_req, res) => {
  res.json({ version: BUILD_VERSION });
});
