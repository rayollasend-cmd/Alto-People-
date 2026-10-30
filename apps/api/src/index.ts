import { activeGeocoder } from './lib/geocode.js';
import { env } from './config/env.js';
// Sentry must initialise before any module that handles requests so
// its auto-instrumentation can attach to Node's HTTP layer at import
// time. No-op when SENTRY_DSN is unset.
import { initSentry } from './lib/sentry.js';
import { installProcessGuards } from './lib/processGuards.js';
initSentry();
// A stray rejected promise is logged, never fatal (CODE-22).
installProcessGuards();

import { createApp } from './app.js';
import { prisma } from './db.js';
import { logger } from './lib/logger.js';
import { startKeepAlive } from './lib/keepalive.js';
import { startInviteReminderCron } from './lib/inviteReminder.js';
import { startOnboardingPurgeCron } from './lib/onboardingPurge.js';
import { startStaleNudgeCron } from './lib/staleNudge.js';
import { startDueInviteCron } from './lib/inviteDelivery.js';
import { startRecruitingCleanupCron } from './lib/recruitingCleanup.js';
import { startDormancySweepCron } from './lib/dormancySweep.js';
import { startOpsDigestCron } from './lib/opsDigest.js';
import { startOpsSopCron } from './lib/storeShiftSop.js';
import { startPortalDigestCron } from './lib/portalDigest.js';
import { startServiceReportMailCron } from './lib/serviceReportMailer.js';
import { startPortalEngagementDigestCron } from './lib/portalEngagement.js';
import { startPortalCoverageAlertCron } from './lib/portalCoverageAlert.js';
import { startAttestationReminderCron } from './lib/attestationReminder.js';
import { startExpirationDigestCron } from './lib/expirationDigest.js';
import { startWorkflowWorkerCron } from './lib/workflow.js';
import { startAccessGrantSweepCron } from './lib/accessChanges.js';
import { startComplianceSnapshotCron } from './lib/complianceSnapshot.js';
import { startForecastCron } from './lib/forecast/cron.js';
import { startClientNpsCron } from './lib/clientNps.js';
import { startMarketWageCron } from './lib/marketWages.js';
import { startKioskMaintenanceCron } from './lib/kioskMaintenance.js';
import { startRobotIncidentRetentionCron } from './lib/robotIncidentRetention.js';
import { startCarrierAckPickupCron } from './lib/carrierAcks.js';
import { startDocumentMaintenanceCron } from './lib/documentMaintenance.js';
import { startCaseSlaCron } from './lib/hrCaseSla.js';
import { startPolicyCampaignCron } from './lib/policyCampaigns.js';
import { startReportScheduleCron } from './lib/reportScheduleRunner.js';
import { startUploadsBackupCron } from './lib/uploadsBackup.js';
import { startShiftReminderCron } from './lib/shiftReminder.js';
import { startAutoClockOutCron } from './lib/autoClockOut.js';
import { startExecutiveAlertsCron } from './lib/executiveAlerts.js';
import { startRelayEscalationCron } from './lib/relayEscalation.js';
import { startNoShowRiskCron } from './lib/noShowRisk.js';
import { startComplianceAgentCron } from './lib/complianceAgent.js';
import { startPayrollAgentCron } from './lib/payrollAgent.js';
import { startShiftAutofillCron } from './lib/shiftAutofill.js';
import { startExecutiveDigestCron } from './lib/executiveDigest.js';
import { startScheduleDigestCron } from './lib/scheduleDigest.js';
import { installHugoTaskEvents, startHugoTasksCron } from './lib/hugoTasks.js';
import { startHugoNotesCron } from './lib/hugoNotes.js';
import { startHugoThreadCron } from './lib/hugoThread.js';
import { startReadyToWorkNudgeCron } from './lib/readyToWork.js';
import { startWeekAheadCron } from './lib/weekAheadDigest.js';
import { startWebhookDeliveryCron } from './lib/webhookDispatch.js';
import { startOfferLetterCron } from './lib/offerLetters.js';
import { startUsageFlusher } from './lib/usageTracker.js';
import { startVitalsFlusher } from './lib/webVitals.js';
import { startProductEventsFlusher } from './lib/productEvents.js';
import { recordApiBoot } from './lib/reliability.js';
import { startReliabilityDigestCron } from './lib/reliabilityDigest.js';
import { startEvidenceCron } from './lib/evidence.js';
import { startProgramDigestCron } from './lib/programDigest.js';
import { startLaborShadowCron } from './lib/laborRules/shadow.js';
import { startBankingCron } from './lib/banking/cron.js';
import { startEquityExpiryCron } from './lib/equityExpiry.js';
import { ensureEnvIdentity, ensureEnvScimToken } from './lib/identity.js';
import { startBillingCron } from './lib/billing.js';
import { startStatementDunningCron } from './lib/statementDunning.js';
import { startDailyPayCron } from './lib/dailyPay.js';
import { startTimeOffPolicyCron } from './lib/timeOffPolicy.js';
import { startSecurityAlertsCron } from './lib/securityAlerts.js';
import { startAuditSinkCron } from './lib/auditSink.js';
import { runForEachTenant } from './lib/tenantJobs.js';
import { installEventSync } from './lib/integrations/sync.js';
import { startAgentDriftCron } from './lib/agentControls.js';
import { startAccessPurgeCron } from './lib/accessCleanup.js';
import { startTaskHandoffSweep } from './lib/tasks/sweep.js';
import { ALTO_TENANT_ID, runWithTenant, withPlatformScope } from './lib/tenant.js';
import { armBootJobs, installPlatformScopeAudit } from './lib/bootJobs.js';
import { BUILD_VERSION } from './routes/health.js';
import { startMemoryWatch } from './lib/memoryWatch.js';
import { startIdempotencyCleanupCron } from './middleware/idempotency.js';
import { startNotificationRetentionCron } from './lib/notificationRetention.js';
import { startNotificationDigestCron } from './lib/notificationDelivery.js';
import { startCertificationReminderCron } from './lib/accessCertification.js';
import { startRetentionCron } from './lib/retention.js';
import { startVanTrailRetentionCron } from './lib/transportLive.js';
import { startStuckRunSweepCron } from './lib/transportStuckRuns.js';
import { startNotRunSweepCron } from './lib/transportNotRun.js';
import { startRideSeriesCron } from './lib/rideSeries.js';
import { ensureBrandingLoaded } from './lib/branding.js';
import { preloadPayrollTaxConfig } from './lib/payrollTax.js';
import { flushPendingAudits } from './lib/audit.js';
import { KeyringError, verifyKeyring } from './lib/keyring.js';
import { startAuditChainCheckCron } from './lib/auditChain.js';
import { startBiometricSealCron } from './lib/biometricFields.js';

