import { env } from './config/env.js';
import { createApp } from './app.js';
import { prisma } from './db.js';
import { startKeepAlive } from './lib/keepalive.js';
import { startInviteReminderCron } from './lib/inviteReminder.js';
import { startAttestationReminderCron } from './lib/attestationReminder.js';
import { startKioskMaintenanceCron } from './lib/kioskMaintenance.js';
import { ensureBrandingLoaded } from './lib/branding.js';
import { preloadPayrollTaxConfig } from './lib/payrollTax.js';

const app = createApp();

app.listen(env.PORT, '0.0.0.0', async () => {
  console.log(`[alto-people/api] listening on http://localhost:${env.PORT}`);
  console.log(`[alto-people/api] CORS origins: ${env.CORS_ORIGIN.join(', ')}`);

  // Wake the DB pool immediately so the first user request doesn't pay the
  // cold-start. Best-effort — if the DB is unreachable, we still serve
  // /health and the routes will surface their own errors.
  try {
    const t0 = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    console.log(`[alto-people/api] DB warm (${Date.now() - t0}ms)`);
  } catch (err) {
    console.warn(
      '[alto-people/api] DB warm-up failed:',
      err instanceof Error ? err.message : err
    );
  }

  if (env.KEEP_ALIVE_INTERVAL_SECONDS > 0) {
    startKeepAlive(env.KEEP_ALIVE_INTERVAL_SECONDS);
    console.log(
      `[alto-people/api] DB keep-alive every ${env.KEEP_ALIVE_INTERVAL_SECONDS}s ` +
        '(uses Neon compute hours; set KEEP_ALIVE_INTERVAL_SECONDS=0 to disable)'
    );
  }

  startInviteReminderCron();
  startAttestationReminderCron();
  startKioskMaintenanceCron();

  // Multi-replica safety check for the kiosk rate limiter. The default
  // backend is per-process; without a shared store, a multi-replica
  // deployment lets an attacker bypass the PIN lockout by spraying
  // replicas. We refuse to boot rather than silently regress.
  if (env.MULTI_REPLICA === 1) {
    // The placeholder check inspects the swap point. When a shared
    // backend is installed it replaces the in-memory default; we keep
    // a sentinel reference on globalThis from the adapter setup so
    // this guard can confirm. Adapters are installed by importing
    // their setup module before this line runs.
    const installed = (globalThis as { __KIOSK_RATE_LIMIT_BACKEND__?: string })
      .__KIOSK_RATE_LIMIT_BACKEND__;
    if (!installed) {
      console.error(
        'FATAL: MULTI_REPLICA=1 but no shared kiosk rate-limit backend ' +
          'was installed. The default per-process store cannot enforce ' +
          'lockouts across replicas — an attacker can defeat the brute-' +
          'force protection by round-robin\'ing through replicas. Either ' +
          'install a shared backend via setKioskRateLimitStore() at boot ' +
          'or pin the deployment to a single replica (MULTI_REPLICA=0).',
      );
      process.exit(1);
    }
    console.log(`[alto-people/api] kiosk rate limit using ${installed} backend`);
  } else {
    // Single-replica path. Make the assumption explicit in the log
    // so ops doesn't accidentally scale out and lose lockout state.
    console.log(
      '[alto-people/api] kiosk rate limit using in-memory store ' +
        '(single-replica only; set MULTI_REPLICA=1 + install a shared ' +
        'backend before scaling out)',
    );
  }

  // Best-effort prime of the branding cache so the first email rendered
  // after boot uses the org's saved logo + colors instead of the
  // hard-coded defaults. Auto-refreshes every 5 min via ensureBrandingLoaded
  // call sites.
  ensureBrandingLoaded(prisma).catch((err) => {
    console.warn('[alto-people/api] branding preload failed:', err);
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
    console.log(`[alto-people/api] payroll tax config loaded for year ${currentYear}`);
  } catch (err) {
    console.warn(
      `[alto-people/api] WARNING: payroll tax config NOT loaded for year ${currentYear} —`,
      err instanceof Error ? err.message : err,
    );
    console.warn(
      '[alto-people/api] Insert a payroll_config row for the current year ' +
        '(see prisma/migrations/*_add_payroll_config) before running payroll.',
    );
  }
});
