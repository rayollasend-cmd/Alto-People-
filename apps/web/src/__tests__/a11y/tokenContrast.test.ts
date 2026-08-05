/**
 * Token contrast guard.
 *
 * axe's `color-contrast` rule is disabled in every other a11y suite here
 * (correctly — jsdom does not paint, so axe cannot resolve a computed
 * background). That left the palette itself completely uncovered, which is
 * how a light theme shipped with its most-used secondary text at 4.35:1 and
 * an `info` badge at 1.01:1.
 *
 * This suite closes that gap without a browser: it reads the real token
 * values out of index.css and checks the pairings the app actually renders.
 * It is deliberately a TOKEN test, not a page test — it cannot know that
 * some component puts silver on an unexpected surface, but it does pin every
 * documented pairing so the palette can't silently drift again.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, '../../index.css'), 'utf8');

type RGB = [number, number, number];

/** Pull one `--color-*` triplet out of a specific `:root` block. */
function tokens(selector: string): Record<string, RGB> {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`selector not found in index.css: ${selector}`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('\n}', open);
  const block = css.slice(open, close);
  const out: Record<string, RGB> = {};
  for (const m of block.matchAll(/--color-([a-z-]+):\s*([0-9]+)\s+([0-9]+)\s+([0-9]+)\s*;/g)) {
    out[m[1]] = [Number(m[2]), Number(m[3]), Number(m[4])];
  }
  return out;
}

const DARK = tokens(':root {');
const LIGHT = tokens(":root[data-theme='light'] {");

function luminance([r, g, b]: RGB): number {
  const a = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
}

function ratio(fg: RGB, bg: RGB): number {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Composite `fg` at `alpha` over an opaque `bg` — what the browser paints. */
function over(fg: RGB, bg: RGB, alpha: number): RGB {
  return fg.map((c, i) => c * alpha + bg[i] * (1 - alpha)) as RGB;
}

/** WCAG 2.1 AA: 4.5:1 for body text, 3:1 for >=18.66px bold / >=24px. */
const AA = 4.5;
const AA_LARGE = 3;

/**
 * The floors index.css applies on top of raw token math. Kept in sync by
 * hand — if you change a floor rule over there, change it here too.
 */
const LIGHT_SILVER_FLOOR: RGB = [100, 116, 139]; // /70 and below
const DARK_SILVER_FLOOR: RGB = [120, 134, 154]; // /50 and below
const LIGHT_TINT_CAP = 0.08; // faint status tints capped in light mode

describe.each([
  ['dark', DARK, [11, 24, 50] as RGB, [8, 15, 32] as RGB],
  ['light', LIGHT, [255, 255, 255] as RGB, [248, 250, 252] as RGB],
])('%s theme', (theme, T, card, page) => {
  const isLight = theme === 'light';

  // Full-opacity text tokens, on both the card and the page background.
  it.each(['silver', 'gold', 'alert', 'success', 'warning', 'steel', 'fg'])(
    'text-%s clears AA on card and page',
    (token) => {
      expect(ratio(T[token], card)).toBeGreaterThanOrEqual(AA);
      expect(ratio(T[token], page)).toBeGreaterThanOrEqual(AA);
    },
  );

  // gold-bright is used both as small text and as a hover fill under white
  // ink, so it has to clear AA in both directions.
  it('gold-bright works as small text and under white ink', () => {
    expect(ratio(T['gold-bright'], card)).toBeGreaterThanOrEqual(isLight ? AA : AA_LARGE);
    if (isLight) {
      expect(ratio([255, 255, 255], T['gold-bright'])).toBeGreaterThanOrEqual(AA);
    }
  });

  // The silver alpha ramp — the single biggest source of washed-out text.
  it.each([0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9])('text-silver/%s clears AA', (alpha) => {
    let fg: RGB;
    if (isLight && alpha <= 0.7) fg = LIGHT_SILVER_FLOOR;
    else if (!isLight && alpha <= 0.5) fg = DARK_SILVER_FLOOR;
    else fg = over(T.silver, card, alpha);
    expect(ratio(fg, card)).toBeGreaterThanOrEqual(AA);
  });

  // Status chips paint same-hue text on a tint of themselves. Badges render
  // at 10-12px, so they need the full 4.5 — never the large-text bar.
  it.each(['gold', 'alert', 'warning', 'success'])(
    '%s badge text clears AA on its own tint',
    (token) => {
      const alpha = isLight ? LIGHT_TINT_CAP : 0.15;
      expect(ratio(T[token], over(T[token], card, alpha))).toBeGreaterThanOrEqual(AA);
    },
  );

  // The `info` badge: sky text on a steel tint. This measured 1.01:1 in
  // light mode — pale blue on pale blue.
  it('info badge (sky on steel tint) clears AA', () => {
    const alpha = isLight ? LIGHT_TINT_CAP : 0.15;
    expect(ratio(T.sky, over(T.steel, card, alpha))).toBeGreaterThanOrEqual(AA);
  });

  // Primary button: theme-stable dark ink across the whole gold gradient.
  it('on-accent ink clears AA at both gradient stops', () => {
    expect(ratio(T['on-accent'], T['gold-fill'])).toBeGreaterThanOrEqual(AA);
    expect(ratio(T['on-accent'], T['gold-fill-bright'])).toBeGreaterThanOrEqual(AA);
  });
});
