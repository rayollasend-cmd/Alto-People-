import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RecruitingAnalytics as Analytics } from '@alto-people/shared';

vi.mock('@/lib/recruitingApi', () => ({
  getRecruitingAnalytics: vi.fn(),
  listSourceSpend: vi.fn(async () => ({
    spend: [{ id: 'sp-1', source: 'indeed', month: '2026-09', amount: 400, note: 'Sponsored posts', updatedByEmail: 'dana@alto.test' }],
  })),
  saveSourceSpend: vi.fn(async () => ({ id: 'sp-2' })),
  deleteSourceSpend: vi.fn(async () => undefined),
}));
vi.mock('@/lib/auth', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth')>()),
  useAuth: () => ({ can: () => true, user: { id: 'me-1' } }),
}));

import { getRecruitingAnalytics, saveSourceSpend } from '@/lib/recruitingApi';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { RecruitingAnalytics } from '@/pages/recruiting/RecruitingAnalytics';

const DATA: Analytics = {
  range: { from: '2026-06-28', to: '2026-09-25' },
  funnel: {
    applicants: 4,
    stages: [
      { stage: 'APPLIED', reached: 4, toNextPct: 75 },
      { stage: 'SCREENING', reached: 3, toNextPct: 67 },
      { stage: 'INTERVIEW', reached: 2, toNextPct: 50 },
      { stage: 'OFFER', reached: 1, toNextPct: 100 },
      { stage: 'HIRED', reached: 1, toNextPct: null },
    ],
    rejected: 1,
    withdrawn: 1,
    inProgress: 1,
  },
  speed: { hires: 3, medianDaysToHire: 4, postingsFilled: 1, medianDaysToFill: 6 },
  sources: [
    { source: 'indeed', applicants: 3, hires: 2, applicantToHirePct: 67, spend: 400, costPerHire: 200 },
    { source: 'craigslist', applicants: 0, hires: 0, applicantToHirePct: null, spend: 50, costPerHire: null },
    { source: null, applicants: 1, hires: 1, applicantToHirePct: 100, spend: null, costPerHire: null },
  ],
  spendTotal: 450,
  costPerHire: 150,
  offers: { accepted: 3, declined: 1, expired: 1, acceptancePct: 60 },
  fill: { openings: 3, filled: 2, fillRatePct: 67 },
  clients: [
    {
      clientId: '00000000-0000-4000-8000-000000000001',
      clientName: 'Walmart',
      hires: 1,
      offersAccepted: 2,
      offersDecided: 4,
      offerAcceptancePct: 50,
      openings: 2,
      filled: 1,
      fillRatePct: 50,
      medianDaysToFill: null,
    },
  ],
  retention: {
    window: { from: '2025-06-27', to: '2026-06-26' },
    overall: { key: null, label: 'All hires', hires: 4, stayed: 3, stayedPct: 75 },
    bySource: [
      { key: 'indeed', label: 'indeed', hires: 2, stayed: 1, stayedPct: 50 },
      { key: 'referral', label: 'referral', hires: 2, stayed: 2, stayedPct: 100 },
    ],
    byRecruiter: [{ key: 'u1', label: 'Dana Reyes', hires: 4, stayed: 3, stayedPct: 75 }],
  },
};

function renderPage(url = '/recruiting/analytics') {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[url]}>
          <RecruitingAnalytics />
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

beforeEach(() => {
  vi.mocked(getRecruitingAnalytics).mockReset().mockResolvedValue(DATA);
});

describe('<RecruitingAnalytics>', () => {
  it('leads with the headline numbers, each saying what it is a rate of', async () => {
    renderPage();
    expect(await screen.findByText('60%')).toBeInTheDocument();
    expect(screen.getByText('3 accepted · 1 declined · 1 lapsed')).toBeInTheDocument();
    expect(screen.getByText('2 of 3 openings filled')).toBeInTheDocument();
    expect(screen.getByText('$150.00')).toBeInTheDocument();
    expect(screen.getByText('$450.00 spent')).toBeInTheDocument();
    expect(screen.getByText('3 of 4 hires measured')).toBeInTheDocument();
    expect(screen.getByText('6 days')).toBeInTheDocument();
  });

  it('draws the funnel with every step labeled', async () => {
    renderPage();
    const funnel = await screen.findByRole('list', { name: 'Hiring funnel' });
    const steps = within(funnel).getAllByRole('listitem');
    expect(steps).toHaveLength(5);
    expect(steps[1]).toHaveTextContent('Screening3');
    expect(steps[1]).toHaveTextContent('67% moved on to interview');
    expect(screen.getByText(/Of 4: 1 still in progress, 1 rejected, 1\s+withdrew/)).toBeInTheDocument();
  });

  it('prices each source, and says so when money bought no hires', async () => {
    renderPage();
    const table = await screen.findByRole('table', { name: 'Where hires come from' });
    const indeed = within(table).getByRole('row', { name: /Indeed/ });
    expect(indeed).toHaveTextContent('$400.00');
    expect(indeed).toHaveTextContent('$200.00');
    expect(within(table).getByRole('row', { name: /Craigslist/ })).toHaveTextContent('No hires');
    expect(within(table).getByRole('row', { name: /Not recorded/ })).toBeInTheDocument();
  });

  it('shows each client’s acceptance and fill as meters, with their counts', async () => {
    renderPage();
    const table = await screen.findByRole('table', { name: 'By client' });
    expect(within(table).getByRole('meter', { name: 'Walmart offer acceptance' })).toHaveAttribute('aria-valuenow', '50');
    expect(within(table).getByText('2 of 4')).toBeInTheDocument();
    expect(within(table).getByText('1 of 2 openings')).toBeInTheDocument();
  });

  it('reads 90-day retention by source and by who hired them', async () => {
    renderPage();
    const bySource = await screen.findByRole('table', { name: 'Stayed 90 days, by source' });
    expect(within(bySource).getByRole('meter', { name: 'Indeed stayed 90 days' })).toHaveAttribute('aria-valuenow', '50');
    expect(within(bySource).getByRole('meter', { name: 'Referral stayed 90 days' })).toHaveAttribute('aria-valuenow', '100');
    const byWho = screen.getByRole('table', { name: 'Stayed 90 days, by who hired them' });
    expect(within(byWho).getByText('Dana Reyes')).toBeInTheDocument();
  });

  it('switches the range from the URL', async () => {
    const user = renderPage('/recruiting/analytics?range=30d');
    await screen.findByText('60%');
    const [first] = vi.mocked(getRecruitingAnalytics).mock.calls[0]!;
    const span = (Date.parse(first.to) - Date.parse(first.from)) / 86_400_000;
    expect(span).toBe(29);
    await user.click(screen.getByRole('radio', { name: '12 months' }));
    await waitFor(() => expect(getRecruitingAnalytics).toHaveBeenCalledTimes(2));
  });

  it('records a month of spend for a source', async () => {
    const user = renderPage();
    await user.click(await screen.findByRole('button', { name: 'Record spend' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'What each source cost' }));
    expect(await dialog.findByText('Sponsored posts')).toBeInTheDocument();
    await user.selectOptions(dialog.getByLabelText(/^Source/), 'referral');
    await user.type(dialog.getByLabelText(/^Amount/), '250');
    await user.click(dialog.getByRole('button', { name: 'Save spend' }));
    await waitFor(() =>
      expect(saveSourceSpend).toHaveBeenCalledWith(expect.objectContaining({ source: 'referral', amount: 250 })),
    );
  });
});
