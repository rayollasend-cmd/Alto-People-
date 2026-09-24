import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    globalSetup: ['./test/globalSetup.ts'],
    // Integration tests share a single Postgres test schema and rely on
    // serial truncation between tests, so files must never overlap: one
    // worker, one file at a time. (Vitest 4 dropped poolOptions.forks
    // .singleFork; when it was still in the config it was silently ignored
    // and the suite deadlocked against itself 775 times.)
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
    // Generous: integration tests run sequential round-trips against Neon
    // over the public internet (~200-400 ms per query). The happy-path
    // onboarding test does ~6 sequential POSTs each containing a multi-step
    // $transaction, so it can legitimately need >60s.
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
