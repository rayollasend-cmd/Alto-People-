import { describe, expect, it } from 'vitest';
import type { Ride } from '@/lib/transportApi';
import { chargeGroups, chargeRows, type LedgerRide } from '@/pages/transport/rider/charges';

/**
 * CODE-35 (deep audit 2026-10-29): a fare taken with no payday on file was
 * grouped under the UTC day it was charged — after 5 PM Pacific, tomorrow.
 * It is the store's own day.
 */

function taken(chargedAt: string, timezone: string): LedgerRide {
  return {
    id: 'r1',
    direction: 'TO_WORK',
    targetAt: '2026-10-29T15:00:00.000Z',
    serviceDate: '2026-10-29',
    status: 'COMPLETED',
    store: { id: 'l1', name: 'Front Beach 218', timezone, clientId: 'c1', clientName: 'Coastal' },
    fareCents: 500,
    noShowFeeCents: 100,
    owedCents: 0,
    waived: false,
    waiveReason: null,
    charged: true,
    cancelReason: null,
    chargedAt,
    chargedPayDate: null,
  } as unknown as Ride as LedgerRide;
}

describe('a charge taken in the evening', () => {
  it('is filed under the store’s day, not UTC’s', () => {
    // 02:30 UTC on Oct 30 is 7:30 PM on Oct 29 in Los Angeles.
    const rows = chargeRows([taken('2026-10-30T02:30:00.000Z', 'America/Los_Angeles')]);
    expect(rows[0]!.takenOn).toBe('2026-10-29');
    expect(chargeGroups(rows, null).map((g) => g.key)).toEqual(['paid-2026-10-29']);
  });

  it('the same instant is the next day for a store in New York', () => {
    const rows = chargeRows([taken('2026-10-30T04:30:00.000Z', 'America/New_York')]);
    expect(rows[0]!.takenOn).toBe('2026-10-30');
  });
});
