import type { Page } from '@playwright/test';
import { settleWalk } from '../walkPersonas';

/**
 * "The page has finished drawing", shared by the recorder and the replay so
 * both photograph (and request) exactly the same state.
 *
 * The app marks every loading state: the auth splash and the route
 * fallbacks carry aria-label="Loading", and every Skeleton aria-busy="true".
 * Network quiet alone is not enough: a big chunk can take longer to parse
 * than the 500 ms networkidle waits for.
 */
export async function waitForApp(page: Page) {
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => undefined);
  await page.waitForFunction(
    () =>
      !document.querySelector('[aria-label="Loading"], [aria-busy="true"]') &&
      (document.body?.innerText.trim().length ?? 0) > 0,
    undefined,
    { timeout: 30_000, polling: 100 },
  );
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => undefined);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

/**
 * The first-run tour arms 900 ms after a page paints, and the "New this
 * week" card only shows once the tour is gone, on the next render. Dismiss
 * both; the recorder saves the localStorage that remembers it, and the
 * replay restores it, so neither covers a baseline.
 */
export async function dismissOverlays(page: Page) {
  await page.waitForTimeout(1_500);
  await settleWalk(page);
}

/** Taller pages are cut here, so one runaway list cannot make a 50 MB PNG. */
const MAX_HEIGHT = 6_000;

/**
 * Full-page, for an app whose page scrolls inside <main>, not the window:
 * Playwright's fullPage only sees the window, so the viewport grows to the
 * height the content needs (the window, or the widest vertical scroller,
 * whichever is taller) and the page lays out again. The phone's and the
 * desktop's width never change. Repeated until the
 * height holds, because a taller window can render more (virtualised rows).
 */
export async function expandToContent(page: Page) {
  const size = page.viewportSize();
  if (!size) return;
  for (let i = 0; i < 4; i++) {
    const current = page.viewportSize()!.height;
    const needed = await page.evaluate(() => {
      const vh = window.innerHeight;
      let h = document.documentElement.scrollHeight;
      for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
        // The page's own scroller spans most of the window; a card's
        // capped list (max-h-96 and the like) does not, and stays as is.
        if (el.clientWidth < window.innerWidth * 0.5 || el.clientHeight < vh * 0.6) continue;
        if (el.scrollHeight <= el.clientHeight + 1) continue;
        const oy = getComputedStyle(el).overflowY;
        if (oy !== 'auto' && oy !== 'scroll') continue;
        h = Math.max(h, el.scrollHeight + (vh - el.clientHeight));
      }
      return Math.ceil(h);
    });
    const next = Math.min(Math.max(needed, size.height), MAX_HEIGHT);
    if (next <= current) return;
    await page.setViewportSize({ width: size.width, height: next });
    await waitForApp(page);
  }
}
