import { config as loadDotenv } from 'dotenv';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const ENV_TEST = resolve(__dirname, '../.env.test');

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
  if (lastErr) throw lastErr;
}
