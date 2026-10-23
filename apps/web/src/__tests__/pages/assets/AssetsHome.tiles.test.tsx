import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAs } from '../hrPack/harness';

const base = vi.hoisted(() => ({ serial: null, model: null, purchasedAt: null, purchasePrice: null, notes: null, locationId: null, storeName: null, clientName: null, createdAt: '2026-09-01T00:00:00.000Z' }));
vi.mock('@/lib/assets108Api', async (orig) => ({
  ...(await orig<typeof import('@/lib/assets108Api')>()),
  listAssets: vi.fn().mockResolvedValue({
    summary: { assigned: 2, available: 1, inRepair: 0, lost: 1, heldByLeavers: 1 },
    assets: [
      { ...base, id: '1', kind: 'BADGE', label: 'Badge kept', status: 'ASSIGNED', currentAssignment: { id: 'x1', associateId: 'a1', associateName: 'Stays On', assignedAt: '2026-09-01T00:00:00.000Z', holderLeft: false } },
      { ...base, id: '2', kind: 'LAPTOP', label: 'Laptop gone', status: 'ASSIGNED', currentAssignment: { id: 'x2', associateId: 'a2', associateName: 'Has Left', assignedAt: '2026-09-01T00:00:00.000Z', holderLeft: true } },
      { ...base, id: '3', kind: 'KEY', label: 'Spare key', status: 'AVAILABLE', currentAssignment: null },
      { ...base, id: '4', kind: 'KEY', label: 'Lost key', status: 'LOST', currentAssignment: null },
    ],
  }),
}));
vi.mock('@/lib/orgApi', async (orig) => ({ ...(await orig<typeof import('@/lib/orgApi')>()), listSites: vi.fn().mockResolvedValue({ sites: [] }) }));

import { AssetsHome } from '@/pages/assets/AssetsHome';

/** F500 G2 — /assets leads with the numbers that matter, and each tile is the filter. */
describe('<AssetsHome> tiles', () => {
  it('shows the counts and narrows to the kit held by people who have left', async () => {
    renderAs('HR_ADMINISTRATOR', <AssetsHome />, '/assets');
    const strip = await screen.findByLabelText('Assets by status');
    await waitFor(() => expect(strip).toHaveTextContent(/Held by people who've left\s*1/));
    expect(screen.getByPlaceholderText('Search assets…')).toBeInTheDocument();
    await userEvent.click(within(strip).getByRole('button', { name: /Held by people who've left/ }));
    expect(await screen.findByText('Laptop gone')).toBeInTheDocument();
    expect(screen.queryByText('Badge kept')).not.toBeInTheDocument();
    expect(screen.queryByText('Spare key')).not.toBeInTheDocument();
    // The Lost tile filters to lost kit, and clears the leavers view.
    await userEvent.click(within(strip).getByRole('button', { name: /^Lost/ }));
    expect(await screen.findByText('Lost key')).toBeInTheDocument();
    expect(screen.queryByText('Laptop gone')).not.toBeInTheDocument();
  });
});
