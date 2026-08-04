/**
 * Calendar dates on the wire.
 *
 * 51 columns are `@db.Date` — a start date, a hire date, a birthday, a
 * benefits effective date. Prisma hands those back as a Date at UTC
 * midnight. Serializing them with `.toISOString()` produces
 * "2026-03-01T00:00:00.000Z", and any browser west of Greenwich formats
 * that as **February 28**. That is exactly the bug users saw: an
 * application's start date read a day early on the list screen while the
 * detail screen — which happened to parse it differently — read
 * correctly.
 *
 * The rule: a calendar date crosses the wire as `YYYY-MM-DD`, never as a
 * timestamp. There is no time and no zone to preserve, so encoding one
 * can only introduce error.
 */

/**
 * Serialize a `@db.Date` value as `YYYY-MM-DD`.
 *
 * Reads the UTC components deliberately: Prisma materialises a DATE as
 * UTC midnight, so the UTC calendar day IS the stored day. Using local
 * getters here would reintroduce the shift this function exists to
 * prevent.
 */
export function toDateOnly(value: Date | null | undefined): string | null {
  if (!value) return null;
  const t = value.getTime();
  if (Number.isNaN(t)) return null;
  const y = value.getUTCFullYear();
  const m = String(value.getUTCMonth() + 1).padStart(2, '0');
  const d = String(value.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** True for a well-formed `YYYY-MM-DD` string. */
export function isDateOnly(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * Parse `YYYY-MM-DD` into a Date at LOCAL midnight — the correct anchor
 * for display. `new Date('2026-03-01')` parses as UTC midnight and then
 * formats a day early in western zones; this does not.
 */
export function parseDateOnly(value: string): Date | null {
  if (!isDateOnly(value)) return null;
  const [y, m, d] = value.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}
