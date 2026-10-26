#!/usr/bin/env node
/**
 * The palette, generated (2026-10-26).
 *
 * Navy and gold are the brand and stay exactly as they are. Everything around
 * them is drawn from six families defined here in OKLCH, so the status
 * colours, the greys and the surfaces belong to Alto instead of to a stock
 * framework palette:
 *
 *   neutral   navy-tinted greys (hue 262, the navy's own) — text, lines, pages
 *   accent    the brand gold (hue 88)
 *   positive  jade (158)          done, healthy, paid
 *   caution   amber (64)          waiting, due soon — kept well clear of the
 *                                  gold: at hue 81 it read as the brand accent
 *   negative  brick red (26)      failed, late, refused
 *   info      navy-family blue (258)
 *
 * Two rules make the change safe:
 *
 * 1. Every existing token keeps its WCAG luminance — only its hue and chroma
 *    move onto its family. A token is written below as "this family, at this
 *    contrast against this surface", so every pairing the contrast work
 *    settled on (src/__tests__/a11y/tokenContrast.test.ts, the axe sweeps)
 *    measures exactly what it did before.
 * 2. Each family also gets an 11-step scale, 50…950, that is THEME-AWARE:
 *    50 is the faintest step off the surface and 950 the strongest ink, in
 *    both themes (light: 50 is a pale wash; dark: 50 sits just off navy).
 *    `bg-positive-100 text-positive-800` is therefore a chip in either theme,
 *    and its contrast is fixed by construction — no alpha over an unknown
 *    surface. The steps are spaced by luminance, so step N has the same
 *    contrast against the surface in every family.
 *
 *   node scripts/palette.mjs           write the token blocks into src/index.css
 *   node scripts/palette.mjs --check   fail if index.css is stale, or a pairing
 *                                      below drops under its floor
 *   node scripts/palette.mjs --preview <out.html>   swatches of both themes
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const CSS_PATH = resolve(here, '../src/index.css');

/* ------------------------------------------------------------------ colour math */

const toLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGam = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function oklchToLinear([L, C, h]) {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** OKLCH → sRGB 0–255, giving up chroma (never lightness or hue) to stay in gamut. */
function oklchToRgb([L, C, h]) {
  let c = C;
  let lin = oklchToLinear([L, c, h]);
  while (lin.some((v) => v < -1e-4 || v > 1 + 1e-4) && c > 0) {
    c = Math.max(0, c - 0.0005);
    lin = oklchToLinear([L, c, h]);
  }
  return lin.map((v) => Math.round(toGam(Math.min(1, Math.max(0, v))) * 255));
}

function luminance([r, g, b]) {
  const [R, G, B] = [r, g, b].map((v) => toLin(v / 255));
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}
const contrast = (x, y) => {
  const [a, b] = [luminance(x), luminance(y)].sort((p, q) => q - p);
  return (a + 0.05) / (b + 0.05);
};
const over = (fg, bg, alpha) => fg.map((c, i) => c * alpha + bg[i] * (1 - alpha));
const hex = (rgb) => '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();

/* --------------------------------------------------------------------- families */

/**
 * Chroma as a function of lightness: full at `lp`, falling off over `w` and
 * tapering at both ends, so washes stay calm and deep steps stay rich.
 */
const family = (h, peak, lp, w) => ({
  h,
  chroma: (L) => {
    const bell = Math.max(0, 1 - ((L - lp) / w) ** 2);
    const top = L > 0.9 ? Math.max(0, (1 - L) / 0.1) : 1;
    return peak * bell * Math.min(1, 0.35 + 0.65 * top);
  },
});

const FAMILIES = {
  neutral: family(262, 0.04, 0.5, 0.62),
  accent: family(88, 0.125, 0.78, 0.6),
  positive: family(158, 0.13, 0.66, 0.55),
  caution: family(64, 0.155, 0.74, 0.58),
  negative: family(26, 0.175, 0.62, 0.56),
  info: family(258, 0.15, 0.62, 0.56),
};

/** The colour of a family whose WCAG luminance is `Y` (bisection on OKLCH L). */
function atLuminance(fam, Y) {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 48; i++) {
    const L = (lo + hi) / 2;
    if (luminance(oklchToRgb([L, fam.chroma(L), fam.h])) < Y) lo = L;
    else hi = L;
  }
  const L = (lo + hi) / 2;
  return oklchToRgb([L, fam.chroma(L), fam.h]);
}

