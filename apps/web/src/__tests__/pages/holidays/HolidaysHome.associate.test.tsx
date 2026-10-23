import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderAs } from '../hrPack/harness';

vi.mock('@/lib/holiday117Api', async (orig) => ({
  ...(await orig<typeof import('@/lib/holiday117Api')>()),
  listHolidays: vi.fn().mockResolvedValue({
    holidays: [
      { id: 'h1', name: 'Thanksgiving', date: '2026-11-26', type: 'FEDERAL', state: null, paid: true, notes: null, clientId: null, clientName: null, scope: 'company' },
    ],
  }),
  listUpcomingHolidays: vi.fn().mockResolvedValue({
    days: 365,
    holidays: [
      { id: 'h1', name: 'Thanksgiving', date: '2026-11-26', type: 'FEDERAL', paid: true, clientName: null, daysUntil: 35 },
      { id: 'h2', name: 'Christmas Day', date: '2026-12-25', type: 'FEDERAL', paid: true, clientName: null, daysUntil: 64 },
      { id: 'h3', name: 'Store inventory day', date: '2027-01-04', type: 'CLIENT_SPECIFIC', paid: false, clientName: 'Coastal', daysUntil: 74 },
      { id: 'h4', name: 'New Year', date: '2027-01-01', type: 'FEDERAL', paid: true, clientName: null, daysUntil: 71 },
    ],
  }),
}));
vi.mock('@/lib/useClients', () => ({ useClients: () => ({ clients: [{ id: 'c1', name: 'Coastal' }], isLoading: false }) }));

import { HolidaysHome } from '@/pages/holidays/HolidaysHome';

/** F500 G2 — an associate reads what's coming, not HR's filters and copy. */
describe('<HolidaysHome> for an associate', () => {
  it('leads with the next three holidays and hides the type and client filters', async () => {
    renderAs('ASSOCIATE', <HolidaysHome />, '/holidays', { associateId: 'a1' });
    const list = await screen.findByTestId('upcoming-holidays');
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('Thanksgiving');
    expect(items[0]).toHaveTextContent('in 35 days');
    expect(items[0]).toHaveTextContent('Paid holiday');
    expect(items[2]).toHaveTextContent('Unpaid');
    expect(screen.queryByRole('button', { name: 'Client-specific' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Pay multipliers and shift planning/)).not.toBeInTheDocument();
  });

  it('HR keeps the filters and the full copy', async () => {
    renderAs('HR_ADMINISTRATOR', <HolidaysHome />, '/holidays');
    expect(await screen.findByRole('button', { name: 'Client-specific' })).toBeInTheDocument();
    expect(screen.queryByTestId('upcoming-holidays')).not.toBeInTheDocument();
  });
});
