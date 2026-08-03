import { describe, expect, it } from 'vitest';
import { isDateOnly, parseDateOnly, toDateOnly } from '../dateOnly.js';

// A calendar date must survive the round trip unchanged, in every zone.
// The bug these guard against: serializing a @db.Date with toISOString()
// and parsing it with new Date() renders the PREVIOUS day west of UTC.

describe('toDateOnly', () => {
  it('reads the UTC calendar day, which is the day Prisma stored', () => {
    // Prisma materialises a DATE column as UTC midnight.
    expect(toDateOnly(new Date('2026-03-01T00:00:00.000Z'))).toBe('2026-03-01');
  });

  it('does not drift for dates late in the UTC day', () => {
    expect(toDateOnly(new Date('2026-12-31T23:59:59.000Z'))).toBe('2026-12-31');
  });

  it('zero-pads single-digit months and days', () => {
    expect(toDateOnly(new Date('2026-01-05T00:00:00.000Z'))).toBe('2026-01-05');
  });

  it('passes null through', () => {
    expect(toDateOnly(null)).toBeNull();
    expect(toDateOnly(undefined)).toBeNull();
  });

  it('returns null for an invalid date rather than "NaN-NaN-NaN"', () => {
    expect(toDateOnly(new Date('nope'))).toBeNull();
  });
});

describe('isDateOnly', () => {
  it('matches only a complete YYYY-MM-DD', () => {
    expect(isDateOnly('2026-03-01')).toBe(true);
    // Must NOT match a timestamp's prefix — a genuine instant has to keep
    // rendering in the viewer's zone.
    expect(isDateOnly('2026-03-01T00:00:00.000Z')).toBe(false);
    expect(isDateOnly('2026-3-1')).toBe(false);
    expect(isDateOnly('')).toBe(false);
    expect(isDateOnly(null)).toBe(false);
  });
});

describe('parseDateOnly', () => {
  it('anchors at LOCAL midnight so the date renders as itself', () => {
    const d = parseDateOnly('2026-03-01')!;
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(2); // March
    expect(d.getDate()).toBe(1);
    expect(d.getHours()).toBe(0);
  });

  it('round-trips through toDateOnly for the stored (UTC) form', () => {
    const stored = new Date('2026-07-04T00:00:00.000Z');
    const wire = toDateOnly(stored)!;
    const parsed = parseDateOnly(wire)!;
    // Same calendar day the database holds, expressed locally.
    expect(parsed.getDate()).toBe(4);
    expect(parsed.getMonth()).toBe(6);
  });

  it('returns null for malformed input', () => {
    expect(parseDateOnly('2026-13-45')).not.toBeNull(); // shape ok; Date normalises
    expect(parseDateOnly('not-a-date')).toBeNull();
  });
});