/** A family at a contrast ratio against `bg`, lighter or darker than it. */
function atContrast(fam, ratio, bg, side) {
  const yb = luminance(bg);
  const Y = side === 'lighter' ? ratio * (yb + 0.05) - 0.05 : (yb + 0.05) / ratio - 0.05;
  return atLuminance(fam, Y);
}

/* ----------------------------------------------------------------------- scales */

const STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
// WCAG luminance per step from 400 up. Light runs pale → deep, dark runs
// just-off-navy → pale, so a step means the same distance from the surface in
// both themes.
const LADDER = {
  light: { 400: 0.42, 500: 0.29, 600: 0.2, 700: 0.14, 800: 0.095, 900: 0.062, 950: 0.036 },
  dark: { 400: 0.085, 500: 0.135, 600: 0.205, 700: 0.295, 800: 0.415, 900: 0.575, 950: 0.77 },
};
// 50–300 are washes: the family's 600 step laid over the theme's card, so a
// tint carries the surface's own hue (a red wash on navy is navy-red, not
// maroon) and sits calmly behind 800 ink.
const WASH = { light: { 50: 0.06, 100: 0.11, 200: 0.2, 300: 0.36 }, dark: { 50: 0.1, 100: 0.17, 200: 0.27, 300: 0.42 } };
const SURFACE = { light: [255, 255, 255], dark: [11, 24, 50] };
function scale(theme, name) {
  const fam = FAMILIES[name];
  const out = {};
  for (const [step, Y] of Object.entries(LADDER[theme])) out[step] = atLuminance(fam, Y);
  for (const [step, a] of Object.entries(WASH[theme])) out[step] = over(out[600], SURFACE[theme], a).map(Math.round);
  return out;
}

/* ----------------------------------------------------------------------- tokens */

const NAVY = [11, 24, 50];
const WHITE = [255, 255, 255];
const F = FAMILIES;

/**
 * Each token: [value, note]. Brand values are literal; the rest are a family at
 * the contrast the token already had on its surface (rule 1 above).
 */
