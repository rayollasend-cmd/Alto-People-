import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/schedulingApi', () => ({
  getMyShiftDetail: vi.fn().mockResolvedValue({ shift: {}, teammates: [], supervisors: [] }),
  acknowledgeMyShift: vi.fn(),
}));
vi.mock('@/components/EarningsCard', () => ({
  useMyEarnings: () => ({
    data: { onClock: true, currentShiftEarned: 48.5, currentRatePerHour: 15 },
    dataUpdatedAt: Date.now(),
  }),
  useTickSeconds: () => 0,
}));

import { MyShiftHero } from '@/pages/associate/MyShiftHero';

describe('<MyShiftHero> on the clock', () => {
  it('shows what this shift has earned so far, at the top, while they work', async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <MyShiftHero
            active={{ active: { id: 'e1', clockInAt: new Date(Date.now() - 3 * 3_600_000).toISOString() } } as never}
            shifts={[]}
            openShiftCount={null}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('$48.50 earned this shift')).toBeInTheDocument();
    expect(screen.getByText('3h')).toBeInTheDocument();
  });
});