const app = createApp();

// Brief 2-5 step 3: every field-encryption key decrypts its canary before the API serves anyone.
// A key that changed under its id (the 2026-06-11 incident) stops this deploy here, and the
// running version keeps serving, instead of failing a person's read in production.
try {
  const k = await verifyKeyring(prisma);
  logger.info({ keys: k.checked, canariesWritten: k.created }, 'field-encryption keyring verified');
} catch (err) {
  if (err instanceof KeyringError) {
    logger.fatal({ err: err.message }, 'field-encryption keyring refused');
    process.exit(1);
  }
  logger.error({ err }, 'field-encryption keyring could not be verified (database unreachable?); starting anyway');
}

const server = app.listen(env.PORT, '0.0.0.0', async () => {
  logger.info(
    { port: env.PORT, corsOrigins: env.CORS_ORIGIN },
    'api listening',
  );
  // Which address lookup the vans' map runs on. Nominatim alone is the
  // limited mode: set MAPBOX_TOKEN to get house numbers and businesses.
  logger.info({ geocoder: activeGeocoder() }, 'address lookup provider');

  // Wake the DB pool immediately so the first user request doesn't pay the
  // cold-start. Best-effort — if the DB is unreachable, we still serve
  // /health and the routes will surface their own errors.
  try {
    const t0 = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    logger.info({ warmMs: Date.now() - t0 }, 'db warm');
  } catch (err) {
    logger.warn({ err }, 'db warm-up failed');
  }

  if (env.KEEP_ALIVE_INTERVAL_SECONDS > 0) {
    startKeepAlive(env.KEEP_ALIVE_INTERVAL_SECONDS);
    logger.info(
      { intervalSeconds: env.KEEP_ALIVE_INTERVAL_SECONDS },
      'db keep-alive enabled',
    );
  }

  startInviteReminderCron();
  startOnboardingPurgeCron();
  startStaleNudgeCron();
  startDueInviteCron();
  startRecruitingCleanupCron();
  startDormancySweepCron();
  startOpsDigestCron();
  startOpsSopCron();
  startPortalDigestCron();
  startServiceReportMailCron();
  startPortalEngagementDigestCron();
  startPortalCoverageAlertCron();
  startAttestationReminderCron();
  startExpirationDigestCron();
  // The approval engine: queued workflow runs execute per tenant; temporary access reverts on time.
  startWorkflowWorkerCron();
  startAccessGrantSweepCron();
  startComplianceSnapshotCron();
  startKioskMaintenanceCron();
  // Robot incident evidence past its five-year retention is removed daily (the report stays).
  startRobotIncidentRetentionCron();
  // Carriers' 999 / TA1 answers to enrollment files, from each SFTP carrier's inbound folder (none set = nothing read).
  startCarrierAckPickupCron();
  startDocumentMaintenanceCron();
  startStatementDunningCron();
  startDailyPayCron();
  startTimeOffPolicyCron();
  startCaseSlaCron();
  startPolicyCampaignCron();
  startReportScheduleCron();
  startUploadsBackupCron();
  startShiftReminderCron();
  startScheduleDigestCron();
  // Hugo works for you: tasks take their next step, notes stay current (lib/hugoTasks, lib/hugoNotes).
  startHugoTasksCron();
  startHugoNotesCron();
  // Each person's conversation with Hugo is kept 90 days (lib/hugoThread).
  startHugoThreadCron();
  installHugoTaskEvents();
  startReadyToWorkNudgeCron();
  startExecutiveDigestCron();
  startExecutiveAlertsCron();
  startRelayEscalationCron();
  startShiftAutofillCron();
  startNoShowRiskCron();
  // Agent families step 4: the Compliance agent (document.chase, i9.section2), hourly per tenant.
  startComplianceAgentCron();
  startPayrollAgentCron();
  startAutoClockOutCron();
  startWeekAheadCron();
  startOfferLetterCron();
  // Flushes the in-memory usage counters. Armed here with the other crons
  // and never in tests, where a stray interval would write rollup rows
  // into alto_test between suites; tests drive flushUsageForTests().
  startUsageFlusher();
  // Same deal for the browser's web-vitals samples.
  startVitalsFlusher();
  // And for the three behaviour events (first decision, decisions a session, settings searches).
  startProductEventsFlusher();
  // One row per process start, so restarts show on the reliability page.
  // Best-effort: a boot must never fail because a bookkeeping row did.
  recordApiBoot(BUILD_VERSION).catch((err) => logger.warn({ err }, 'api boot row not written'));
  startReliabilityDigestCron();
  startEvidenceCron();
  startProgramDigestCron();
  // Brief 3-4: monthly per tenant, the forecast scores what came true and recomputes.
  startForecastCron();
  // Client NPS: one question to every store manager in the first week of a quarter.
  startClientNpsCron();
  startMarketWageCron();
  // Brief 2-2 step 3: the labor rules engine beside every finalized run (reads only; pays nothing).
  startLaborShadowCron(prisma);
  // Payroll banking: funding and entries settle, prenotes clear and go out, hourly per tenant.
  startBankingCron();
  // Equity grants past their expiration date read EXPIRED, daily per tenant (audit 2026-10-21, Tier 3).
  startEquityExpiryCron();
  // Brief 2-3 step 2: the environment IdP and SCIM_TOKEN become Alto HR's first rows.
  // Brief 2-6 step 4: daily usage snapshots, and the month's invoices on its first days.
  startBillingCron(prisma);
  // Brief 2-5 step 7: alerts from the audit trail to the security contact and the operator's admins.
  startSecurityAlertsCron(prisma);
  // Brief 2-3 step 4: each tenant's SIEM sink, every minute.
  startAuditSinkCron(prisma);
  // Audit 2026-10-21 item 20: the nightly hash-chain verifier, a break alerting the security contact.
  startAuditChainCheckCron(prisma);
  // SOC 2 decision 7: selfies and face templates written before the seal are encrypted in batches.
  startBiometricSealCron(prisma);
  // The environment's SSO / SCIM settings belong to Alto HR: written as that tenant.
  void runWithTenant(ALTO_TENANT_ID, 'job', () => Promise.all([ensureEnvIdentity(prisma), ensureEnvScimToken(prisma)])).catch((err) => logger.error({ err }, 'identity migration from the environment failed'));
  // The sweeps index.ts used to wire with bare setIntervals — person workers,
  // built-in agents and their approvals' expiry, retirement elections, backup
  // withholding, pay schedules, the books, integration syncs and robot
  // sampling — go through the jobs registry, per tenant (lib/bootJobs.ts):
  // one in-flight guard, one Scheduled jobs panel (audit 2026-10-29 CRAWL-4,
  // CODE-23). timerTenancy.test.ts keeps new timers out of this file.
  armBootJobs(prisma);
  startAgentDriftCron();
  // Brief 3-5: the HR and VMS connections sync on their schedule (every five
  // minutes the clock is checked per tenant) and on the domain events the
  // webhook fan-out sees.
  installEventSync();
  // Brief 3-2: a machine's stalled task goes to a person after the policy's seconds.
  startTaskHandoffSweep();
  // Brief 1A-4: deactivated accounts past their 30-day grace are soft-deleted.
  startAccessPurgeCron();
  // Brief 2-1, step two: every cross-tenant view the platform opens is on the
  // record, written as the scope's own tenant (lib/bootJobs.ts; CRAWL-5).
  installPlatformScopeAudit();
  // Samples RSS/heap/external once a minute. An OOM kill is a SIGKILL —
  // no handler runs, nothing reaches Sentry — so the evidence has to be
  // written down BEFORE the process dies.
  startMemoryWatch();
  // Outbound webhook deliveries — safe under MULTI_REPLICA without a
  // shared backend: each row is claimed via a guarded attemptCount
  // update, so two replicas can't double-POST the same delivery.
  startWebhookDeliveryCron();
  // Hourly sweep of expired Idempotency-Key rows (24h TTL, 2× slack).
  startIdempotencyCleanupCron();
  // Daily: read bell rows >90d and email/SMS delivery-audit rows >365d.
  startNotificationRetentionCron();
  // Access pack: held notifications (quiet hours, digests) go out together
  // every ten minutes; overdue access certifications remind their reviewers.
  startNotificationDigestCron();
  startCertificationReminderCron();
  startRetentionCron();
  startVanTrailRetentionCron();
  // Daily in effect: a van run left ACTIVE hours past its last stop is closed (lib/transportStuckRuns).
  startStuckRunSweepCron();
  // Every 15 minutes: a planned run that never left is closed, its riders told and never charged (lib/transportNotRun).
  startNotRunSweepCron();
  // Hourly: standing ride bookings booked forward a week.
  startRideSeriesCron();

  // Multi-replica safety check. Three independent per-process subsystems
  // assume a single container today: the kiosk PIN rate limiter (brute-
  // force lockout), the SessionUser cache (auth invalidation), and the
  // Resend throttle (4 req/s gate, would N× scale and trip 429s). With
  // MULTI_REPLICA=1 each needs a shared backend installed before boot
  // finishes; otherwise we refuse to start rather than silently regress.
  if (env.MULTI_REPLICA === 1) {
    const globals = globalThis as {
      __KIOSK_RATE_LIMIT_BACKEND__?: string;
      __USER_CACHE_BACKEND__?: string;
      __RESEND_THROTTLE_BACKEND__?: string;
    };
    const checks: Array<{ name: string; sentinel: string | undefined; hint: string }> = [
      {
        name: 'kiosk rate limit',
        sentinel: globals.__KIOSK_RATE_LIMIT_BACKEND__,
        hint: 'setKioskRateLimitStore() in lib/kioskRateLimit.ts',
      },
      {
        name: 'session user cache',
        sentinel: globals.__USER_CACHE_BACKEND__,
        hint: 'installSharedUserCache() in middleware/auth.ts',
      },
      {
        name: 'Resend throttle',
        sentinel: globals.__RESEND_THROTTLE_BACKEND__,
        hint: 'installSharedResendThrottle() in lib/notifications.ts',
      },
    ];
    const missing = checks.filter((c) => !c.sentinel);
    if (missing.length > 0) {
      for (const m of missing) {
        logger.fatal(
          { subsystem: m.name, hint: m.hint },
          'MULTI_REPLICA=1 but no shared backend installed — refusing to start',
        );
      }
      process.exit(1);
    }
    for (const c of checks) {
      logger.info(
        { subsystem: c.name, backend: c.sentinel },
        'multi-replica backend',
      );
    }
  } else {
    // Single-replica path. Make the assumption explicit in the log
    // so ops doesn't accidentally scale out and lose lockout state,
    // cache coherence, or rate-limit accuracy.
    logger.info(
      'in-process stores in use for kiosk rate limit, session user cache, and Resend throttle (single-replica only)',
    );
  }

  // Best-effort prime of the branding cache so the first email rendered
  // after boot uses the org's saved logo + colors instead of the
  // hard-coded defaults. Auto-refreshes every 5 min via ensureBrandingLoaded
  // call sites.
  runForEachTenant('branding', (tenantId) => ensureBrandingLoaded(prisma, tenantId)).catch((err) => {
    logger.warn({ err }, 'branding preload failed');
  });

  // Load the federal payroll-tax constants for the current calendar year
  // into the in-memory cache the engine reads from. Failure here is loud
  // but not fatal — /health and unrelated routes still serve so ops can
  // diagnose. The first payroll-tax computation will throw with the same
  // message until a row for the current year is inserted into
  // payroll_config. Re-runs every January catch missing-IRS-tables drift.
  const currentYear = new Date().getFullYear();
  try {
    await withPlatformScope(() => preloadPayrollTaxConfig(prisma, currentYear));
    logger.info({ year: currentYear }, 'payroll tax config loaded');
  } catch (err) {
    logger.warn(
      { err, year: currentYear },
      'payroll tax config NOT loaded — insert a payroll_config row for the current year before running payroll',
    );
  }
});