const DARK = {
  // The brand, exactly.
  navy: [NAVY, 'card surface'],
  'navy-secondary': [[20, 43, 82], 'raised: hover, selected row'],
  midnight: [[8, 15, 32], 'page'],
  'surface-overlay': [oklchToRgb([0.248, 0.064, 262]), 'menus, popovers, dialogs, tooltips — one step above a card'],
  gold: [[217, 185, 103], 'brand gold'],
  'gold-bright': [[240, 216, 120], 'gold hover, focus'],
  'gold-fill': [[217, 185, 103], 'gold as a fill under on-accent ink'],
  'gold-fill-bright': [[240, 216, 120], ''],
  // Lines: card edge, list divider, control boundary (3:1, WCAG 1.4.11).
  line: [[42, 74, 126], '2.0:1 — card edges'],
  'line-subtle': [oklchToRgb([0.33, 0.072, 261]), 'row dividers'],
  'line-strong': [[85, 115, 165], '3.7:1 — form controls'],
  // Greys.
  fg: [WHITE, 'primary text'],
  silver: [atContrast(F.neutral, 11.2, NAVY, 'lighter'), 'secondary text'],
  'silver-floor': [atContrast(F.neutral, 4.8, NAVY, 'lighter'), 'silver/30–/50, floored'],
  muted: [atContrast(F.neutral, 3.08, NAVY, 'lighter'), 'placeholders, disabled'],
  // Status.
  steel: [atContrast(F.info, 6.94, NAVY, 'lighter'), 'info'],
  sky: [atContrast(F.info, 15.4, NAVY, 'lighter'), 'info badge text'],
  alert: [atContrast(F.negative, 5.33, NAVY, 'lighter'), 'negative'],
  success: [atContrast(F.positive, 5.88, NAVY, 'lighter'), 'positive'],
  warning: [atContrast(F.caution, 9.27, NAVY, 'lighter'), 'caution'],
  // One lighter step for status text on the raised surface.
  'success-raised': [atContrast(F.positive, 7.4, NAVY, 'lighter'), ''],
  'alert-raised': [atContrast(F.negative, 7.1, NAVY, 'lighter'), ''],
  'steel-raised': [atContrast(F.info, 8.11, NAVY, 'lighter'), ''],
  teal: [[15, 110, 86], 'surface tint'],
  // Charts: marks only. 1 and 2 join their families; 3–5 are the validated trio.
  'chart-teal': [[45, 212, 191], ''],
  'chart-1': [atContrast(F.accent, 5.57, NAVY, 'lighter'), ''],
  'chart-2': [atContrast(F.info, 4.8, NAVY, 'lighter'), ''],
  'chart-3': [[13, 148, 136], ''],
  'chart-4': [[144, 133, 233], ''],
  'chart-5': [[213, 81, 129], ''],
  'chart-other': [atContrast(F.neutral, 3.26, NAVY, 'lighter'), ''],
  // Theme-stable ink on fills.
  'on-accent': [NAVY, 'dark ink on gold'],
  'on-solid': [WHITE, 'white on a saturated fill'],
  'on-alert': [NAVY, 'the alert fill carries dark ink here'],
};

const LIGHT = {
  navy: [WHITE, 'card surface'],
  'navy-secondary': [atContrast(F.neutral, 1.233, WHITE, 'darker'), 'raised: hover, selected row'],
  midnight: [atContrast(F.neutral, 1.046, WHITE, 'darker'), 'page'],
  'surface-overlay': [WHITE, 'menus, popovers, dialogs — lifted by shadow'],
  gold: [[135, 104, 12], 'brand gold as text, 5.2:1'],
  'gold-bright': [[122, 89, 6], 'the more emphatic step on white'],
  // The fill tier was CSS darkgoldenrod; now the brand gold's own hue.
  'gold-fill': [atContrast(F.accent, 3.255, WHITE, 'darker'), 'gold fill under on-accent ink'],
  'gold-fill-bright': [atContrast(F.accent, 2.41, WHITE, 'darker'), ''],
  line: [atContrast(F.neutral, 1.945, WHITE, 'darker'), 'card edges'],
  'line-subtle': [atContrast(F.neutral, 1.3, WHITE, 'darker'), 'row dividers'],
  'line-strong': [atContrast(F.neutral, 3.42, WHITE, 'darker'), 'form controls'],
  'line-hover': [atContrast(F.neutral, 4.76, WHITE, 'darker'), 'form controls on hover'],
  fg: [atContrast(F.neutral, 17.86, WHITE, 'darker'), 'primary text'],
  silver: [atContrast(F.neutral, 10.36, WHITE, 'darker'), 'secondary text'],
  'silver-floor': [atContrast(F.neutral, 5.7, WHITE, 'darker'), 'silver/30–/70, floored'],
  muted: [atContrast(F.neutral, 2.565, WHITE, 'darker'), 'placeholders, disabled'],
  steel: [atContrast(F.info, 5.17, WHITE, 'darker'), 'info'],
  sky: [atContrast(F.info, 6.71, WHITE, 'darker'), 'info badge text'],
  alert: [atContrast(F.negative, 6.47, WHITE, 'darker'), 'negative'],
  success: [atContrast(F.positive, 7.69, WHITE, 'darker'), 'positive'],
  warning: [atContrast(F.caution, 7.1, WHITE, 'darker'), 'caution'],
  teal: [[15, 118, 110], ''],
  'chart-teal': [[13, 148, 136], ''],
  'chart-1': [atContrast(F.accent, 3.255, WHITE, 'darker'), ''],
  'chart-2': [atContrast(F.info, 5.17, WHITE, 'darker'), ''],
  'chart-3': [[13, 148, 136], ''],
  'chart-4': [[74, 58, 167], ''],
  'chart-5': [[213, 81, 129], ''],
  'chart-other': [atContrast(F.neutral, 3.64, WHITE, 'darker'), ''],
  'on-accent': [NAVY, ''],
  'on-solid': [WHITE, ''],
  'on-alert': [WHITE, ''],
};

