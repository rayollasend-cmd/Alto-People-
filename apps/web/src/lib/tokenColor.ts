/**
 * A design token as a concrete colour string, for the places a CSS variable
 * can't reach: MapLibre parses its paint colours itself (`line-color` has
 * to be a real colour, not `rgb(var(--color-gold))`), and the same goes
 * for anything drawn on a canvas.
 *
 * Reads the token's current value off <html> at call time, so it follows
 * the theme the page is in; when the stylesheet isn't there to read (a
 * test, a page torn down mid-paint) it falls back to the dark theme's
 * value from index.css. Output is the comma form `rgb(r, g, b)` /
 * `rgba(r, g, b, a)`, which every colour parser accepts.
 *
 * HTML painted by hand (map markers) can keep using the live variable —
 * `tokenVar('gold-fill')` — so it repaints with the theme on its own.
 */

/** The tokens the map and the ECharts figures draw with, with their dark-theme values (index.css :root). */
const FALLBACK = {
  'gold-fill': '217 185 103',
  'on-accent': '11 24 50',
  'on-solid': '255 255 255',
  navy: '11 24 50',
  'navy-secondary': '20 43 82',
  silver: '192 208 224',
  fg: '255 255 255',
  'chart-1': '176 140 46',
  'chart-2': '59 130 246',
  'chart-3': '13 148 136',
  'chart-4': '144 133 233',
  'chart-5': '213 81 129',
  'chart-other': '93 107 128',
  alert: '233 98 85',
  warning: '237 178 60',
  success: '52 168 116',
  steel: '96 165 250',
} as const;

export type ColorToken = keyof typeof FALLBACK;

const TRIPLE = /^(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})$/;

export function tokenColor(name: ColorToken, alpha?: number, root?: Element): string {
  let raw = '';
  try {
    const el = root ?? (typeof document !== 'undefined' ? document.documentElement : null);
    if (el && typeof getComputedStyle === 'function') raw = getComputedStyle(el).getPropertyValue(`--color-${name}`).trim();
  } catch {
    raw = '';
  }
  const m = TRIPLE.exec(raw) ?? TRIPLE.exec(FALLBACK[name])!;
  const [, r, g, b] = m;
  return alpha === undefined ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** The live CSS form, for inline styles on HTML the page paints itself. */
export function tokenVar(name: ColorToken, alpha?: number): string {
  return alpha === undefined ? `rgb(var(--color-${name}))` : `rgb(var(--color-${name}) / ${alpha})`;
}