// ---------------------------------------------------------------------------
// Graceful shutdown
//
// Railway sends SIGTERM and waits ~30s before SIGKILL on every redeploy.
// Without a handler, Node exits the moment we receive the signal,
// dropping any in-flight HTTP request — including the half-second
// window between Branch's disbursement API returning success and our
// critical audit row landing, or the gap between a kiosk punch
// completing and its selfie being committed.
//
// Shutdown sequence:
//   1. Stop accepting new connections (server.close stops listening
//      but keeps existing sockets alive until their requests finish).
//   2. Wait up to SHUTDOWN_DRAIN_MS for in-flight handlers to settle.
//   3. await flushPendingAudits() — fire-and-forget audit writes that
//      were queued during step 2 still need to land. recordCritical
//      callers already await; this catches the routine enqueueAudit
//      tail.
//   4. Disconnect Prisma so the pool returns connections to Neon
//      cleanly instead of leaking sockets.
//   5. exit(0). If anything in 1-4 hangs past SHUTDOWN_HARD_MS we
//      force-exit so a stuck handler can't deadlock the deploy.
//
// Both SIGTERM (Railway/PM2/k8s) and SIGINT (Ctrl-C in dev) trigger the
// same path so devs see real behaviour locally.
// ---------------------------------------------------------------------------

