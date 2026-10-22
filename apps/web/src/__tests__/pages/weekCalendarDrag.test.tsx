import { describe, expect, it } from 'vitest';
import type { Shift } from '@alto-people/shared';
import { dayIsPast, dropFitFor, isCopyDrag, shiftTimesOnDay, WEEK_OT_MINUTES } from '@/pages/scheduling/weekGridFit';

/**
 * Role walk, ops 8: Alt-drag copies instead of moving, and every cell says
 * what the drop would do to the person while the chip is in the air.
 */

const shift = (over: Partial<Shift> = {}): Shift =>
  ({
    id: 's1',
    clientId: 'c1',
    clientName: 'Grand Hotel',
    position: 'Housekeeper',
    startsAt: '2026-10-22T13:00:00.000Z', // 9a New York
    endsAt: '2026-10-22T21:00:00.000Z', // 5p
    location: null,
    locationId: 'l1',
    locationName: 'Front Beach',
    timezone: 'America/New_York',
    hourlyRate: null,
    payRate: null,
    effectivePayRate: null,
    status: 'ASSIGNED',
    notes: null,
    assignedAssociateId: 'a1',
    assignedAssociateName: 'Ana Reyes',
    assignedAt: null,
    cancellationReason: null,
    scheduledMinutes: 480,
    publishedAt: null,
    lateNoticeReason: null,
    acknowledgedAt: null,
    ...over,
  }) as Shift;

describe('dropFitFor', () => {
  const fit = { dows: new Set([1, 2, 3, 4, 5]), blocked: new Set(['2026-10-23']) };

  it('is red on an approved time-off day, before anything else', () => {
    expect(dropFitFor({ associateId: 'a2', dayKey: '2026-10-23', dow: 5 }, shift(), fit, 0)).toBe('blocked');
  });

  it('is amber outside the weekly windows', () => {
    expect(dropFitFor({ associateId: 'a2', dayKey: '2026-10-24', dow: 6 }, shift(), fit, 0)).toBe('outside');
  });

  it('is "+OT" when the shift would carry the week past 40h', () => {
    // 36h scheduled + an 8h shift (7h paid) = 43h.
    expect(dropFitFor({ associateId: 'a2', dayKey: '2026-10-22', dow: 4 }, shift(), fit, 36 * 60)).toBe('ot');
    expect(dropFitFor({ associateId: 'a2', dayKey: '2026-10-22', dow: 4 }, shift(), fit, 30 * 60)).toBeNull();
  });

  it("does not count the person's own shift twice on a same-row move", () => {
    // Ana already holds this 7h-paid shift inside her 40h; moving it stays under.
    expect(dropFitFor({ associateId: 'a1', dayKey: '2026-10-22', dow: 4 }, shift(), fit, WEEK_OT_MINUTES)).toBeNull();
  });

  it('never fits the Unassigned row, and no data means no shading', () => {
    expect(dropFitFor({ associateId: null, dayKey: '2026-10-22', dow: 4 }, shift(), fit, 0)).toBeNull();
    expect(dropFitFor({ associateId: 'a2', dayKey: '2026-10-24', dow: 6 }, shift(), undefined, 0)).toBeNull();
    expect(dropFitFor({ associateId: 'a2', dayKey: '2026-10-24', dow: 6 }, shift(), { dows: new Set(), blocked: new Set() }, 0)).toBeNull();
  });
});

describe('alt-drag copy', () => {
  it('reads the modifier from the activator event or the tracked key', () => {
    expect(isCopyDrag({ altKey: true } as unknown as Event, false)).toBe(true);
    expect(isCopyDrag({ altKey: false } as unknown as Event, true)).toBe(true);
    expect(isCopyDrag({ altKey: false } as unknown as Event, false)).toBe(false);
    expect(isCopyDrag(null, false)).toBe(false);
  });

  it('copies the same wall-clock times onto the target day in the store zone', () => {
    const copy = shiftTimesOnDay(shift(), '2026-10-24', 'America/New_York');
    expect(copy.startsAt).toBe('2026-10-24T13:00:00.000Z');
    expect(copy.endsAt).toBe('2026-10-24T21:00:00.000Z');
  });

  it('keeps 9a as 9a across the DST change', () => {
    // Nov 1 2026 is the fall-back Sunday in New York: 9a is 14:00Z after it.
    const copy = shiftTimesOnDay(shift(), '2026-11-02', 'America/New_York');
    expect(copy.startsAt).toBe('2026-11-02T14:00:00.000Z');
  });
});

describe('dayIsPast', () => {
  it('is true once the day ended in the display zone', () => {
    const now = new Date('2026-10-22T03:30:00.000Z'); // Oct 21, 11:30p New York
    expect(dayIsPast('2026-10-20', 'America/New_York', now)).toBe(true);
    expect(dayIsPast('2026-10-21', 'America/New_York', now)).toBe(false);
    expect(dayIsPast('2026-10-22', 'America/New_York', now)).toBe(false);
  });
});
