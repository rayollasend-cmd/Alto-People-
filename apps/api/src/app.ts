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
import { timeOffRouter } from './routes/timeOff.js';
import { schedulingRouter } from './routes/scheduling.js';
import { payrollRouter } from './routes/payroll.js';
import { documentsRouter } from './routes/documents.js';
import { complianceRouter } from './routes/compliance.js';
import { analyticsRouter } from './routes/analytics.js';
import { communicationsRouter } from './routes/communications.js';
import { performanceRouter } from './routes/performance.js';
import { recruitingRouter } from './routes/recruiting.js';
import { jobsRouter } from './routes/jobs.js';
import { auditRouter } from './routes/audit.js';
import { benefitsRouter } from './routes/benefits.js';
import { quickbooksRouter } from './routes/quickbooks.js';
import { branchWebhookRouter } from './routes/branchWebhook.js';
import { orgRouter } from './routes/org.js';
import { positionsRouter } from './routes/positions.js';
import { teamRouter } from './routes/team.js';
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
  // Branch webhook MUST be mounted before express.json() so the raw body
  // bytes survive for HMAC verification (the global parser would consume
  // the stream and re-serialization breaks signatures on whitespace).
  app.use('/branch/webhook', branchWebhookRouter);
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
  app.use('/time-off', requireCapability('view:time'), timeOffRouter);
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
  app.use(
    '/analytics',
    requireCapability('view:dashboard'),
    analyticsRouter
  );
  app.use(
    '/communications',
    requireCapability('view:communications'),
    communicationsRouter
  );
  app.use(
    '/performance',
    requireCapability('view:performance'),
    performanceRouter
  );
  app.use(
    '/recruiting',
    requireCapability('view:recruiting'),
    recruitingRouter
  );
  app.use('/jobs', requireCapability('view:scheduling'), jobsRouter);
  app.use('/audit', requireCapability('view:audit'), auditRouter);
  app.use('/benefits', requireCapability('view:payroll'), benefitsRouter);
  // Phase 76 — org hierarchy. Routes self-gate read vs write capability.
  app.use('/org', orgRouter);
  // Phase 78 — positions / req-driven hiring.
  app.use('/positions', positionsRouter);
  // Phase 79 — manager-scoped approval queues.
  app.use('/team', teamRouter);
  // QuickBooks router self-gates each route — the OAuth callback must accept
  // an unauthenticated browser redirect from Intuit, so we cannot apply a
  // capability check at this mount point.
  app.use('/quickbooks', quickbooksRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
