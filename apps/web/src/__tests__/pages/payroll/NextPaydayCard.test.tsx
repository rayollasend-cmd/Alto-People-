import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/payrollApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/payrollApi')>()),
  getMyNextPayday: vi.fn(),
}));

import { getMyNextPayday } from '@/lib/payrollApi';
import { NextPaydayCard } from '@/pages/payroll/AssociatePayrollView';

function renderCard() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <NextPaydayCard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('<NextPaydayCard> — Alto pays biweekly, the Friday after the period', () => {
  it('on payday: the next payday is the one after, and today says it is payday — for the days it pays', async () => {
    vi.mocked(getMyNextPayday).mockResolvedValue({
      nextPayday: {
        payDate: '2026-10-02',
        periodStart: '2026-09-12',
        periodEnd: '2026-09-25',
        schedule: 'Biweekly · Sat–Fri · paid the Friday after',
        paidToday: { periodStart: '2026-08-29', periodEnd: '2026-09-11' },
      },
    });
    renderCard();
    expect(await screen.findByText(/Fri, Oct 2/)).toBeInTheDocument();
    expect(screen.getByText(/For work .*Sep 12.* – .*Sep 25/)).toBeInTheDocument();
    expect(screen.getByText(/Today is payday — for work .*Aug 29.* – .*Sep 11/)).toBeInTheDocument();
  });

  it('any other day: just the next payday', async () => {
    vi.mocked(getMyNextPayday).mockResolvedValue({
      nextPayday: {
        payDate: '2026-10-02',
        periodStart: '2026-09-12',
        periodEnd: '2026-09-25',
        schedule: 'Biweekly · Sat–Fri · paid the Friday after',
        paidToday: null,
      },
    });
    renderCard();
    expect(await screen.findByText(/Fri, Oct 2/)).toBeInTheDocument();
    expect(screen.queryByText(/Today is payday/)).not.toBeInTheDocument();
  });
});
