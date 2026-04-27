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
import { performance84Router } from './routes/performance84.js';
import { recruitingRouter } from './routes/recruiting.js';
import { jobsRouter } from './routes/jobs.js';
import { auditRouter } from './routes/audit.js';
import { benefitsRouter } from './routes/benefits.js';
import { quickbooksRouter } from './routes/quickbooks.js';
import { branchWebhookRouter } from './routes/branchWebhook.js';
import { orgRouter } from './routes/org.js';
import { positionsRouter } from './routes/positions.js';
import { teamRouter } from './routes/team.js';
import { workflowsRouter } from './routes/workflows.js';
import { customFieldsRouter } from './routes/customFields.js';
import { selfServiceRouter } from './routes/selfService.js';
import { compensationRouter } from './routes/compensation.js';
import { qualificationsRouter } from './routes/qualifications.js';
import { projectsAndPayRouter } from './routes/projectsAndPay.js';
import { directoryAndCommsRouter } from './routes/directoryAndComms.js';
import { oshaWcEeoRouter } from './routes/oshaWcEeo.js';
import { docTemplatesRouter } from './routes/docTemplates.js';
import { recruiting90Router } from './routes/recruiting90.js';
import { payrollTax91Router } from './routes/payrollTax91.js';
import { benefitsLifecycle92Router } from './routes/benefitsLifecycle92.js';
import { apiKeysWebhooks93Router } from './routes/apiKeysWebhooks93.js';
import { lms94Router } from './routes/lms94.js';
import { worktags95Router } from './routes/worktags95.js';
import { reports96Router } from './routes/reports96.js';
import { reimbursements97Router } from './routes/reimbursements97.js';
import { kiosk99Router } from './routes/kiosk99.js';
import { celebrationsRouter } from './routes/celebrations107.js';
import { assetsRouter } from './routes/assets108.js';
import { pulseSurveysRouter } from './routes/pulseSurveys109.js';
import { headcount110Router } from './routes/headcount110.js';
import { skills111Router } from './routes/skills111.js';
import { mentorship112Router } from './routes/mentorship112.js';
import { expirations113Router } from './routes/expirations113.js';
import { learningPaths114Router } from './routes/learningPaths114.js';
import { succession115Router } from './routes/succession115.js';
import { probation116Router } from './routes/probation116.js';
import { holiday117Router } from './routes/holiday117.js';
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
  // 2mb to accommodate base64-encoded kiosk selfies (1MB raw → ~1.4MB
  // base64 → headroom for the JSON envelope).
  app.use(express.json({ limit: '2mb' }));
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
    performanceRouter,
    // Phase 84 — goals/OKRs, 1:1s, kudos, PIPs, 360s. Same view:performance
    // gate at the prefix; per-route MANAGE checks for write paths.
    performance84Router
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
  // Phase 80 — workflow definitions + run history.
  app.use('/workflows', workflowsRouter);
  // Phase 81 — custom field definitions + per-entity values.
  app.use('/custom-fields', customFieldsRouter);
  // Phase 82 — associate self-service (no capability gate; uses
  // req.user.associateId on every route).
  app.use('/self', selfServiceRouter);
  // Phase 83 — compensation: routes self-gate per-handler with view:comp
  // / manage:comp.
  app.use('/comp', compensationRouter);
  // Phase 85 — qualifications + open-shift marketplace. Routes self-gate
  // per-handler and the /shifts/* paths sit alongside Phase 24's /scheduling
  // namespace deliberately — open shifts are inherently cross-client for
  // associates with multi-client visibility.
  app.use('/', qualificationsRouter);
  // Phase 86 — projects, premium-pay rules, tip pools. Self-gates per
  // route between view:time / manage:time / view:payroll / process:payroll.
  app.use('/', projectsAndPayRouter);
  // Phase 87 — directory + broadcast + surveys. Self-gates per route.
  app.use('/', directoryAndCommsRouter);
  // Phase 88 — OSHA / WC / EEO. Routes self-gate per-handler with
  // view:compliance / manage:compliance.
  app.use('/', oshaWcEeoRouter);
  // Phase 89 — versioned document templates with mail-merge rendering.
  app.use('/', docTemplatesRouter);
  // Phase 90 — interview kits, offers, referrals, careers page. Routes
  // self-gate per-handler with view:recruiting / manage:recruiting; the
  // /careers/* paths are public (no capability check).
  app.use('/', recruiting90Router);
  // Phase 91 — garnishments + tax forms (941, 940, W-2, 1099-NEC).
  // Self-gates per-handler with view:payroll / process:payroll.
  app.use('/', payrollTax91Router);
  // Phase 92 — open enrollment, QLE, COBRA, ACA reporting. Self-gates
  // per-handler with view:payroll / process:payroll.
  app.use('/', benefitsLifecycle92Router);
  // Phase 93 — public API keys + outbound webhooks. Self-gates per
  // handler with view:integrations / manage:integrations.
  app.use('/', apiKeysWebhooks93Router);
  // Phase 94 — LMS: courses, modules, enrollments, certifications.
  // Self-gates per handler with view:compliance / manage:compliance.
  app.use('/', lms94Router);
  // Phase 95 — worktags: multi-dimensional categorical tags on
  // transactions. Self-gates per handler with view:payroll /
  // process:payroll.
  app.use('/', worktags95Router);
  // Phase 96 — saved reports + scheduled deliveries. All routes
  // require view:dashboard; spec validation prevents column/filter
  // injection.
  app.use('/', reports96Router);
  // Phase 97 — reimbursements + expense lines. Submitting routes are
  // open to authenticated users (route checks ownership); approve/pay
  // require process:payroll.
  app.use('/', reimbursements97Router);
  // Phase 99 — kiosk-mode clock in/out. Admin endpoints self-gate with
  // view:time / manage:time; the public /kiosk/punch endpoint authenticates
  // via the device token (no user session needed).
  app.use('/', kiosk99Router);
  app.use('/', celebrationsRouter);
  app.use('/', assetsRouter);
  app.use('/', pulseSurveysRouter);
  app.use('/', headcount110Router);
  app.use('/', skills111Router);
  app.use('/', mentorship112Router);
  app.use('/', expirations113Router);
  app.use('/', learningPaths114Router);
  app.use('/', succession115Router);
  app.use('/', probation116Router);
  app.use('/', holiday117Router);
  // QuickBooks router self-gates each route — the OAuth callback must accept
  // an unauthenticated browser redirect from Intuit, so we cannot apply a
  // capability check at this mount point.
  app.use('/quickbooks', quickbooksRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
