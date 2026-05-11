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
        console.error(
          `FATAL: MULTI_REPLICA=1 but no shared backend installed for "${m.name}". ` +
            `Wire ${m.hint} at boot, or pin to a single replica (MULTI_REPLICA=0).`,
        );
      }
      process.exit(1);
    }
    for (const c of checks) {
      console.log(`[alto-people/api] ${c.name} using ${c.sentinel} backend`);
    }
  } else {
    // Single-replica path. Make the assumption explicit in the log
    // so ops doesn't accidentally scale out and lose lockout state,
    // cache coherence, or rate-limit accuracy.
    console.log(
      '[alto-people/api] running with in-process stores for kiosk rate ' +
        'limit, session user cache, and Resend throttle (single-replica ' +
        'only; set MULTI_REPLICA=1 + install shared backends before ' +
        'scaling out)',
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
