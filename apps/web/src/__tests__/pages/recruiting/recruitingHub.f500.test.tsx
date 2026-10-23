import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/recruiting90Api', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/recruiting90Api')>();
  return {
    ...real,
    listJobPostings: vi.fn(async () => ({ postings: [] })),
    listInterviewKits: vi.fn(async () => ({ kits: [] })),
    listOffers: vi.fn(async () => ({ offers: [] })),
    listReferrals: vi.fn(async () => ({ referrals: [] })),
    listInterviews: vi.fn(async () => ({ interviews: [] })),
  };
});
vi.mock('@/lib/recruitingApi', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/recruitingApi')>();
  return {
    ...real,
    getRecruitingSummary: vi.fn(),
    getCandidateBoard: vi.fn(async () => ({ columns: [] })),
    listCandidates: vi.fn(async () => ({ candidates: [] })),
    listRemovedCandidates: vi.fn(async () => ({ removed: [] })),
  };
});
vi.mock('@/lib/clientsApi', () => ({ listClients: vi.fn(async () => ({ clients: [] })) }));
vi.mock('@/lib/positionsApi', () => ({ listPositions: vi.fn(async () => ({ positions: [] })) }));
vi.mock('@/lib/savedViewsApi', () => ({ listSavedViews: vi.fn(async () => ({ views: [] })) }));

import { ROLE_CAPABILITIES } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { ConfirmProvider } from '@/lib/confirm';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { getRecruitingSummary } from '@/lib/recruitingApi';
import { RecruitingExtras } from '@/pages/recruiting/RecruitingExtras';
import { RecruitingHome } from '@/pages/recruiting/RecruitingHome';

/**
 * The recruiting hub (F500 2026-10-22): one strip of tabs under the title —
 * Pipeline, Job postings, Offers, Interview kits, Referrals, Analytics —
 * each still its own URL; each tab names itself and puts its own primary
 * action in the header; the pipeline's numbers open the candidates behind
 * them; Recently removed waits in More.
 */

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.pathname + l.search}</div>;
}

function renderAt(path: string) {
  const role = 'INTERNAL_RECRUITER' as const;
  const auth = {
    isInitializing: false,
    isOffline: false,
    user: { id: 'me', email: 'r@altohr.com', role, status: 'ACTIVE', clientId: null, associateId: null },
    role,
    primaryRole: role,
    availableRoles: [role],
    capabilities: ROLE_CAPABILITIES[role],
    can: () => true,
    signIn: vi.fn(),
    signOut: vi.fn(),
    refreshUser: vi.fn(),
    switchRole: vi.fn(),
  };
  render(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    <AuthContext.Provider value={auth as any}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <TooltipProvider>
          <ConfirmProvider>
            <MemoryRouter initialEntries={[path]}>
              <Routes>
                <Route path="/recruiting" element={<RecruitingHome />} />
                <Route path="/recruiting/extras" element={<RecruitingExtras />} />
              </Routes>
              <Where />
            </MemoryRouter>
          </ConfirmProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
  return userEvent.setup();
}

beforeEach(() => {
  vi.mocked(getRecruitingSummary).mockResolvedValue({
    byStage: { APPLIED: 5, SCREENING: 3, INTERVIEW: 2, OFFER: 1 },
    stuckAfterDays: 7,
    stuckCount: 0,
    stuck: [],
    interviewsToday: [],
    interviewsNext7Days: 0,
    unscoredInterviews: 0,
    offersAwaitingReply: 0,
    offersAwaitingApproval: 0,
    hiredThisMonth: 4,
    medianDaysToHire: null,
  } as never);
});

describe('recruiting hub', () => {
  it('opens /recruiting/extras?tab=offers on Offers: its title, the hub strip, and its own primary', async () => {
    const user = renderAt('/recruiting/extras?tab=offers');
    expect(await screen.findByRole('heading', { level: 1, name: 'Offers' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Recruiting' });
    expect(within(nav).getByRole('link', { name: 'Offers' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: 'Job postings' })).toHaveAttribute('href', '/recruiting/extras?tab=postings');
    expect(within(nav).getByRole('link', { name: 'Pipeline' })).toHaveAttribute('href', '/recruiting');
    expect(within(nav).getByRole('link', { name: 'Analytics' })).toHaveAttribute('href', '/recruiting/analytics');
    // The primary action sits in the header and opens that tab's drawer.
    await user.click(screen.getByRole('button', { name: 'New offer' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('switches tab through the strip, and the header action follows', async () => {
    const user = renderAt('/recruiting/extras?tab=offers');
    await screen.findByRole('heading', { level: 1, name: 'Offers' });
    await user.click(within(screen.getByRole('navigation', { name: 'Recruiting' })).getByRole('link', { name: 'Job postings' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Job postings' })).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/recruiting/extras?tab=postings');
    expect(screen.getAllByRole('button', { name: 'New posting' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'New offer' })).not.toBeInTheDocument();
  });

  it('gives the pipeline numbers that open the candidates behind them, and keeps Recently removed in More', async () => {
    const user = renderAt('/recruiting');
    const strip = await screen.findByRole('group', { name: 'Pipeline at a glance' });
    expect(within(strip).getByText('Interviewing').closest('a')).toHaveAttribute('href', '/recruiting?view=list&stage=INTERVIEW');
    expect(within(strip).getByText('Open offers').closest('a')).toHaveAttribute('href', '/recruiting?view=list&stage=OFFER');
    expect(within(strip).getByText('In funnel').closest('a')).toHaveAttribute('href', '/recruiting?view=board');
    expect(within(screen.getByRole('navigation', { name: 'Recruiting' })).getByRole('link', { name: 'Pipeline' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByPlaceholderText('Search candidates')).toBeInTheDocument();
    // Navigation is a strip, not buttons beside the primary.
    expect(screen.queryByRole('button', { name: 'Recently removed' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /more actions/i }));
    expect(await screen.findByRole('menuitem', { name: /recently removed/i })).toBeInTheDocument();
  });
});
