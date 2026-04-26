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
  // a no-op once everything is up-to-date, so reruns stay cheap.
  execSync('npx prisma migrate deploy', {
    cwd: resolve(__dirname, '..'),
    stdio: 'inherit',
    env: process.env,
  });
}
