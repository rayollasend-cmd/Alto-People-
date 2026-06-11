import { config as loadDotenv } from 'dotenv';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const ENV_TEST = resolve(__dirname, '../.env.test');

// Cross-run mutex key. Every test run TRUNCATEs the shared alto_test
// schema between tests, so two vitest processes running concurrently
// (a stray editor test runner, an orphaned previous run, two terminals)
// destroy each other's fixtures and produce phantom "Record not found"
// failures. A session-level Postgres advisory lock serializes runs:
// the second one simply waits. Held on a DIRECT (non-pooled)
// connection — through a transaction-mode pooler a session lock can
// land on an arbitrary backend and silently not exclude anyone. If a
// run is killed, the server releases the lock when its connection
// drops, so a crashed run can't deadlock the next one.
const SUITE_LOCK_KEY = 727_274_001;

export default async function globalSetup() {
  loadDotenv({ path: ENV_TEST, override: true });

  if (process.env.NODE_ENV !== 'test') {
    throw new Error('globalSetup: NODE_ENV is not "test"; check apps/api/.env.test');
  }
  if (!process.env.DATABASE_URL?.includes('schema=alto_test')) {
    throw new Error(
      'globalSetup: DATABASE_URL must include schema=alto_test so dev data is never touched'
    );
  }

  // Create the alto_test schema if it doesn't exist. Prisma migrate deploy
  // creates tables in the schema named by the URL but does not create the
  // schema itself.
  const { PrismaClient } = await import('@prisma/client');
  const bootstrap = new PrismaClient();
  try {
    // Neon spins down on idle; the first connect after a long pause sometimes
    // errors. One retry after a short wait reliably wakes the instance.
    try {
      await bootstrap.$executeRawUnsafe('CREATE SCHEMA IF NOT EXISTS alto_test');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/Can't reach database server|connection/i.test(msg)) throw err;
      await new Promise((r) => setTimeout(r, 2000));
      await bootstrap.$executeRawUnsafe('CREATE SCHEMA IF NOT EXISTS alto_test');
    }
  } finally {
    await bootstrap.$disconnect();
  }

  // Serialize concurrent runs (see SUITE_LOCK_KEY above). The lock client
  // must stay connected for the entire run — the session IS the lock — so
  // it's created here and released in the teardown this function returns.
  // pg_try_advisory_lock (boolean) instead of pg_advisory_lock (void):
  // Prisma can't deserialize a void column, and the poll loop gives us
  // progress logging for free.
  const lockClient = new PrismaClient({
    datasourceUrl: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
  });
  console.log(
    '[globalSetup] acquiring test-suite lock (waits if another run is active)…',
  );
  for (let waitedMs = 0; ; waitedMs += 3000) {
    const rows = await lockClient.$queryRawUnsafe<Array<{ locked: boolean }>>(
      `SELECT pg_try_advisory_lock(${SUITE_LOCK_KEY}) AS locked`,
    );
    if (rows[0]?.locked) break;
    if (waitedMs >= 10 * 60 * 1000) {
      await lockClient.$disconnect().catch(() => {});
      throw new Error(
        'globalSetup: another test run has held the suite lock for 10+ minutes; ' +
          'kill the stale vitest process (or its DB session) and retry.',
      );
    }
    if (waitedMs % 15000 === 0) {
      console.warn(
        `[globalSetup] another test run is active — waiting (${Math.round(waitedMs / 1000)}s)…`,
      );
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log('[globalSetup] test-suite lock acquired');

  // Apply migrations against alto_test. `migrate deploy` is idempotent —
  // a no-op once everything is up-to-date. Neon cold-starts can fail the
  // first attempt; one retry after a short wait is enough.
  const runMigrate = (): { stdout: string; stderr: string } => {
    try {
      const stdout = execSync('npx prisma migrate deploy', {
        cwd: resolve(__dirname, '..'),
        env: process.env,
        encoding: 'utf8',
      });
      console.log(stdout);
      return { stdout, stderr: '' };
    } catch (err) {
      // execSync attaches stdout/stderr to the error when it captures them.
      const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; message: string };
      const stdout = e.stdout?.toString() ?? '';
      const stderr = e.stderr?.toString() ?? '';
      console.log(stdout);
      console.error(stderr);
      throw new Error(
        `prisma migrate deploy failed: ${e.message}\nstderr: ${stderr}`
      );
    }
  };
  // Up to 4 attempts with backoff. Neon's pooled endpoint can take longer
  // to wake than direct, and migrate spawns its own connection so warming
  // the bootstrap client above doesn't always carry over.
  const delays = [0, 3000, 6000, 10000];
  let lastErr: unknown;
  for (let i = 0; i < delays.length; i++) {
    if (delays[i] > 0) {
      console.warn(
        `[globalSetup] migrate deploy retry ${i} after ${delays[i]}ms (Neon cold start?)`
      );
      await new Promise((r) => setTimeout(r, delays[i]));
    }
    try {
      runMigrate();
      lastErr = null;
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/Can't reach database server|connection|P1001/i.test(msg)) throw err;
      lastErr = err;
    }
  }
  if (lastErr) {
    // Don't hold the suite lock if we're bailing out.
    await lockClient.$disconnect().catch(() => {});
    throw lastErr;
  }

  // Teardown: release the suite lock. If the process dies instead, the
  // server releases it when the connection drops — no deadlock either way.
  return async () => {
    await lockClient
      .$queryRawUnsafe(`SELECT pg_advisory_unlock(${SUITE_LOCK_KEY})`)
      .catch(() => {});
    await lockClient.$disconnect().catch(() => {});
  };
}
