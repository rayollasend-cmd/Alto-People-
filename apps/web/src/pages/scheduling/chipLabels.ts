import type { Shift } from '@alto-people/shared';

/**
 * What a week-grid chip says in the room it has (FLOOR-12, deep audit
 * 2026-10-29): the position cut to one letter ("6a–2p S…") and no store,
 * so a supervisor running three stores couldn't tell a Front Beach shift
 * from a Thomas Drive one without opening each. Pure helpers, no React.
 */

/** Generic trailing words a chip can drop: "Deli associate" is "Deli" on a schedule. */
const GENERIC_TAIL = /\s+(associate|team member|crew member|worker|attendant|staff)$/i;

/**
 * The position as a chip shows it: the whole name, less a generic
 * trailing word ("Deli associate" → "Deli", "GM floor associate" →
 * "GM floor"). The full name stays in the chip's title and hover card.
 */
export function positionShort(position: string): string {
  const name = position.trim().replace(/\s+/g, ' ');
  const short = name.replace(GENERIC_TAIL, '');
  return short.length > 0 ? short : name;
}

/** "Front Beach 218" → "FB"; "Seaside Grand · Tallahassee" → "SG"; "Seaside" → "SE". */
function initials(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0 && !/^\d+$/.test(w));
  if (words.length === 0) return name.replace(/\s+/g, '').slice(0, 2).toUpperCase();
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  // Two letters at most — a chip is 78px wide at 1024 ("Seaside Grand ·
  // Tallahassee" is "SG"); a clash with another store adds its number.
  return words
    .slice(0, 2)
    .map((w) => w[0]!)
    .join('')
    .toUpperCase();
}

/** The store number in a name ("Front Beach 218" → "218"), if any. */
function storeNumber(name: string): string | null {
  const m = name.match(/\b(\d{1,5})\b/);
  return m ? m[1]! : null;
}

/**
 * A short tag per store, ONLY when the shifts in view span more than one
 * store (one store needs no tag): initials of the store's name, with its
 * number (or a counter) added when two stores would share initials.
 * Keyed by locationId; shifts with no store get no tag.
 */
export function storeTags(shifts: ReadonlyArray<Pick<Shift, 'locationId' | 'locationName' | 'location'>>): Map<string, string> {
  const names = new Map<string, string>();
  for (const s of shifts) {
    if (!s.locationId || names.has(s.locationId)) continue;
    names.set(s.locationId, (s.locationName ?? s.location ?? '').trim());
  }
  const out = new Map<string, string>();
  if (names.size < 2) return out;
  const byInitials = new Map<string, string[]>();
  for (const [id, name] of names) {
    const tag = initials(name || '?');
    byInitials.set(tag, [...(byInitials.get(tag) ?? []), id]);
  }
  for (const [tag, ids] of byInitials) {
    if (ids.length === 1) {
      out.set(ids[0]!, tag);
      continue;
    }
    // Same initials: tell them apart by store number, else by order.
    ids
      .slice()
      .sort((a, b) => (names.get(a) ?? '').localeCompare(names.get(b) ?? ''))
      .forEach((id, i) => out.set(id, `${tag}${storeNumber(names.get(id) ?? '') ?? i + 1}`));
  }
  return out;
}
