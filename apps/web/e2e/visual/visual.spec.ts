import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { FORMS, VISUAL_PAGES, shotName, type Form, type VisualManifest } from './pages';
import { quietChannels } from './live';
import { expandToContent, waitForApp } from './settle';

/**
 * Visual regression: every page in pages.ts, served from its recording
 * (hars/<key>.har) with the browser clock frozen at the recording instant,
 * compared with the approved picture in __screenshots__/.
 *
 * Nothing here talks to an API or a database, so the only thing that can
 * move a picture is the code. A failure leaves expected / actual / diff
 * images in e2e-results/visual/artifacts and in the HTML report.
 *
 * Run it with `npm -w apps/web run test:visual` (inside the Playwright
 * image, so the pixels match CI). README.md says how to re-record a HAR and
 * how to approve a new picture.
 */

test.skip(process.env.ALTO_VISUAL !== '1', 'runs from e2e/visual/playwright.config.ts (npm -w apps/web run test:visual)');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HAR_DIR = path.join(HERE, 'hars');
const MANIFEST = path.join(HAR_DIR, 'manifest.json');

const manifest: VisualManifest | null = fs.existsSync(MANIFEST)
  ? (JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) as VisualManifest)
  : null;

test.beforeAll(() => {
  // Baselines are drawn in the Playwright Linux image. Fonts and
  // anti-aliasing differ on a Mac, so a host run would only report noise.
  if (process.platform !== 'linux' && process.env.VISUAL_ALLOW_HOST !== '1') {
    throw new Error(
      'The visual suite renders inside the Playwright Linux image: run `npm -w apps/web run test:visual`, not playwright directly. (VISUAL_ALLOW_HOST=1 overrides, for debugging only.)',
    );
  }
  if (!manifest) throw new Error('No recordings: run `npm -w apps/web run test:visual:record` first.');
});

for (const form of ['desktop', 'phone'] as Form[]) {
  test.describe(form, () => {
    test.use({ ...FORMS[form] });

    for (const vp of VISUAL_PAGES.filter((p) => p.forms.includes(form))) {
      for (const theme of vp.themes) {
        test(`${vp.title} — ${form} ${theme}`, async ({ page, baseURL }) => {
          const rec = manifest?.pages[vp.key];
          if (!rec) throw new Error(`${vp.key} has no recording: run test:visual:record with VISUAL_ONLY=${vp.key}`);

          // Only the app's own origin answers; nothing outside it (map tiles,
          // a CDN) may decide a pixel.
          const origin = new URL(baseURL!).origin;
          await page.context().route(
            (url) => url.origin !== origin,
            (route) => route.abort('blockedbyclient'),
          );

          // Every /api call is answered from the recording. One the
          // recording lacks is aborted and listed below: the page now asks
          // for something new, and the recording has to be made again.
          const unanswered: string[] = [];
          page.on('requestfailed', (req) => {
            const u = new URL(req.url());
            if (u.origin === origin && u.pathname.startsWith('/api/')) unanswered.push(`${req.method()} ${u.pathname}${u.search}`);
          });
          await page.routeFromHAR(path.join(HAR_DIR, `${vp.key}.har`), { url: '**/api/**', notFound: 'abort' });
          await quietChannels(page);

          // The instant the recording was made: "today", "this week" and
          // every "3 hours ago" read the same on every run.
          await page.clock.setFixedTime(new Date(rec.recordedAt));
          await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
          await page.addInitScript(
            ({ storage, theme: t }) => {
              try {
                localStorage.clear();
                for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, v);
                localStorage.setItem('alto.theme', t);
              } catch {
                /* storage blocked */
              }
            },
            { storage: rec.localStorage, theme },
          );

          await page.goto(rec.url);
          await waitForApp(page);
          // A tour or card the recording dismissed would arm about now.
          await page.waitForTimeout(1_500);
          await expandToContent(page);
          await waitForApp(page);

          expect(unanswered, 'requests missing from the recording — re-record this page (README.md)').toEqual([]);

          // No masks: with the clock frozen and every response recorded,
          // nothing on these pages varies from run to run. The window is
          // already as tall as the page (expandToContent); fullPage covers
          // a page that scrolls the window instead.
          await expect(page).toHaveScreenshot(shotName(vp.key, form, theme), { fullPage: true });
        });
      }
    }
  });
}
