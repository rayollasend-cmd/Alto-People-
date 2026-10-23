import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RecruiterHome } from '@alto-people/shared';

/**
 * The recruiter home on a quiet day (F500 G5): no interviews is one line,
 * not a 275px empty hero; the short store nobody is hiring for is counted in
 * "Waiting on you" and the open demand (gaps + requisitions, one card) sits
 * at the top; the pipeline is counted once.
 */

vi.mock('@/lib/recruitingApi', () => ({ getRecruiterHome: vi.fn() }));
vi.mock('@/lib/onboardingApi', () => ({ resendInvite: vi.fn() }));
vi.mock('@/components/RoleDecisionQueue', () => ({ RoleDecisionQueue: () => null }));
vi.mock('@/components/MyPlanCard', () => ({ MyPlanCard: () => null }));
vi.mock('@/pages/recruiting/RecruiterCalendarFeed', () => ({ RecruiterCalendarFeed: () => null }));
vi.mock('@/lib/meDecisions', async (orig) => ({ ...(await orig<typeof import('@/lib/meDecisions')>()), useNeedsYouCount: ({ cards }: { cards: number }) => cards }));
vi.mock('@/lib/recruiting90Api', async (orig) => ({ ...(await orig<typeof import('@/lib/recruiting90Api')>()), listJobPostings: vi.fn(async () => ({ postings: [] })) }));
vi.mock('@/pages/recruiting/staffingGaps', () => ({
  getStaffingPlan: vi.fn(async () => ({ stores: [] })),
  gapsWithoutPosting: () => [{ storeId: 's1', storeName: 'Front Beach 218', clientId: 'c1', clientName: 'Coastal Resort Holdings', short: 23, from: '2026-11-14' }],
}));
vi.mock('@/lib/auth', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth')>()),
  useAuth: () => ({ user: { id: 'me', email: 'r@altohr.com', role: 'INTERNAL_RECRUITER' }, role: 'INTERNAL_RECRUITER', can: () => true }),
}));

import { getRecruiterHome } from '@/lib/recruitingApi';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { RecruiterDashboard } from '@/pages/RecruiterDashboard';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const QUIET: RecruiterHome = {
  interviewsToday: [],
  newApplicants: { last24h: 0, last7d: 0, bySource: [], recent: [] },
  waitingOnYou: {
    toScore: { total: 0, mine: 0, items: [] },
    stuck: { total: 0, afterDays: 7, items: [] },
    closingSoon: { total: 0, items: [] },
    clientApproved: [],
    readyToHire: [],
    offersToApprove: [],
  },
  waitingOnOthers: { withClients: { total: 0, items: [] }, awaitingSignature: { total: 0, items: [] }, onboardingNotStarted: { total: 0, items: [] } },
  pipeline: { APPLIED: 3, SCREENING: 2, INTERVIEW: 0, OFFER: 1 },
  postings: { total: 0, items: [] },
  numbers: { hiresThisMonth: 0, hiresLastMonth: 0, medianDaysToHire: null, offerAcceptancePct: null, offersDecided: 0 },
  requisitions: {
    total: 1,
    byStatus: { OPEN: 1 },
    items: [{ id: id(52), code: 'REQ-2', title: 'Stocker', clientName: 'Coastal Resort Holdings', status: 'OPEN', fteAuthorized: 2, targetStartDate: null }],
  },
  activity: [],
};

function renderPage() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>
        <MemoryRouter>
          <RecruiterDashboard />
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('the recruiter home on a quiet day', () => {
  it('says "no interviews" in one line and puts the open demand — gaps and requisitions in one card — at the top', async () => {
    vi.mocked(getRecruiterHome).mockResolvedValue(QUIET);
    renderPage();
    const line = await screen.findByTestId('no-interviews-line');
    expect(line).toHaveTextContent('No interviews today');
    expect(within(line).getByRole('link', { name: /Candidates in screening/ })).toHaveAttribute('href', '/recruiting?view=list&stage=SCREENING');
    const demand = (await screen.findByText('Open demand')).closest('section')!;
    // It is the hero now: in the "Today" section, above "Waiting on you".
    expect(demand.closest('section[aria-label="Today"]')).not.toBeNull();
    expect(within(demand).getByText('Front Beach 218')).toBeInTheDocument();
    expect(within(demand).getByRole('link', { name: /Open a posting for 23/ })).toBeInTheDocument();
    expect(within(demand).getByText('Stocker')).toBeInTheDocument();
    expect(within(demand).getByRole('link', { name: 'Open a posting' })).toHaveAttribute(
      'href',
      '/recruiting/extras?tab=postings&new=1&title=Stocker&openings=2&location=Coastal+Resort+Holdings',
    );
    // Never "hiring against nothing" beside a short store.
    expect(screen.queryByText(/hiring against nothing/)).toBeNull();
    expect(screen.getAllByText('Open demand')).toHaveLength(1);
  });

  it('counts the short store in "Waiting on you", and the pipeline once', async () => {
    vi.mocked(getRecruiterHome).mockResolvedValue(QUIET);
    renderPage();
    expect(await screen.findByText('Short stores with no posting (1)')).toBeInTheDocument();
    expect(screen.getByTestId('needs-you-count')).toHaveTextContent('1');
    expect(screen.queryByText(/Nothing in your pipeline is waiting on you/)).toBeNull();
    // The stage strip carries the pipeline; the "In the pipeline" tile is gone.
    expect(screen.queryByText('In the pipeline')).toBeNull();
    // No role pill under the greeting.
    expect(screen.queryByText(/internal recruiter/i)).toBeNull();
  });
});