/* ----------------------------------------------------------------------- floors */

/** Pairings the generator refuses to write below their floor. */
function checks(theme) {
  const T = theme === 'dark' ? DARK : LIGHT;
  const v = (k) => T[k][0];
  const card = v('navy');
  const page = v('midnight');
  const out = [];
  const need = (label, ratio, floor) => out.push({ label, ratio, floor });
  for (const k of ['silver', 'gold', 'alert', 'success', 'warning', 'steel', 'fg']) {
    need(`${k} on card`, contrast(v(k), card), 4.5);
    need(`${k} on page`, contrast(v(k), page), 4.5);
  }
  need('silver-floor on card', contrast(v('silver-floor'), card), 4.5);
  need('on-accent on gold-fill', contrast(v('on-accent'), v('gold-fill')), 4.5);
  need('on-accent on gold-fill-bright', contrast(v('on-accent'), v('gold-fill-bright')), 4.5);
  need('line-strong on card', contrast(v('line-strong'), card), 3);
  need('line-strong on page', contrast(v('line-strong'), page), 3);
  need('chart-other on card', contrast(v('chart-other'), card), 3);
  for (const k of ['chart-1', 'chart-2']) need(`${k} on card`, contrast(v(k), card), 3);
  // Same-hue chip on its own wash: /15 dark, capped /8 light.
  const wash = theme === 'dark' ? 0.15 : 0.08;
  for (const k of ['gold', 'alert', 'warning', 'success']) need(`${k} chip`, contrast(v(k), over(v(k), card, wash)), 4.5);
  need('info chip (sky on steel wash)', contrast(v('sky'), over(v('steel'), card, wash)), 4.5);
  if (theme === 'dark') {
    const raised = v('navy-secondary');
    for (const [k, base] of [['success-raised', 'success'], ['alert-raised', 'alert'], ['steel-raised', 'steel']]) {
      need(`${k} on raised`, contrast(v(k), raised), 4.5);
      need(`${k} on its wash over raised`, contrast(v(k), over(v(base), raised, 0.15)), 4.5);
    }
    need('on-alert on alert fill', contrast(v('on-alert'), v('alert')), 4.5);
  } else {
    need('on-alert on alert fill', contrast(v('on-alert'), v('alert')), 4.5);
    need('line-hover on card', contrast(v('line-hover'), card), 4.5);
    need('silver-floor on raised', contrast(v('silver-floor'), v('navy-secondary')), 4.5);
  }
  // The scale chips the kit uses: step-100 wash, step-800 ink, on every surface.
  for (const name of ['accent', 'positive', 'caution', 'negative', 'info', 'neutral']) {
    const s = scale(theme, name);
    need(`${name}-800 on ${name}-100`, contrast(s[800], s[100]), 4.5);
    need(`${name}-800 on card`, contrast(s[800], card), 4.5);
    need(`${name}-800 on overlay`, contrast(s[800], v('surface-overlay')), 4.5);
  }
  return out;
}

/* -------------------------------------------------------------------------- CSS */

const triplet = (rgb) => rgb.map((c) => String(Math.round(c)).padStart(3, ' ')).join(' ');