const SHUTDOWN_DRAIN_MS = 15_000;
const SHUTDOWN_HARD_MS = 25_000;
let shuttingDown = false;

async function gracefulShutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return; // second SIGTERM = no-op, let the existing path run
  shuttingDown = true;
  logger.info({ signal, drainMs: SHUTDOWN_DRAIN_MS }, 'shutdown requested');

  // Hard timer: if any step below hangs, we force-exit. Railway will
  // SIGKILL at ~30s anyway; we'd rather log the timeout than disappear.
  const hardTimer = setTimeout(() => {
    logger.fatal('shutdown hard timeout — forcing exit');
    process.exit(1);
  }, SHUTDOWN_HARD_MS);
  hardTimer.unref();

  try {
    // Stop accepting new connections. Existing requests keep going.
    await new Promise<void>((resolve) => {
      server.close((err) => {
        if (err) logger.warn({ err }, 'server.close error during shutdown');
        resolve();
      });
    });
    logger.info('server stopped accepting connections');

    // Let in-flight requests have one more drain window. Most will
    // already be done by the time server.close resolves (it waits for
    // the keep-alive idle), but tail latency happens.
    await new Promise((r) => setTimeout(r, 500));

    // Drain queued audits. Critical audits are already awaited at the
    // call site; this catches the fire-and-forget enqueueAudit tail.
    await flushPendingAudits();
    logger.info('audit queue flushed');

    // Close Prisma so Neon sees clean disconnects instead of dead
    // sockets that take a few minutes to time out.
    await prisma.$disconnect();
    logger.info('prisma disconnected, exiting');

    clearTimeout(hardTimer);
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'shutdown encountered error');
    clearTimeout(hardTimer);
    process.exit(1);
  }
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
