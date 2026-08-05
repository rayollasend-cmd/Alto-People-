/**
 * Chart colors that follow the design tokens.
 *
 * Recharts takes literal color strings, so charts can't use Tailwind
 * classes — the palette hexes were hand-copied into each chart file and
 * silently drifted from the tokens (and never flipped with the light/dark
 * theme). This helper reads the CSS custom properties off <html> at CALL
 * time, so a palette retune in index.css — or the theme flip, which swaps
 * the same vars via [data-theme] — propagates to every chart on the next
 * render with no per-chart edits.
 *
 * The tokens are stored as RGB triplets ("52 168 116", see index.css /
 * tailwind.config.js) so Tailwind can apply <alpha-value>; we wrap them in
 * rgb() to make a valid color string for SVG fills.
 */

export type ChartColorToken =
  | 'gold'
  | 'gold-bright'
  | 'silver'
  | 'steel'
  | 'teal'
  | 'alert'
  | 'success'
  | 'warning'
  | 'muted';

// Dark-theme (default) values, mirroring index.css :root. Used when there
// is no DOM (SSR) or when the stylesheet isn't loaded (jsdom tests, where
// getComputedStyle returns '' for custom properties).
const FALLBACK: Record<ChartColorToken, string> = {
  gold: '#D9B967',
  'gold-bright': '#F0D878',
  silver: '#C0D0E0',
  steel: '#185FA5',
  teal: '#0F6E56',
  alert: '#E96255',
  success: '#34A874',
  warning: '#EDB23C',
  muted: '#666666',
};

/**
 * Resolve a palette token to a concrete CSS color string for chart fills.
 * Call it during render (not at module scope) so a theme flip re-resolves.
 */
export function chartColor(token: ChartColorToken): string {
  if (typeof document === 'undefined') return FALLBACK[token];
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(`--color-${token}`)
    .trim();
  return raw ? `rgb(${raw})` : FALLBACK[token];
}
