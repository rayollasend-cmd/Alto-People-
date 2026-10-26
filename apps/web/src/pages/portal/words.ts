/**
 * A shift or window name said mid-sentence: "today's morning window", not
 * "today's Morning window". The store's windows are named in title case
 * ("Morning", "Swing", "Overnight") because they head lists and columns;
 * inside a sentence they are ordinary words. A name whose second letter is
 * a capital ("AM", "QA crew") is an acronym and keeps its case.
 */
export function midSentence(label: string): string {
  if (label.length < 2) return label;
  const second = label[1]!;
  return second === second.toLowerCase() ? label[0]!.toLowerCase() + label.slice(1) : label;
}

/** The delivered-hours bar the portal measures against (owner decision 2026-09-16). */
export const DELIVERED_TARGET_PCT = 88;
