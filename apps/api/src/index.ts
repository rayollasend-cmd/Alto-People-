import { env } from './config/env.js';
// Sentry must initialise before any module that handles requests so
// its auto-instrumentation can attach to Node's HTTP layer at import
// time. No-op when SENTRY_DSN is unset.
import { initSentry } from './lib/sentry.js';
initSentry();

import { createApp } from './app.js';
import { prisma } from './db.js';
import { logger } from './lib/logger.js';
import { startKeepAlive } from './lib/keepalive.js';
import { startInviteReminderCron } from './lib/inviteReminder.js';
import { startAttestationReminderCron } from './lib/attestationReminder.js';
import { startKioskMaintenanceCron } from './lib/kioskMaintenance.js';
import { startDocumentMaintenanceCron } from './lib/documentMaintenance.js';
import { startUploadsBackupCron } from './lib/uploadsBackup.js';
import { startShiftReminderCron } from './lib/shiftReminder.js';
import { startScheduleDigestCron } from './lib/scheduleDigest.js';
import { startWeekAheadCron } from './lib/weekAheadDigest.js';
import { ensureBrandingLoaded } from './lib/branding.js';
import { preloadPayrollTaxConfig } from './lib/payrollTax.js';
import { flushPendingAudits } from './lib/audit.js';

const app = createApp();

const server = app.listen(env.PORT, '0.0.0.0', async () => {
  logger.info(
    { port: env.PORT, corsOrigins: env.CORS_ORIGIN },
    'api listening',
  );

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
  startAttestationReminderCron();
  startKioskMaintenanceCron();
  startDocumentMaintenanceCron();
  startUploadsBackupCron();
  startShiftReminderCron();
  startScheduleDigestCron();
  startWeekAheadCron();

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
  ensureBrandingLoaded(prisma).catch((err) => {
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
    await preloadPayrollTaxConfig(prisma, currentYear);
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
