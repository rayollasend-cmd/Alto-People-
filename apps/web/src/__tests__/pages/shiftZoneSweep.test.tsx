import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderAs } from './hrPack/harness';
import { fmtShiftSpanTz, fmtShiftTz, setDisplayTimeZone } from '@/lib/format';

vi.mock('@/lib/useClients', () => ({ useClients: () => ({ clients: [] }) }));
vi.mock('@/lib/useViewport', async (orig) => ({ ...(await orig<typeof import('@/lib/useViewport')>()), useMediaQuery: () => false }));
const getExpirationRisk = vi.fn();
vi.mock('@/lib/expirations113Api', () => ({
  getExpirationRisk: (...a: unknown[]) => getExpirationRisk(...a),
  getExpirations: vi.fn().mockResolvedValue({ days: 60, counts: { expired: 0, dueSoon: 0, dueLater: 0 }, expired: [], dueSoon: [], dueLater: [] }),
}));
vi.mock('@/lib/qualApi', () => ({ grantAssociateQual: vi.fn() }));
vi.mock('@/pages/transport/TransportDesk', () => ({ TransportExpiringSection: () => null }));

import { ExpirationsHome } from '@/pages/expirations/ExpirationsHome';

/**
 * One shift, one time — the wave-2 sweep. Shift and punch times read on
 * the store's clock wherever they show: the compact span names the zone
 * once at the end when the viewer is elsewhere, a row with no store reads
 * on the viewer's chosen zone (never the bare browser zone), and the
 * expirations desk shows the shift a lapse blocks at the store's time.
 */

const LA = 'America/Los_Angeles';
// 13:00Z on 2026-07-15 is 6:00 AM in Los Angeles (PDT), 9:00 AM in New York.
const START = '2026-07-15T13:00:00.000Z';
const END = '2026-07-15T17:00:00.000Z';

beforeEach(() => setDisplayTimeZone('America/New_York'));
afterEach(() => setDisplayTimeZone(null));

describe('fmtShiftSpanTz / fmtShiftTz', () => {
  it('reads a Los Angeles shift on its own clock from New York, with the zone once', () => {
    expect(fmtShiftSpanTz(START, END, LA)).toBe('6:00 AM–10:00 AM PDT');
    expect(fmtShiftTz(START, LA, { day: false })).toBe('6:00 AM PDT');
  });

  it('says no zone at the store, and a row with no store reads on the chosen display zone', () => {
    setDisplayTimeZone(LA);
    expect(fmtShiftSpanTz(START, END, LA)).toBe('6:00 AM–10:00 AM');
    setDisplayTimeZone('America/Chicago');
    expect(fmtShiftTz(START, null, { day: false })).toBe('8:00 AM');
    expect(fmtShiftSpanTz(START, END, undefined)).toBe('8:00 AM–12:00 PM');
  });
});

describe('the expirations desk', () => {
  it('shows the shift a lapse blocks at the store’s time, not the viewer’s', async () => {
    getExpirationRisk.mockResolvedValue({
      asOf: '2026-07-01T12:00:00.000Z',
      days: 90,
      truncated: false,
      items: [
        {
          id: 'q1', associateId: 'a1', associateName: 'Ana Lopez', associateEmail: 'ana@example.com', qualificationId: 'food', qualificationCode: 'FOOD',
          qualificationName: 'Food handler', isCert: true, expiresAt: '2026-07-10', daysUntilExpiry: 5, storeId: 's1', storeName: 'Santa Monica', clientId: 'c1', clientName: 'Pacific',
          nextShift: null,
          blockingShift: { id: 'sh1', startsAt: START, storeId: 's1', storeName: 'Santa Monica', position: 'Cook', timezone: LA, requiredBy: 'shift' },
        },
      ],
      atRisk: ['q1'],
      weeks: ['2026-07-01'],
      timeline: [],
      filters: { clients: [], stores: [], qualifications: [] },
    });
    renderAs('HR_ADMINISTRATOR', <ExpirationsHome />, '/expirations');
    const list = await screen.findByRole('list', { name: /lapses that block a scheduled shift/i });
    expect(within(list).getByText(/6:00 AM PDT$/)).toBeInTheDocument();
    expect(within(list).queryByText(/9:00 AM/)).not.toBeInTheDocument();
  });
});
