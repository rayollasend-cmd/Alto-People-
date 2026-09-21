import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';
import { beforeAll } from 'vitest';

/**
 * NOTE ON A FIX THAT WAS NOT ONE.
 *
 * This file briefly set `http.globalAgent`/`https.globalAgent` to
 * keepAlive:false, on the theory that supertest's pooled sockets outlived
 * the ephemeral servers they belonged to. The mechanism is real — a closed
 * server does leave a pooled socket behind, and reusing it resets — but
 * SUPERAGENT NEVER TOUCHES THE GLOBAL AGENT: it sets `this._agent = false`
 * in its constructor and passes that to http.request, so every request
 * gets a fresh, unpooled agent. The fix changed something the suite does
 * not use, and its guard test (asserting freeSockets was empty) could
 * never have failed.
 *
 * Left as a comment so the next person does not spend the afternoon
 * rediscovering it. The remaining flake — a bodiless 4xx on a route that
 * exists, 0-3 per full run, always passing in isolation — is still
 * unexplained. See the project memory for what has been ruled out.
 */

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

// Deterministic SCIM provisioning bearer for tests — same rationale as the
// Branch secret above (ships with the repo so CI runs without extra env).
// Must satisfy the 32-char minimum in config/env.ts.
process.env.SCIM_TOKEN = 'test-scim-token-do-not-use-outside-tests';

// Deterministic Resend/Svix webhook secret for tests (same rationale as
// above). Svix format: "whsec_" + base64 key; the tests re-derive the
// signature from this exact value via lib/resendWebhook.signResendWebhook.
process.env.RESEND_WEBHOOK_SECRET =
  'whsec_dGVzdC1yZXNlbmQtd2ViaG9vay1zZWNyZXQtZG8tbm90LXVzZQ==';

// The kiosk schedule gate defaults ON in prod. Off for the suite — dozens
// of kiosk tests punch unscheduled associates; the gate's own tests flip
// the parsed env flag on explicitly.
process.env.KIOSK_REQUIRE_SCHEDULED_SHIFT = 'false';

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

