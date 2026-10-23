import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { ConfirmProvider } from '@/lib/confirm';
import type { ReviewsSummary } from '@/lib/performanceApi';

vi.mock('@/lib/performanceApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/performanceApi')>()),
  listReviews: vi.fn(),
  getReviewsSummary: vi.fn(),
}));

import { getReviewsSummary, listReviews } from '@/lib/performanceApi';
import { AdminReviewsView } from '@/pages/performance/AdminReviewsView';

/**
 * Performance (F500 2026-10-22): opens on what needs action with the cycle
 * at a glance — due, overdue, awaiting acknowledgment, done this quarter —
 * chips with counts in sentence case, and the filter in the URL.
 */

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.pathname + l.search}</div>;
}

function renderPage(path = '/performance') {
  const caps = ROLE_CAPABILITIES.HR_ADMINISTRATOR;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  render(
    <QueryClientProvider client={client}>
      <AuthContext.Provider
        value={{
          isInitializing: false,
          isOffline: false,
          user: { id: 'u', email: 'hr@example.com', role: 'HR_ADMINISTRATOR', status: 'ACTIVE' as const, clientId: null, associateId: null },
          role: 'HR_ADMINISTRATOR',
          capabilities: new Set<Capability>(caps),
          signIn: vi.fn(),
          signOut: vi.fn(),
          can: (c: Capability) => caps.has(c),
        }}
      >
        <ConfirmProvider>
          <MemoryRouter initialEntries={[path]}>
            <AdminReviewsView canManage />
            <Where />
          </MemoryRouter>
        </ConfirmProvider>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

const summary: ReviewsSummary = {
  drafts: 2,
  awaitingAck: 3,
  acknowledged: 9,
  doneThisQuarter: 4,
  quarterStart: '2026-10-01',
  overdue: 1,
  dueThisMonth: 1,
  due: [
    { associateId: 'a1', name: 'Ana Test', lastPeriodEnd: '2025-09-17', dueOn: '2026-09-17', overdue: true },
    { associateId: 'a2', name: 'Ben Test', lastPeriodEnd: null, dueOn: '2026-10-28', overdue: false },
  ],
};

beforeEach(() => {
  vi.mocked(getReviewsSummary).mockResolvedValue(summary);
  vi.mocked(listReviews).mockResolvedValue({ reviews: [] });
});

describe('Performance reviews', () => {
  it('opens on reviews that need action, with the cycle at a glance and counted chips', async () => {
    renderPage();
    expect(listReviews).toHaveBeenCalledWith({ status: ['DRAFT', 'SUBMITTED'] });
    const strip = await screen.findByRole('group', { name: 'Reviews at a glance' });
    expect(within(strip).getByText('Due this month')).toBeInTheDocument();
    await waitFor(() => expect(strip).toHaveTextContent(/Acknowledged since Oct 1, 2026/));
    // Sentence-case chips with counts: Needs action = drafts + submitted.
    expect(await screen.findByRole('button', { name: 'Needs action 5' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Acknowledged 9' })).toBeInTheDocument();
    expect(screen.getByText('No reviews need action')).toBeInTheDocument();
    // Siblings are links, not buttons.
    expect(screen.getByRole('link', { name: 'Calibration' })).toHaveAttribute('href', '/performance/calibration');
  });

  it('shows who is overdue behind the tile, and keeps the filter in the URL', async () => {
    renderPage();
    const strip = await screen.findByRole('group', { name: 'Reviews at a glance' });
    await userEvent.click(within(strip).getByText('Overdue').closest('button')!);
    expect(screen.getByTestId('where')).toHaveTextContent('/performance?status=OVERDUE');
    expect(await screen.findByText('Ana Test')).toBeInTheDocument();
    expect(screen.queryByText('Ben Test')).not.toBeInTheDocument();
    expect(screen.getByText('Sep 17, 2026')).toBeInTheDocument();
  });

  it('reads the filter from the URL', async () => {
    renderPage('/performance?status=SUBMITTED');
    await screen.findByRole('group', { name: 'Reviews at a glance' });
    expect(listReviews).toHaveBeenCalledWith({ status: 'SUBMITTED' });
  });
});
