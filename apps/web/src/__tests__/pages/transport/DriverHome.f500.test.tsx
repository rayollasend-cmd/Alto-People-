import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { zonedDayKey } from '@/lib/format';
import { renderAs } from '../hrPack/harness';

/**
 * The driver's home on a phone (F500 G5): one header action in view
 * (Report a problem) with the rest — Safety, Log fuel and a LABELLED sound
 * switch — in "More"; the week as seven fluid days carrying the driver's
 * own shifts; "Clients I drive for" only when it narrows the runs.
 */

vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), apiFetch: vi.fn() }));
vi.mock('@/components/transport/LazyLiveMap', () => ({ LazyLiveMap: () => null }));

import { apiFetch } from '@/lib/api';
import { DriverHome } from '@/pages/transport/DriverHome';

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const today = zonedDayKey(new Date(), tz);
const tomorrowNoon = new Date(Date.parse(`${today}T12:00:00Z`) + 86_400_000);

function route(clients: unknown) {
  vi.mocked(apiFetch).mockImplementation(async (path: string) => {
    if (path === '/transport/driver/runs') return { today, runs: [] } as never;
    if (path === '/transport/driver/requests') return { van: { id: 'v1', name: 'Van 1', plate: 'ALT 101', capacity: 12, look: '' }, requests: [] } as never;
    if (path === '/transport/driver/clients') return clients as never;
    if (path.startsWith('/transport/driver/schedule')) return { runs: [], asking: [] } as never;
    if (path.startsWith('/transport/driver/shifts'))
      return { associateId: 'a1', shifts: [{ id: 'sh2', startsAt: new Date(tomorrowNoon.getTime() - 4 * 3_600_000).toISOString(), endsAt: tomorrowNoon.toISOString(), status: 'ASSIGNED' }] } as never;
    if (path === '/transport/driver/today') throw new Error('not in this test');
    return {} as never;
  });
}

const ALL = { all: { id: 'x0', status: 'APPROVED', note: null, decisionNote: null, requestedAt: '', decidedAt: null }, clients: [], approved: 0, pending: 0 };

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
});

describe('the driver home', () => {
  it('puts the header actions in the one PageHeader list: Report a problem the primary, and a labelled sound switch', async () => {
    route(ALL);
    renderAs('DRIVER', <DriverHome />);
    const report = await screen.findByRole('button', { name: /Report a problem/ });
    const row = report.parentElement!;
    // Desktop: the primary and two beside it (a phone keeps only the primary and
    // opens the rest in one sheet — PageHeader's own test holds that).
    expect(within(row).getAllByRole('button').map((b) => b.textContent?.trim())).toEqual(['Safety', expect.stringMatching(/^Sounds (on|off)$/), 'Report a problem']);
    // The unlabelled speaker icon is gone: the switch says what it does.
    expect(screen.queryByRole('button', { name: /tap to/ })).toBeNull();
  });

  it('draws the week as seven fluid days, with the driver’s own shift on its day', async () => {
    route(ALL);
    renderAs('DRIVER', <DriverHome />);
    const strip = await screen.findByRole('tablist', { name: 'Your week' });
    expect(strip).toHaveClass('grid-cols-7');
    expect(within(strip).getAllByRole('tab')).toHaveLength(7);
    within(strip).getAllByRole('tab')[1]!.click();
    expect(await screen.findByTestId('week-shift')).toHaveTextContent('Your driver shift');
  });

  it('drops "Clients I drive for" when the driver drives for every client, and shows it when it narrows the runs', async () => {
    route(ALL);
    const { unmount } = renderAs('DRIVER', <DriverHome />);
    await screen.findByRole('tablist', { name: 'Your week' });
    expect(screen.queryByRole('region', { name: 'Clients I drive for' })).toBeNull();
    unmount();
    route({ all: null, clients: [{ id: 'c1', name: 'Coastal', access: { id: 'x1', status: 'APPROVED', note: null, decisionNote: null, requestedAt: '', decidedAt: null } }], approved: 1, pending: 0 });
    renderAs('DRIVER', <DriverHome />);
    expect(await screen.findByRole('region', { name: 'Clients I drive for' })).toHaveTextContent('Coastal');
  });
});
