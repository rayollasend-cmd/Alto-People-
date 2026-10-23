import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TransportTrendWeek } from '@/lib/transportApi';

vi.mock('@/lib/transportApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/transportApi')>()),
  getTransportTrends: vi.fn(),
}));

import { getTransportTrends } from '@/lib/transportApi';
import { TransportTrends } from '@/pages/transport/TransportTrends';

/**
 * F500 G2 — the vans' weeks run Saturday to Friday, and a week nobody rode
 * reads as one line naming the last ride, not four tiles of zeros.
 */

const week = (start: string, over: Partial<TransportTrendWeek> = {}): TransportTrendWeek => ({
  start,
  partial: false,
  riders: 0,
  noShows: 0,
  noShowPct: null,
  onTimePct: null,
  revenueCents: 0,
  costCents: 0,
  ...over,
});

function renderTrends() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <TransportTrends />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('<TransportTrends>', () => {
  it('a quiet last week is one line with the last ride — and the cost the vans still ran up', async () => {
    vi.mocked(getTransportTrends).mockResolvedValue({
      weeks: [
        week('2026-09-12', { riders: 14, revenueCents: 7000, costCents: 1_300_000 }),
        week('2026-09-19'),
        week('2026-09-26'),
        week('2026-10-03'),
        week('2026-10-10', { costCents: 4000 }),
        week('2026-10-17', { partial: true }),
      ],
      note: 'How on time is counted.',
      weekStartsOn: 'SATURDAY',
      lastRideDate: '2026-09-14',
    });
    renderTrends();
    expect(await screen.findByTestId('transport-quiet-week')).toHaveTextContent(
      'No rides last week — last ride Sep 14. The vans still cost $40.00 that week.',
    );
    expect(screen.getByText(/Saturday to Friday/)).toBeInTheDocument();
    expect(screen.queryByText('Riders last week')).not.toBeInTheDocument();
    expect(screen.queryByText('Earned less cost')).not.toBeInTheDocument();
  });

  it('a week with riders keeps the four tiles', async () => {
    vi.mocked(getTransportTrends).mockResolvedValue({
      weeks: [
        week('2026-10-03', { riders: 10, revenueCents: 5000, costCents: 3000, onTimePct: 90, noShowPct: 0 }),
        week('2026-10-10', { riders: 12, noShows: 1, revenueCents: 6100, costCents: 3000, onTimePct: 92, noShowPct: 7.7 }),
        week('2026-10-17', { partial: true, riders: 3 }),
      ],
      note: '',
      weekStartsOn: 'SATURDAY',
      lastRideDate: '2026-10-18',
    });
    renderTrends();
    expect(await screen.findByText('Riders last week')).toBeInTheDocument();
    expect(screen.queryByTestId('transport-quiet-week')).not.toBeInTheDocument();
  });
});
