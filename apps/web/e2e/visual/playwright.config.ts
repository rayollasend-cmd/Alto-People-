import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Visual regression: its own config, so the E2E and axe jobs (which run
 * apps/web/playwright.config.ts) never pick these specs up, and these specs
 * never run under that config (both skip unless ALTO_VISUAL is set, which
 * only this file does).
 *
 *   npm -w apps/web run test:visual          compare against the baselines
 *   npm -w apps/web run test:visual:update   rewrite the baselines
 *   npm -w apps/web run test:visual:record   re-record the HARs (full stack)
 *
 * The replay renders inside the official Playwright image (see run.mjs and
 * the "Visual regression" CI job) so a baseline drawn on one machine matches
 * on every other. README.md has the details.
 */

process.env.ALTO_VISUAL = '1';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '../..');
const RECORD = process.env.VISUAL_RECORD === '1';

/** Same port when recording and replaying: a HAR matches URLs exactly, origin included. */
export const VISUAL_PORT = 4799;
const DIST = process.env.VISUAL_DIST ?? 'e2e-results/visual-dist';
const API = process.env.VISUAL_API ?? 'http://localhost:3001';

export default defineConfig({
  testDir: HERE,
  testMatch: RECORD ? 'record.spec.ts' : 'visual.spec.ts',
  outputDir: path.join(WEB, 'e2e-results/visual/artifacts'),
  // One baseline per shot, no platform suffix: there is one rendering
  // environment (the Playwright Linux image), and the spec refuses others.
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}{ext}',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: RECORD ? 1 : process.env.CI ? 2 : 4,
  timeout: RECORD ? 15 * 60_000 : 90_000,
  reporter: [
    ['list'],
    ['html', { outputFolder: path.join(WEB, 'e2e-results/visual/report'), open: 'never' }],
  ],
  expect: {
    timeout: 20_000,
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
      // No pixel may differ beyond Playwright's per-pixel colour threshold
      // (0.2, which absorbs anti-aliasing noise). Measured 2026-10-23: 0
      // pixels between amd64 and arm64 runs and between a Mac-built and a
      // Linux-built bundle; one changed word on the Clients list was
      // 1,400–2,700. Raise this only for a measured source of noise.
      maxDiffPixels: 0,
    },
  },
  use: {
    baseURL: `http://127.0.0.1:${VISUAL_PORT}`,
    browserName: 'chromium',
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    // The installed app's worker would answer fetches outside page.route.
    serviceWorkers: 'block',
    contextOptions: { reducedMotion: 'reduce' },
    // No zygote: Chromium's forked zygote dies under the x86 emulation an
    // Apple-silicon laptop runs the image in. Set everywhere (CI too) so
    // every run launches the browser the same way; rendering is unchanged.
    //
    // No LCD text: Chromium draws text with subpixel (LCD) antialiasing on
    // an opaque layer and greyscale on one it composites separately, and a
    // page revealed by an opacity change (FirstLoadGate) can land on either,
    // run to run — the store portal's desktop shot once differed by 189 px of
    // text edges alone. Greyscale everywhere makes that choice once.
    launchOptions: { args: ['--no-zygote', '--disable-lcd-text'] },
    // A fixed agent for recording and replay alike (the app reads it for
    // platform hints); Linux because the replay runs on Linux.
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 AltoVisual/1',
    trace: 'retain-on-failure',
    screenshot: 'off',
  },
  webServer: {
    command: `node e2e/visual/serve.mjs --dir ${DIST} --port ${VISUAL_PORT}${RECORD ? ` --api ${API}` : ''}`,
    cwd: WEB,
    url: `http://127.0.0.1:${VISUAL_PORT}/`,
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'pipe',
  },
});
