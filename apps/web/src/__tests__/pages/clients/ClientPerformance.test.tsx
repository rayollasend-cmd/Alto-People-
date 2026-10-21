import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/auth', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth')>()),
  useAuth: () => ({ user: { id: 'u1' }, can: () => true }),
  useTerm: () => (k: string) => (k === 'label.store' ? 'Store' : k === 'label.client' ? 'Client' : k),
}));
vi.mock('@/lib/schedulingApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/schedulingApi')>()),
  storeTrends: vi.fn(async () => ({
    bestMarginPerHour: 6,
    stores: [
      { clientId: 'c1', locationId: 'l1', locationName: 'Front Beach', clientName: 'Coastal', hours4w: 300, avgMarginPerHour: 5, weeks: [{ start: '2026-09-21', hours: 100, marginPerHour: 4 }, { start: '2026-09-28', hours: 200, marginPerHour: 5.5 }] },
      { clientId: 'c1', locationId: 'l2', locationName: 'Bay Side', clientName: 'Coastal', hours4w: 100, avgMarginPerHour: 2, weeks: [{ start: '2026-09-21', hours: 50, marginPerHour: 2 }, { start: '2026-09-28', hours: 50, marginPerHour: null }] },
    ],
  })),
}));
vi.mock('@/lib/npsApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/npsApi')>()),
  getNpsResults: vi.fn(async () => ({
    current: null,
    byClient: [],
    trend: [],
    comments: [],
    canSendQuarter: null,
    clientTrends: [{ clientId: 'c1', clientName: 'Coastal', points: [{ quarter: '2026-Q2', nps: 20, responded: 3 }, { quarter: '2026-Q3', nps: 40, responded: 4 }] }],
  })),
}));
vi.mock('@/lib/clientsApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/clientsApi')>()),
  listClientStatements: vi.fn(async () => ({
    statements: [
      { id: 's1', clientId: 'c1', periodStart: '2026-09-21', periodEnd: '2026-09-27', number: 7, status: 'FINAL', paidAt: '2026-10-05T00:00:00Z', snapshot: { totals: { hours: 150, amount: 3000 } } },
      { id: 's2', clientId: 'c1', periodStart: '2026-09-28', periodEnd: '2026-10-04', number: 8, status: 'FINAL', paidAt: null, snapshot: { totals: { hours: 250, amount: 5000 } } },
    ],
  })),
}));

import { ClientGlance, ClientPerformance, rollUpWeeks } from '@/pages/clients/ClientPerformance';

const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );

describe('a client’s performance', () => {
  it('rolls locations up by week, weighting margin by hours', () => {
    expect(
      rollUpWeeks([
        { clientId: 'c', locationId: 'a', locationName: 'A', clientName: 'C', hours4w: 0, avgMarginPerHour: null, weeks: [{ start: '2026-09-21', hours: 30, marginPerHour: 4 }] },
        { clientId: 'c', locationId: 'b', locationName: 'B', clientName: 'C', hours4w: 0, avgMarginPerHour: null, weeks: [{ start: '2026-09-21', hours: 10, marginPerHour: 8 }] },
      ]),
    ).toEqual([{ start: '2026-09-21', hours: 40, marginPerHour: 5 }]);
  });

  it('draws hours and margin by week, NPS by quarter and billed per statement, each with its table', async () => {
    wrap(<ClientPerformance clientId="c1" />);
    const weeks = await screen.findByRole('table', { name: 'Hours and margin, week by week' });
    // 100 + 50 hours in the first week; 200 in the second (Bay Side had no margin that week).
    expect(within(weeks).getAllByRole('row')[2]).toHaveTextContent('250');
    expect(within(weeks).getAllByRole('row')[2]).toHaveTextContent('$5.50/h');
    const nps = await screen.findByRole('table', { name: 'NPS by quarter' });
    expect(within(nps).getByRole('row', { name: /2026-Q3/ })).toHaveTextContent('40');
    const billed = await screen.findByRole('table', { name: 'Billed, statement by statement' });
    expect(within(billed).getByRole('row', { name: /#8/ })).toHaveTextContent('Outstanding');
    expect(within(billed).getByRole('row', { name: /#7/ })).toHaveTextContent('Paid');
    expect(screen.getByText('Bay Side')).toBeInTheDocument();
  });

  it('puts four numbers at the top of the record, each opening the tab', async () => {
    const open = vi.fn();
    wrap(<ClientGlance clientId="c1" onOpen={open} />);
    expect(await screen.findByText('Hours last week')).toBeInTheDocument();
    expect(await screen.findByText('$5,000.00 outstanding')).toBeInTheDocument();
    expect(await screen.findByText('+40')).toBeInTheDocument();
    screen.getByText('Hours last week').closest('button')!.click();
    expect(open).toHaveBeenCalled();
  });
});
