import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { env } from './config/env.js';
import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { clientsRouter } from './routes/clients.js';
import { onboardingRouter } from './routes/onboarding.js';
import { timeRouter } from './routes/time.js';
import { schedulingRouter } from './routes/scheduling.js';
import { payrollRouter } from './routes/payroll.js';
import { documentsRouter } from './routes/documents.js';
import { complianceRouter } from './routes/compliance.js';
import { attachUser, requireCapability } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';

export function createApp() {
  const app = express();

  // Behind a proxy in prod (Vercel/Railway/etc.) so req.ip resolves correctly.
  if (env.NODE_ENV === 'production') {
    app.set('trust proxy', 1);
  }

  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGIN, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(attachUser);

  app.use('/health', healthRouter);
  app.use('/auth', authRouter);
  app.use('/clients', requireCapability('view:clients'), clientsRouter);
  app.use(
    '/onboarding',
    requireCapability('view:onboarding'),
    onboardingRouter
  );
  app.use('/time', requireCapability('view:time'), timeRouter);
  app.use(
    '/scheduling',
    requireCapability('view:scheduling'),
    schedulingRouter
  );
  app.use('/payroll', requireCapability('view:payroll'), payrollRouter);
  app.use(
    '/documents',
    requireCapability('view:documents'),
    documentsRouter
  );
  app.use(
    '/compliance',
    requireCapability('view:compliance'),
    complianceRouter
  );

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
