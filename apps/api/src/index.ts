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
