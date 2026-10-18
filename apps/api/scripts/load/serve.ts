/**
 * The API without its background jobs, for a local load run (CI serves the
 * production build). Point it at a scratch `alto_scale` database:
 *
 *   DATABASE_URL=postgresql://alto:alto_dev@localhost:5432/alto_scale?schema=public \
 *   DIRECT_URL=$DATABASE_URL PORT=3101 DEFAULT_API_LIMIT=10000000 \
 *     npx tsx scripts/load/serve.ts
 *
 * then `API_URL=http://localhost:3101 npx tsx scripts/load/run.ts` (after `db:seed` and
 * `LOAD_SCALE=1 npx tsx scripts/load/seed-scale.ts` on that database).
 * Refuses to start against anything that isn't alto_scale.
 */
if (!/\/alto_scale(\?|$)/.test(process.env.DATABASE_URL ?? '')) {
  console.error('load-server: DATABASE_URL must point at the alto_scale database.');
  process.exit(1);
}
const { createApp } = await import('../../src/app.js');
// The boot steps a request depends on — never the crons.
const { prisma } = await import('../../src/db.js');
const { preloadPayrollTaxConfig } = await import('../../src/lib/payrollTax.js');
const { ensureBrandingLoaded } = await import('../../src/lib/branding.js');
const { withPlatformScope } = await import('../../src/lib/tenant.js');
await withPlatformScope(() => preloadPayrollTaxConfig(prisma));
await withPlatformScope(() => ensureBrandingLoaded(prisma)).catch(() => undefined);
const port = Number(process.env.PORT ?? 3101);
createApp().listen(port, () => console.log(`load-server on :${port} (no background jobs)`));
