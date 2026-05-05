import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';
import { beforeAll } from 'vitest';

// Load .env.test before any test imports the api source — those imports
// pull in `config/env.ts`, which validates env at module load time.
// `override: true` so test values win over an existing dev `.env`.
loadDotenv({ path: resolve(__dirname, '../.env.test'), override: true });

if (process.env.NODE_ENV !== 'test') {
  throw new Error('test/setup.ts: NODE_ENV is not "test"; check apps/api/.env.test');
}

// Deterministic Branch webhook secret for tests. Lives here rather than in
// .env.test (which is gitignored) so the value ships with the repo and CI
// runs without a separate env config. Tests sign their payloads with the
// same string in branchWebhook.test.ts. Real prod value comes from Railway.
process.env.BRANCH_WEBHOOK_SECRET = 'test-branch-webhook-secret-do-not-use-outside-tests';

// Preload the payroll tax config cache from the alto_test DB. Route-level
// tests that drive the payroll engine (paystub, disbursement, payroll)
// would otherwise throw "config cache empty" at compute time. Test files
// that need a deterministic in-memory fixture (payrollTax.test.ts) still
// override this with __setPayrollTaxConfigForTesting in their own
// beforeAll — that runs after this and wins.
beforeAll(async () => {
  const [{ preloadPayrollTaxConfig }, { prisma }] = await Promise.all([
    import('../src/lib/payrollTax.js'),
    import('../src/db.js'),
  ]);
  await preloadPayrollTaxConfig(prisma);
});
