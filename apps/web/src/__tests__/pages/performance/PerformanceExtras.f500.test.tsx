import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { ConfirmProvider } from '@/lib/confirm';
import { TooltipProvider } from '@/components/ui/Tooltip';
import type { Goal } from '@/lib/perf84Api';

vi.mock('@/lib/perf84Api', async (orig) => ({
  ...(await orig<typeof import('@/lib/perf84Api')>()),
  listGoals: vi.fn(),
  listKudos: vi.fn(async () => ({ kudos: [] })),
  listOneOnOnes: vi.fn(async () => ({ meetings: [] })),
  listPips: vi.fn(async () => ({ pips: [] })),
  listReviews360: vi.fn(async () => ({ reviews: [] })),
}));
vi.mock('@/pages/performance/AdminReviewsView', () => ({ AdminReviewsView: () => <div>Reviews page</div> }));

import { listGoals } from '@/lib/perf84Api';
import { PerformanceExtras } from '@/pages/performance/PerformanceExtras';
import { PerformanceHome } from '@/pages/performance/PerformanceHome';

/**
 * Goals, 1:1s & feedback (F500 2026-10-22): plain tab names (no "PIPs",
 * "360s", "OKRs"), the tab in the URL, sentence-case status chips with
 * counts, the layout as a separate icon toggle, the tab's primary action
 * in the header, and old /performance?tab= links landing here.
 */

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.pathname + l.search}</div>;
}

function renderAt(path: string) {
  const role = 'HR_ADMINISTRATOR' as const;
  const caps = ROLE_CAPABILITIES[role];
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider
        value={{
          isInitializing: false,
          isOffline: false,
          user: { id: 'u', email: 'hr@example.com', role, status: 'ACTIVE' as const, clientId: null, associateId: null },
          role,
          capabilities: new Set<Capability>(caps),
          signIn: vi.fn(),
          signOut: vi.fn(),
          can: (c: Capability) => caps.has(c),
        }}
      >
        <TooltipProvider>
          <ConfirmProvider>
            <MemoryRouter initialEntries={[path]}>
              <Routes>
                <Route path="/performance" element={<PerformanceHome />} />
                <Route path="/performance/extras" element={<PerformanceExtras />} />
              </Routes>
              <Where />
            </MemoryRouter>
          </ConfirmProvider>
        </TooltipProvider>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

const goal = (id: string, status: Goal['status']): Goal => ({
  id,
  associateId: 'a1',
  associateName: 'Ana Lopez',
  kind: 'GOAL',
  title: `Goal ${id}`,
  description: null,
  parentGoalId: null,
  periodStart: '2026-01-01',
  periodEnd: '2026-12-31',
  status,
  progressPct: 20,
  keyResults: [],
});

beforeEach(() => {
  vi.mocked(listGoals).mockResolvedValue({ goals: [goal('g1', 'ACTIVE'), goal('g2', 'ACTIVE'), goal('g3', 'AT_RISK')] } as never);
});

describe('Goals, 1:1s & feedback', () => {
  it('names its tabs plainly and links back to Reviews and Calibration', async () => {
    renderAt('/performance/extras');
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).toEqual(['Goals', 'Recognition', '1:1s', 'Improvement plans', '360 reviews', 'Timeline']);
    expect(screen.getByRole('link', { name: 'Reviews' })).toHaveAttribute('href', '/performance');
    expect(screen.getByRole('link', { name: 'Calibration' })).toHaveAttribute('href', '/performance/calibration');
  });

  it('counts goals on sentence-case chips, keeps the filter and layout in the URL, and toggles the layout with icons', async () => {
    const user = renderAt('/performance/extras');
    const atRisk = await screen.findByRole('button', { name: 'At risk 1' });
    expect(atRisk.className).not.toMatch(/uppercase/);
    expect(screen.getByRole('button', { name: 'Active 2' })).toBeInTheDocument();
    await user.click(atRisk);
    expect(screen.getByTestId('where')).toHaveTextContent('goalStatus=AT_RISK');
    const layout = screen.getByRole('group', { name: 'How to show goals' });
    await user.click(within(layout).getByRole('button', { name: 'Table' }));
    expect(screen.getByTestId('where')).toHaveTextContent('goalView=table');
    expect(await screen.findByText('Goal g3')).toBeInTheDocument();
    expect(screen.queryByText('Goal g1')).not.toBeInTheDocument();
  });

  it('puts each tab’s primary action in the header, and writes the tab to the URL', async () => {
    const user = renderAt('/performance/extras');
    expect(await screen.findByRole('button', { name: 'New goal' })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Improvement plans' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/performance/extras?tab=pips');
    await user.click(screen.getByRole('button', { name: 'New improvement plan' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('lands old /performance?tab=pips links on the improvement plans tab', async () => {
    renderAt('/performance?tab=pips');
    expect(await screen.findByRole('tab', { name: 'Improvement plans', selected: true })).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/performance/extras?tab=pips');
  });
});
