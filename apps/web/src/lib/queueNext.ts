/**
 * The one "next record" rule for every decision drawer (ease-of-use sweep,
 * 2026-10-22): after a decision, a queue moves on to the next row still
 * waiting instead of closing and sending the person back to hunt for it.
 *
 * `rows` is the list in the order the person sees it. The row just decided
 * is skipped even when the list has not refetched yet, and the search wraps
 * past the end so the last row chains back to the first still waiting.
 * `eligible` says which rows are still worth opening (pending, uploaded,
 * draft…); with none, the drawer closes — that is the honest end of the
 * queue, not an error.
 */
export function nextInQueue<T extends { id: string }>(
  rows: readonly T[],
  currentId: string,
  eligible: (row: T) => boolean = () => true,
): T | null {
  const n = rows.length;
  if (n === 0) return null;
  const at = rows.findIndex((r) => r.id === currentId);
  // Unknown current row (already gone from the list): start from the top.
  const start = at === -1 ? 0 : at + 1;
  for (let step = 0; step < n; step += 1) {
    const row = rows[(start + step) % n]!;
    if (row.id === currentId) continue;
    if (eligible(row)) return row;
  }
  return null;
}

/** The row before the current one in view, wrapping; null when alone. */
export function prevInQueue<T extends { id: string }>(rows: readonly T[], currentId: string): T | null {
  const n = rows.length;
  if (n < 2) return null;
  const at = rows.findIndex((r) => r.id === currentId);
  if (at === -1) return rows[n - 1] ?? null;
  return rows[(at - 1 + n) % n] ?? null;
}
