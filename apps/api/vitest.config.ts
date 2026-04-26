import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    globalSetup: ['./test/globalSetup.ts'],
    // Integration tests share a single Postgres test schema and rely on
    // serial truncation between tests; a single fork keeps that simple
    // and avoids cross-test interference from the global Prisma client.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    // Generous: integration tests run sequential round-trips against Neon
    // over the public internet (~200-400 ms per query). The happy-path
    // onboarding test does ~6 sequential POSTs each containing a multi-step
    // $transaction, so it can legitimately need >60s.
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
