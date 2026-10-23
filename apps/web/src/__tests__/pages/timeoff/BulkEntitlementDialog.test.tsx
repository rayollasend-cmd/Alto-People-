import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/directoryApi', () => ({
  listDirectory: vi.fn(async () => ({
    associates: [
      { id: 'a1', firstName: 'Wanda', lastName: 'Working', workStatus: 'ACTIVE', position: null },
      { id: 'a2', firstName: 'Bea', lastName: 'Between', workStatus: 'PLACED_NOT_ACTIVE', position: null },
      { id: 'a3', firstName: 'Nora', lastName: 'Unplaced', workStatus: 'NOT_PLACED', position: null },
      { id: 'a4', firstName: 'Paula', lastName: 'Paused', workStatus: 'DEACTIVATED', position: null },
      { id: 'a5', firstName: 'Olly', lastName: 'Onboarding', workStatus: 'ONBOARDING', position: null },
      { id: 'a6', firstName: 'Sam', lastName: 'Separated', workStatus: 'SEPARATED', position: null },
    ],
  })),
}));
vi.mock('@/lib/useClients', () => ({ useClients: () => ({ clients: [] }) }));
vi.mock('@/lib/timeOffApi', () => ({ bulkUpsertEntitlements: vi.fn() }));

import { BulkEntitlementDialog } from '@/pages/timeoff/BulkEntitlementDialog';
import { listDirectory } from '@/lib/directoryApi';

describe('BulkEntitlementDialog', () => {
  it('offers everyone on the books (between shifts, unplaced, paused too), not only people working, and never someone separated or still onboarding', async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <BulkEntitlementDialog open onClose={() => undefined} onApplied={() => undefined} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/Wanda/)).toBeInTheDocument();
    for (const name of [/Bea/, /Nora/, /Paula/]) expect(screen.getByText(name)).toBeInTheDocument();
    expect(screen.queryByText(/Olly/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Sam/)).not.toBeInTheDocument();
    // The roster isn't narrowed to "Working" on the server.
    expect(vi.mocked(listDirectory).mock.calls[0]![0]).not.toHaveProperty('status');
  });
});
