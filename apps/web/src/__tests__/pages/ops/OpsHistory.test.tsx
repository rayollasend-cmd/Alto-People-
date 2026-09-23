import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));

import { apiFetch } from '@/lib/api';
import { OpsHistory } from '@/pages/ops/OpsHistory';

/**
 * "What happened on last week's overnight at Destin" — the question the
 * board could not answer, because it showed today only, labelled every
 * row with the CLIENT, and printed no clock.
 *
 * So this asserts the three things that make it answerable: the store's
 * own name, the times the shift opened and closed, and rows that can be
 * narrowed to the one being asked about.
 */

const SHIFTS = {
  range: { from: '2026-09-14', to: '2026-09-20' },
  generatedAt: '2026-09-21T12:00:00.000Z',
  sort: 'worst',
  truncated: false,
  shifts: [
    {
      id: 's1',
      clientId: 'c1',
      clientName: 'Walmart',
      locationId: 'l1',
      locationName: 'Destin',
      department: 'Frozen & Dairy',
      period: 'OVERNIGHT',
      position: 'Overnight Stocker',
      dateKey: '2026-09-16',
      status: 'CLOSED',
      openedAt: '2026-09-17T02:00:00.000Z',
      closedAt: '2026-09-17T10:12:00.000Z',
      scheduledHeadcount: 5,
      actualHeadcount: 4,
      templateName: 'Overnight SOP',
      sopTotal: 20,
      sopDone: 14,
      taskTotal: 22,
      taskDone: 15,
      closedIncomplete: true,
      tempAlerts: 2,
      closingSummary: 'Freezer 3 alarmed twice',
      openedByEmail: 'sup@altohr.com',
      completionPct: 68,
    },
    {
      id: 's2',
      clientId: 'c1',
      clientName: 'Walmart',
      locationId: 'l2',
      locationName: 'Front Beach 218',
      department: 'Grocery',
      period: 'MORNING',
      position: 'Lead',
      dateKey: '2026-09-17',
      status: 'CLOSED',
      openedAt: '2026-09-17T10:00:00.000Z',
      closedAt: '2026-09-17T18:00:00.000Z',
      scheduledHeadcount: 6,
      actualHeadcount: 6,
      templateName: 'Morning SOP',
      sopTotal: 10,
      sopDone: 10,
      taskTotal: 10,
      taskDone: 10,
      closedIncomplete: false,
      tempAlerts: 0,
      closingSummary: null,
      openedByEmail: 'lead@altohr.com',
      completionPct: 100,
    },
  ],
};

function renderHistory() {
  vi.mocked(apiFetch).mockImplementation(async (path: string) => {
    if (path.startsWith('/ops/history')) return SHIFTS as never;
    throw new Error(`unexpected ${path}`);
  });
  const onOpen = vi.fn();
  render(<OpsHistory query={{ from: '2026-09-14', to: '2026-09-20' }} onOpenRecord={onOpen} />);
  return onOpen;
}

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
});

describe('the Store Ops record', () => {
  it('names the store, not the chain, and says when the shift ran', async () => {
    renderHistory();
    const table = await screen.findByRole('table');

    // The building. Two overnight shifts at two stores used to be the
    // same row twice, both reading "Walmart".
    expect(within(table).getByRole('button', { name: /Destin/ })).toBeInTheDocument();
    expect(within(table).getByText('Front Beach 218')).toBeInTheDocument();

    // A clock, not "2 days ago": opened 10:00 PM, closed 6:12 AM.
    expect(within(table).getByText('10:00 PM')).toBeInTheDocument();
    expect(within(table).getByText('6:12 AM')).toBeInTheDocument();
    // And how long it ran.
    expect(within(table).getByText('8h 12m')).toBeInTheDocument();
  });

  it('opens the full record for the shift asked about', async () => {
    const onOpen = renderHistory();
    // jsdom applies no CSS, so the grid's phone card and its table row
    // both exist; the table is the one being asked about.
    await userEvent.click(
      within(await screen.findByRole('table')).getByRole('button', { name: /Overnight.*Destin/ }),
    );
    expect(onOpen).toHaveBeenCalledWith('s1');
  });

  it('narrows to one shift by search', async () => {
    renderHistory();
    await screen.findByRole('table');

    await userEvent.type(screen.getByRole('searchbox', { name: /Search Store Ops shifts/ }), 'destin');

    expect(screen.getByText('1 of 2')).toBeInTheDocument();
    expect(screen.queryByText('Front Beach 218')).not.toBeInTheDocument();
  });

  it('flags the shift that needs a person to look at it', async () => {
    renderHistory();
    const table = await screen.findByRole('table');
    expect(within(table).getByText('incomplete')).toBeInTheDocument();
    expect(within(table).getByText('2 temp')).toBeInTheDocument();
    expect(within(table).getByText('68%')).toBeInTheDocument();
  });
});
