import { Router } from 'express';
import type { HealthResponse } from '@alto-people/shared';

export const healthRouter = Router();

healthRouter.get('/', (_req, res) => {
  const payload: HealthResponse = { ok: true, ts: new Date().toISOString() };
  res.json(payload);
});
