/**
 * Deterministic position → color mapping.
 *
 * Sling's biggest visual win in the calendar is that every role reads as
 * a colored block — the schedule becomes a coverage heatmap at a glance
 * instead of a wall of dark chips. Same idea here, with two constraints:
 *
 *  - **Stable across sessions.** "Server" must look the same in every
 *    week, every client, every browser, or the heatmap reading falls
 *    apart. We hash the lowercase trimmed name and index a fixed palette
 *    rather than randomising once per render.
 *
 *  - **Brand-aligned.** Sling can lean rainbow because their UI is
 *    light-mode neutral. We're on a navy/gold premium palette, so the
 *    chip colors stay desaturated, all play nicely against navy, and
 *    none clash with the gold accent reserved for selection/focus.
 */

export interface PositionColor {
  /** Tailwind-compatible HSL for the chip's left accent bar + ring. */
  accent: string;
  /** Faint tint for the chip background — keeps text legible on navy. */
  bg: string;
  /** Border tint that matches the accent at low alpha. */
  border: string;
  /** A readable label color when the chip is in selected/hover state. */
  text: string;
}

// 12 hand-picked HSLs. Hue spread ~30° apart so adjacent positions in the
// hash are visually distinct. Fixed saturation/lightness so every chip
// reads at the same visual weight (no chip dominating because it landed
// on a hot color). Avoids the gold band (35°–55°) — that's reserved for
// brand selection state.
const PALETTE: PositionColor[] = [
  // teal
  { accent: 'hsl(180 60% 55%)', bg: 'hsl(180 60% 55% / 0.10)', border: 'hsl(180 60% 55% / 0.40)', text: 'hsl(180 60% 75%)' },
  // sky blue
  { accent: 'hsl(205 70% 60%)', bg: 'hsl(205 70% 60% / 0.10)', border: 'hsl(205 70% 60% / 0.40)', text: 'hsl(205 70% 78%)' },
  // indigo
  { accent: 'hsl(235 60% 65%)', bg: 'hsl(235 60% 65% / 0.10)', border: 'hsl(235 60% 65% / 0.40)', text: 'hsl(235 60% 80%)' },
  // violet
  { accent: 'hsl(265 55% 65%)', bg: 'hsl(265 55% 65% / 0.10)', border: 'hsl(265 55% 65% / 0.40)', text: 'hsl(265 55% 80%)' },
  // magenta
  { accent: 'hsl(310 55% 65%)', bg: 'hsl(310 55% 65% / 0.10)', border: 'hsl(310 55% 65% / 0.40)', text: 'hsl(310 55% 80%)' },
  // rose
  { accent: 'hsl(345 65% 65%)', bg: 'hsl(345 65% 65% / 0.10)', border: 'hsl(345 65% 65% / 0.40)', text: 'hsl(345 65% 80%)' },
  // coral
  { accent: 'hsl(15 70% 60%)', bg: 'hsl(15 70% 60% / 0.10)', border: 'hsl(15 70% 60% / 0.40)', text: 'hsl(15 70% 78%)' },
  // amber-orange (kept distinct from gold by lower lightness)
  { accent: 'hsl(25 75% 55%)', bg: 'hsl(25 75% 55% / 0.10)', border: 'hsl(25 75% 55% / 0.40)', text: 'hsl(25 75% 75%)' },
  // lime
  { accent: 'hsl(90 50% 55%)', bg: 'hsl(90 50% 55% / 0.10)', border: 'hsl(90 50% 55% / 0.40)', text: 'hsl(90 50% 75%)' },
  // emerald
  { accent: 'hsl(150 50% 55%)', bg: 'hsl(150 50% 55% / 0.10)', border: 'hsl(150 50% 55% / 0.40)', text: 'hsl(150 50% 75%)' },
  // cyan
  { accent: 'hsl(195 65% 60%)', bg: 'hsl(195 65% 60% / 0.10)', border: 'hsl(195 65% 60% / 0.40)', text: 'hsl(195 65% 78%)' },
  // slate-blue
  { accent: 'hsl(220 35% 65%)', bg: 'hsl(220 35% 65% / 0.10)', border: 'hsl(220 35% 65% / 0.40)', text: 'hsl(220 35% 80%)' },
];

const NEUTRAL: PositionColor = {
  accent: 'hsl(220 10% 60%)',
  bg: 'hsl(220 10% 60% / 0.08)',
  border: 'hsl(220 10% 60% / 0.30)',
  text: 'hsl(220 10% 80%)',
};

/**
 * djb2 — small, fast, deterministic, decent distribution for short strings
 * like job titles. Nothing crypto-grade needed; we just want stable picks.
 */
function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 33) ^ s.charCodeAt(i);
  }
  return h >>> 0;
}

export function colorForPosition(name: string | null | undefined): PositionColor {
  if (!name) return NEUTRAL;
  const norm = name.trim().toLowerCase();
  if (!norm) return NEUTRAL;
  return PALETTE[djb2(norm) % PALETTE.length];
}
