import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type Browser } from '@playwright/test';
import { walkLogin } from '../walkPersonas';
import { FORMS, PERSONAS, VISUAL_PAGES, type PersonaKey, type VisualManifest } from './pages';
import { assertNoSecrets, mergeHars } from './har';
import { ANSWERED_IN_CODE, quietChannels } from './live';
import { dismissOverlays, expandToContent, waitForApp } from './settle';

/**
 * The recorder: signs in as each persona once, opens every page of
 * pages.ts on the built app (served by serve.mjs with /api proxied to the
 * local API), and saves every /api response the page made into
 * hars/<key>.har, desktop and phone merged. The recording instant, the URL
 * and the page's localStorage go into hars/manifest.json.
 *
 * Run with `npm -w apps/web run test:visual:record` (needs the API on :3001
 * against alto_dev's demo data). VISUAL_ONLY=clients,books re-records just
 * those pages and keeps the others.
 */

test.skip(
  process.env.ALTO_VISUAL !== '1' || process.env.VISUAL_RECORD !== '1' || !process.env.E2E_FULLSTACK,
  'records only from e2e/visual/playwright.config.ts with E2E_FULLSTACK=1 VISUAL_RECORD=1',
);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '../..');
const HAR_DIR = path.join(HERE, 'hars');
const MANIFEST = path.join(HAR_DIR, 'manifest.json');
const WORK = path.join(WEB, 'e2e-results/visual/recording');
const AUTH = path.join(WORK, 'auth');

/**
 * localStorage the replay should not inherit: the offline copy of the
 * session, queued writes, chat threads, the theme (each shot sets its own)
 * and anything that looks like a credential.
 */
const DROP_STORAGE = /^(alto\.offline\.|alto\.theme$|alto:assistant:thread:)|token|secret|password/i;

async function signedInState(browser: Browser, who: Exclude<PersonaKey, 'public'>): Promise<string> {
  const file = path.join(AUTH, `${who}.json`);
  // Logins are rate-limited (5 per account per 15 minutes): reuse a saved
  // session while the API still accepts it.
  if (fs.existsSync(file)) {
    const ctx = await browser.newContext({ storageState: file });
    const res = await ctx.request.get('/api/auth/me');
    await ctx.close();
    if (res.ok()) return file;
  }
  const p = PERSONAS[who];
  const ctx = await browser.newContext({ ...FORMS.desktop });
  const page = await ctx.newPage();
  await walkLogin(page, p.email, p.pass);
  const me = await ctx.request.get('/api/auth/me');
  if (!me.ok()) throw new Error(`visual record: sign-in as ${p.email} failed (${me.status()})`);
  fs.mkdirSync(AUTH, { recursive: true });
  await ctx.storageState({ path: file });
  await ctx.close();
  return file;
}

test('record every page', async ({ browser }) => {
  const only = process.env.VISUAL_ONLY?.split(',').map((s) => s.trim()).filter(Boolean);
  const pages = only?.length ? VISUAL_PAGES.filter((p) => only.includes(p.key)) : VISUAL_PAGES;
  fs.mkdirSync(HAR_DIR, { recursive: true });
  fs.mkdirSync(WORK, { recursive: true });
  const manifest: VisualManifest = fs.existsSync(MANIFEST)
    ? (JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) as VisualManifest)
    : { note: '', pages: {} };
  manifest.note =
    'Written by record.spec.ts. Each page: the URL it was recorded at, the instant (the replay freezes the clock there) and the localStorage it left behind.';

  for (const vp of pages) {
    const state = vp.persona === 'public' ? undefined : await signedInState(browser, vp.persona);

    let url: string;
    if (typeof vp.route === 'string') {
      url = vp.route;
    } else {
      const ctx = await browser.newContext({ ...FORMS.desktop, storageState: state });
      url = await vp.route(await ctx.newPage());
      await ctx.close();
    }

    // Whole seconds: the instant reads cleanly in the manifest.
    const recordedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
    const parts: string[] = [];
    const storage: Record<string, string> = {};

    for (const form of vp.forms) {
      const ctx = await browser.newContext({ ...FORMS[form], storageState: state, colorScheme: 'dark' });
      // The page computes its date ranges from this clock, so the URLs it
      // asks for are the ones the replay (frozen at the same instant) asks for.
      await ctx.clock.setFixedTime(recordedAt);
      const har = path.join(WORK, `${vp.key}-${form}.har`);
      fs.rmSync(har, { force: true });
      await ctx.routeFromHAR(har, { url: '**/api/**', update: true, updateContent: 'embed', updateMode: 'minimal' });
      await quietChannels(ctx);
      const page = await ctx.newPage();
      await page.addInitScript(() => {
        try {
          localStorage.setItem('alto.theme', 'dark');
        } catch {
          /* storage blocked */
        }
      });
      await page.goto(url);
      await waitForApp(page);
      await dismissOverlays(page);
      // Once more from a fresh load: the "New this week" card only shows
      // after the tour is gone, and the replay starts from that state.
      await page.reload();
      await waitForApp(page);
      await dismissOverlays(page);
      // The replay grows the window to the page's full height; whatever a
      // taller window loads (more rows, a section scrolled into view) has
      // to be in the recording too.
      await expandToContent(page);
      await page.waitForTimeout(1_000);
      await waitForApp(page);
      Object.assign(storage, await page.evaluate(() => ({ ...localStorage })));
      await ctx.close(); // writes the HAR
      parts.push(har);
    }

    const iso = recordedAt.toISOString();
    const merged = mergeHars(parts, iso, (u) => ANSWERED_IN_CODE.test(u.pathname));
    const out = path.join(HAR_DIR, `${vp.key}.har`);
    assertNoSecrets(merged, out);
    fs.writeFileSync(out, JSON.stringify(merged, null, 1) + '\n');

    manifest.pages[vp.key] = {
      url,
      recordedAt: iso,
      localStorage: Object.fromEntries(
        Object.entries(storage)
          .filter(([k]) => !DROP_STORAGE.test(k))
          .sort(([a], [b]) => a.localeCompare(b)),
      ),
    };
    console.log(`recorded ${vp.key}: ${url} — ${merged.log.entries.length} responses`);
  }

  const ordered = Object.fromEntries(
    VISUAL_PAGES.filter((p) => manifest.pages[p.key]).map((p) => [p.key, manifest.pages[p.key]!]),
  );
  fs.writeFileSync(MANIFEST, JSON.stringify({ note: manifest.note, pages: ordered }, null, 2) + '\n');
});
