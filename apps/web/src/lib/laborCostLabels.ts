/**
 * Store labels for the labor-cost pages: two stores sharing a name read
 * as one ("The Grand Hotel" ×4 — four identical filter options and rows).
 */
/** Give repeated store names a client (then a short id) so each reads once. */
export function disambiguateStores<R extends { locationId: string | null; locationName: string | null; clientName: string | null }>(rows: R[]): R[] {
  const idsByName = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.locationId || !r.locationName) continue;
    const set = idsByName.get(r.locationName) ?? new Set<string>();
    set.add(r.locationId);
    idsByName.set(r.locationName, set);
  }
  const clientOf = new Map<string, string | null>();
  for (const r of rows) if (r.locationId) clientOf.set(r.locationId, r.clientName ?? null);
  const label = new Map<string, string>();
  for (const [name, ids] of idsByName) {
    if (ids.size < 2) continue;
    const withClient = [...ids].map((id) => ({ id, l: clientOf.get(id) ? `${name} — ${clientOf.get(id)}` : name }));
    const counts = new Map<string, number>();
    for (const w of withClient) counts.set(w.l, (counts.get(w.l) ?? 0) + 1);
    for (const w of withClient) label.set(w.id, (counts.get(w.l) ?? 0) > 1 ? `${w.l} · #${w.id.slice(0, 4)}` : w.l);
  }
  if (label.size === 0) return rows;
  return rows.map((r) => (r.locationId && label.has(r.locationId) ? { ...r, locationName: label.get(r.locationId)! } : r));
}
