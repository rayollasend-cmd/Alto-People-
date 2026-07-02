import { defineConfig, devices } from '@playwright/test';

/**
 * E2E harness — mobile-first by default (Pixel 7 profile = Chromium
 * mobile, matching the only browser binary we install).
 *
 * Run: `npm -w apps/web run test:e2e`
 * - With no env, it starts the Vite dev server itself (API-independent
 *   specs only — the login screen renders without a backend).
 * - Set E2E_BASE_URL to point at an already-running full stack (or a
 *   deployed environment) for authenticated flows.
 *
 * Deliberately NOT part of `npm test` / CI yet: CI has no browser
 * binaries installed and the suite needs a running app. Wire into CI
 * with `npx playwright install --with-deps chromium` when we're ready.
 */
export default defineConfig({
  testDir: './e2e',
  outputDir: './e2e-results/artifacts',
  timeout: 30_000,
  fullyParallel: true,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    ...devices['Pixel 7'],
    screenshot: 'only-on-failure',
  },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'npm run dev',
        url: 'http://localhost:5173',
        reuseExistingServer: true,
        timeout: 60_000,
      },
});
