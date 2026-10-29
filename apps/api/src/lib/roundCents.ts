/**
 * Money rounding to the cent, half away from zero (deep audit CODE-27).
 *
 * A dollar amount arrives as a binary float that is only close to the
 * decimal it means: 0.5 h × $8.03 is 4.015 on paper but 4.01499999999999…
 * in IEEE 754, so `Math.round(n * 100) / 100` — and the old
 * `Math.round((n + Number.EPSILON) * 100) / 100`, whose nudge is far too
 * small for anything over a dollar — paid $4.01 where the arithmetic says
 * $4.02. About one exact half-cent in twenty rounded down that way.
 *
 * The fix decides on the decimal the number stands for: scale to cents,
 * read that back at 15 significant digits (the precision a double carries,
 * so representation noise in the 16th–17th digit is dropped but every
 * real fraction is kept), then round the cents half away from zero.
 * Negatives mirror positives (−4.015 → −4.02), so a clawback rounds the
 * same way as the pay it reverses.
 */
export function roundCents(n: number): number {
  if (!Number.isFinite(n)) return n;
  const cents = Math.round(Number((Math.abs(n) * 100).toPrecision(15)));
  if (cents === 0) return 0;
  return (n < 0 ? -cents : cents) / 100;
}
