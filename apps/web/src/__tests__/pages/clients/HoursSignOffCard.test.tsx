import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const api = vi.hoisted(() => ({ getClientSignOffs: vi.fn() }));
vi.mock('@/lib/hoursSignOffApi', async (orig) => ({ ...(await orig<typeof import('@/lib/hoursSignOffApi')>()), getClientSignOffs: api.getClientSignOffs }));

import { HoursSignOffCard } from '@/pages/clients/HoursSignOffCard';

/** Staff read the client's sign-off on its stores' weeks on the client's page. */
describe('<HoursSignOffCard>', () => {
  it('says each store week\'s state, who signed, the total at signing and now, and the flags', async () => {
    api.getClientSignOffs.mockResolvedValue({
      enabled: true,
      weeks: [
        {
          locationId: 'l1',
          storeName: 'Front Beach 218',
          weekStart: '2026-10-17',
          weekEnd: '2026-10-23',
          hours: { lines: [], totalHours: 23, people: 2, openPunches: 0 },
          state: 'changed',
          signOff: { status: 'FLAGGED', signedAt: '2026-10-24T14:00:00.000Z', signedByName: 'Lauren Whitfield', totalHours: 21, people: 2, flags: [{ associateId: 'a1', name: 'Ken Adams', hours: 6, note: 'Left at 1 PM' }], note: null },
        },
        { locationId: 'l2', storeName: 'Bayfront 12', weekStart: '2026-10-17', weekEnd: '2026-10-23', hours: { lines: [], totalHours: 4, people: 1, openPunches: 0 }, state: 'unsigned', signOff: null },
      ],
    });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <HoursSignOffCard clientId="c1" />
      </QueryClientProvider>,
    );
    const rows = await screen.findAllByTestId('hours-signoff-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('Changed since sign-off')).toBeInTheDocument();
    expect(within(rows[0]!).getByText(/Flagged by Lauren Whitfield · .* · 21h at signing · 23h now/)).toBeInTheDocument();
    expect(within(rows[0]!).getByText(/Left at 1 PM/)).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Not signed off')).toBeInTheDocument();
    expect(within(rows[1]!).getByText(/4h · 1 person/)).toBeInTheDocument();
  });

  it('is absent where the client portal is off', async () => {
    api.getClientSignOffs.mockResolvedValue({ enabled: false, weeks: [] });
    const { container } = render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <HoursSignOffCard clientId="c1" />
      </QueryClientProvider>,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(container.querySelector('[data-testid="client-hours-signoff"]')).toBeNull();
  });
});