function block(theme) {
  const T = theme === 'dark' ? DARK : LIGHT;
  const lines = [];
  const width = Math.max(...Object.keys(T).map((k) => k.length)) + 10;
  for (const [k, [rgb, note]] of Object.entries(T)) {
    const name = `--color-${k}:`.padEnd(width);
    lines.push(`  ${name}${triplet(rgb)};  /* ${hex(rgb)}${note ? ` — ${note}` : ''} */`);
  }
  lines.push('  /* Scales: 50 faintest … 950 strongest, in this theme (scripts/palette.mjs). */');
  for (const name of Object.keys(FAMILIES)) {
    const s = scale(theme, name);
    for (const step of STEPS) lines.push(`  --color-${name}-${step}: ${triplet(s[step])};  /* ${hex(s[step])} */`);
  }
  return lines.join('\n');
}

const MARK = (theme) => [`  /* @palette ${theme} — generated by scripts/palette.mjs; edit there, then run it. */`, `  /* @palette ${theme} end */`];

function render(css) {
  let out = css;
  for (const theme of ['dark', 'light']) {
    const [open, close] = MARK(theme);
    const a = out.indexOf(open);
    const b = out.indexOf(close);
    if (a === -1 || b === -1) throw new Error(`index.css: the @palette ${theme} markers are missing`);
    out = out.slice(0, a + open.length) + '\n' + block(theme) + '\n' + out.slice(b);
  }
  return out;
}

function preview(path) {
  const sw = (rgb, label) => `<div class="sw" style="background:${hex(rgb)}"><span>${label}</span><code>${hex(rgb)}</code></div>`;
  const section = (theme) => {
    const T = theme === 'dark' ? DARK : LIGHT;
    const bg = hex(T.navy[0]);
    const ink = hex(T.fg[0]);
    const rows = Object.keys(FAMILIES)
      .map((n) => `<div class="row"><b>${n}</b>${STEPS.map((s) => sw(scale(theme, n)[s], s)).join('')}</div>`)
      .join('');
    const toks = Object.entries(T).map(([k, [rgb]]) => sw(rgb, k)).join('');
    return `<section style="background:${hex(T.midnight[0])};color:${ink}"><h2>${theme}</h2><div class="card" style="background:${bg}">${rows}<div class="toks">${toks}</div></div></section>`;
  };
  writeFileSync(
    path,
    `<!doctype html><meta charset="utf-8"><title>Palette</title><style>body{margin:0;font:12px system-ui}section{padding:16px}.card{padding:12px;border-radius:8px}.row{display:flex;gap:4px;align-items:center;margin:4px 0}.row b{width:70px}.sw{width:76px;height:44px;border-radius:4px;display:flex;flex-direction:column;justify-content:flex-end;padding:3px;box-sizing:border-box}.sw span,.sw code{font-size:9px;color:#fff;mix-blend-mode:difference}.toks{display:flex;flex-wrap:wrap;gap:4px;margin-top:10px}</style>${section('dark')}${section('light')}`,
  );
}

/* ------------------------------------------------------------------------- main */

const args = process.argv.slice(2);
const failures = [...checks('dark').map((c) => ({ ...c, theme: 'dark' })), ...checks('light').map((c) => ({ ...c, theme: 'light' }))].filter(
  (c) => c.ratio < c.floor,
);
if (failures.length) {
  for (const f of failures) console.error(`palette: ${f.theme} ${f.label} = ${f.ratio.toFixed(2)} (needs ${f.floor})`);
  process.exit(1);
}
if (args[0] === '--preview') {
  preview(resolve(process.cwd(), args[1] ?? 'palette-preview.html'));
  console.log('palette: preview written');
} else {
  const css = readFileSync(CSS_PATH, 'utf8');
  const next = render(css);
  if (args.includes('--check')) {
    if (next !== css) {
      console.error('palette: src/index.css is out of date — run node scripts/palette.mjs');
      process.exit(1);
    }
    console.log('palette: ok');
  } else {
    writeFileSync(CSS_PATH, next);
    console.log('palette: index.css written');
  }
}
