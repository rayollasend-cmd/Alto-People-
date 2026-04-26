import express from 'express';
import cors from 'cors';
import { env } from './config/env.js';
import { healthRouter } from './routes/health.js';
import { clientsRouter } from './routes/clients.js';
import { onboardingRouter } from './routes/onboarding.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';

export function createApp() {
  const app = express();

  app.use(cors({ origin: env.CORS_ORIGIN }));
  app.use(express.json());

  app.use('/health', healthRouter);
  app.use('/clients', clientsRouter);
  app.use('/onboarding', onboardingRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
