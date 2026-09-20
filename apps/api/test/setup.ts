import { config as loadDotenv } from 'dotenv';
import http from 'node:http';
import https from 'node:https';
import { resolve } from 'node:path';
import { beforeAll } from 'vitest';

/**
 * NO KEEP-ALIVE IN THE SUITE — the cause of the random socket flakes.
 *
 * Node 19 made `http.globalAgent.keepAlive` default to true, and supertest
 * binds a FRESH ephemeral server per request and closes it afterwards. The
 * agent pools idle sockets by `host:port`, so every closed server leaves a
 * dead socket pooled against the port it happened to get. Over a full run
 * (~1,720 tests, tens of thousands of requests) the OS recycles those
 * ephemeral ports, a new server lands on one that still has a stale socket
 * pooled — and the next request goes out on a socket to a server that no
 * longer exists.
 *
 * That is the whole flake family this suite has lived with: ECONNRESET, a
 * request that hangs until the 120s timeout, and framing errors that Node's
 * own `clientError` handler answers with a bodiless `400`/`403` — which is
 * why the failures never looked like the app's error handler and always
 * passed when the file was rerun alone.
 *
 * Reproduced directly: request → close server → bind a new one on the same
 * port → ECONNRESET, with the dead socket visible in `freeSockets` between
 * the two. Connection-per-request costs nothing against loopback.
 */
http.globalAgent = new http.Agent({ keepAlive: false });
https.globalAgent = new https.Agent({ keepAlive: false });

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
