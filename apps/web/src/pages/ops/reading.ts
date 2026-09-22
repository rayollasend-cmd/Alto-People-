/**
 * Readings below zero — shared by the supervisor recording a freezer
 * temperature (OpsRunner) and the lead authoring its allowed band
 * (OpsLibrary).
 *
 * A freezer reads -30°F, and the decimal keypad a phone or store tablet
 * raises for `inputMode="decimal"` has no minus key — the sign has to
 * come from a ± button beside the field. Parsing also normalises the
 * Unicode minus/dash a keyboard or a pasted log can deliver, and treats
 * a lone sign mid-typing as "nothing yet".
 */

/** U+2212 minus and the dashes that read as one, mapped to plain "-". */
const normalizeSign = (raw: string) =>
  raw.trim().replace(/^[−–—‒]/, '-');

/** A finite number, or null for empty and for a half-typed lone sign. */
export function parseReading(raw: string): number | null {
  const normalized = normalizeSign(raw);
  if (normalized === '' || normalized === '-') return null;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

/** The keypad's missing minus: flip the sign of a half-typed reading. */
export function flipReadingSign(raw: string): string {
  const normalized = normalizeSign(raw);
  return normalized.startsWith('-') ? normalized.slice(1) : `-${normalized}`;
}

export const isNegativeReading = (raw: string) => normalizeSign(raw).startsWith('-');
