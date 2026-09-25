import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RecruiterHome } from '@alto-people/shared';

vi.mock('@/lib/recruitingApi', () => ({ getRecruiterHome: vi.fn() }));
vi.mock('@/lib/onboardingApi', () => ({ resendInvite: vi.fn(async () => ({ invitedUserId: 'u', inviteUrl: null })) }));
// Supplements with their own data; not this page's subject.
vi.mock('@/components/RoleDecisionQueue', () => ({ RoleDecisionQueue: () => null }));
vi.mock('@/components/MyPlanCard', () => ({ MyPlanCard: () => null }));
vi.mock('@/lib/auth', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth')>()),
  useAuth: () => ({
    user: { id: 'me', email: 'dana.reyes@altohr.com', firstName: 'Dana', role: 'INTERNAL_RECRUITER' },
    role: 'INTERNAL_RECRUITER',
    can: () => true,
  }),
}));

import { getRecruiterHome } from '@/lib/recruitingApi';
import { resendInvite } from '@/lib/onboardingApi';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { RecruiterDashboard } from '@/pages/RecruiterDashboard';

/**
 * The recruiter's home: their day, what's waiting on them and on others —
 * not the HR administrator's payroll and shifts.
 */

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

const EMPTY: RecruiterHome = {
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
  waitingOnOthers: {
    withClients: { total: 0, items: [] },
    awaitingSignature: { total: 0, items: [] },
    onboardingNotStarted: { total: 0, items: [] },
  },
  pipeline: { APPLIED: 0, SCREENING: 0, INTERVIEW: 0, OFFER: 0 },
  postings: { total: 0, items: [] },
  numbers: { hiresThisMonth: 0, hiresLastMonth: 0, medianDaysToHire: null, offerAcceptancePct: null, offersDecided: 0 },
  activity: [],
};

const FULL: RecruiterHome = {
  interviewsToday: [
    { id: id(1), candidateId: id(11), candidateName: 'Kim Phan', position: 'Cashier', scheduledFor: at(-3), durationMinutes: 30, location: null, interviewerName: 'Lee Ray', mine: false, state: 'done' },
    { id: id(2), candidateId: id(12), candidateName: 'Ana Diaz', position: 'Stocker', scheduledFor: at(-1), durationMinutes: 45, location: 'Destin #1234', interviewerName: 'Dana Reyes', mine: true, state: 'needs_score' },
    { id: id(3), candidateId: id(13), candidateName: 'Ben Okafor', position: null, scheduledFor: at(2), durationMinutes: 30, location: null, interviewerName: null, mine: false, state: 'upcoming' },
  ],
  newApplicants: {
    last24h: 3,
    last7d: 12,
    bySource: [{ source: 'indeed', count: 8 }, { source: null, count: 4 }],
    recent: [{ candidateId: id(14), candidateName: 'Riley Cho', position: 'Cashier', source: 'indeed', postingTitle: 'Cashier — Destin', createdAt: at(-2) }],
  },
  waitingOnYou: {
    toScore: { total: 4, mine: 1, items: [{ interviewId: id(2), candidateId: id(12), candidateName: 'Ana Diaz', scheduledFor: at(-1), interviewerName: 'Dana Reyes', mine: true }] },
    stuck: { total: 9, afterDays: 7, items: [{ candidateId: id(15), candidateName: 'Stale Person', position: null, stage: 'SCREENING', daysInStage: 12 }] },
    closingSoon: { total: 1, items: [{ candidateId: id(25), candidateName: 'Going Cold', stage: 'APPLIED', closesAt: '2026-10-01T12:00:00.000Z' }] },
    clientApproved: [{ submittalId: id(21), candidateId: id(16), candidateName: 'Yes Candidate', clientName: 'Walmart', storeName: 'Destin #1234', feedback: 'Send her Monday.', decidedAt: at(-20) }],
    readyToHire: [{ offerId: id(31), candidateId: id(17), candidateName: 'Signed Person', jobTitle: 'Cashier', clientName: 'Walmart', startDate: '2026-10-05', acceptedAt: at(-5) }],
    offersToApprove: [{ offerId: id(32), candidateId: id(18), candidateName: 'Held Offer', jobTitle: 'Cashier', approvalNote: '$19.00/hr is above the Cashier band.' }],
  },
  waitingOnOthers: {
    withClients: { total: 2, items: [{ submittalId: id(22), candidateId: id(19), candidateName: 'With Client', clientName: 'Target', storeName: null, sentAt: at(-72), days: 3 }] },
    awaitingSignature: { total: 1, items: [{ offerId: id(33), candidateId: id(20), candidateName: 'Out Signing', jobTitle: 'Stocker', sentAt: at(-24), expiresAt: at(20), expiringSoon: true }] },
    onboardingNotStarted: { total: 1, items: [{ applicationId: id(41), candidateId: id(24), candidateName: 'Idle Hire', clientName: 'Walmart', invitedAt: at(-96), days: 4, closesAt: at(30) }] },
  },
  pipeline: { APPLIED: 40, SCREENING: 12, INTERVIEW: 5, OFFER: 2 },
  postings: { total: 1, items: [{ id: id(51), title: 'Cashier — Destin', clientName: 'Walmart', openings: 4, hired: 1, applicants: 30, applicants7d: 6, daysOpen: 18 }] },
  numbers: { hiresThisMonth: 3, hiresLastMonth: 5, medianDaysToHire: 6.5, offerAcceptancePct: 80, offersDecided: 10 },
  activity: [{ id: id(61), candidateId: id(11), candidateName: 'Kim Phan', kind: 'STAGE_CHANGED', fromStage: 'SCREENING', toStage: 'INTERVIEW', body: null, actorName: 'Dana Reyes', createdAt: at(-1) }],
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
  return userEvent.setup();
}

beforeEach(() => {
  vi.mocked(getRecruiterHome).mockReset();
});

describe('<RecruiterDashboard>', () => {
  it('leads with today: each interview says whether it is done, due a score, or coming up', async () => {
    vi.mocked(getRecruiterHome).mockResolvedValue(FULL);
    renderPage();
    const list = await screen.findByRole('list', { name: "Today's interviews" });
    const rows = within(list).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Kim Phan');
    expect(rows[0]).toHaveTextContent('Scored');
    expect(rows[1]).toHaveTextContent('Needs a score');
    expect(rows[1]).toHaveTextContent('Destin #1234 · you');
    expect(rows[2]).toHaveTextContent('Upcoming');
    expect(within(rows[0]).getByRole('link', { name: 'Kim Phan' })).toHaveAttribute('href', `/recruiting?candidateId=${id(11)}`);
    expect(screen.getByText('in the last day · 12 this week')).toBeInTheDocument();
  });

  it('says what is waiting on the recruiter, and what to do about each', async () => {
    vi.mocked(getRecruiterHome).mockResolvedValue(FULL);
    renderPage();
    expect(await screen.findByText('Signed — ready to hire (1)')).toBeInTheDocument();
    expect(screen.getByText('Clients said yes — make the offer (1)')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Make offer' })).toHaveAttribute(
      'href',
      `/recruiting/extras?tab=offers&new=1&candidate=${id(16)}`,
    );
    expect(screen.getByText(/Send her Monday/)).toBeInTheDocument();
    expect(screen.getByText('Interviews to score (4 · 1 yours)')).toBeInTheDocument();
    expect(screen.getByText('Offers to approve (1)')).toBeInTheDocument();
    expect(screen.getByText('$19.00/hr is above the Cashier band.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /See all 9/ })).toHaveAttribute('href', '/recruiting?view=list&stage=ALL&stuck=1&sort=waiting');
    // The warning before the clean-up closes anyone.
    expect(screen.getByText('Closing soon — no response (1)')).toBeInTheDocument();
    expect(screen.getByText('closes Oct 1, 2026')).toBeInTheDocument();
  });

  it('and what is waiting on others — with a way to nudge a new hire', async () => {
    vi.mocked(getRecruiterHome).mockResolvedValue(FULL);
    const user = renderPage();
    expect(await screen.findByText('With clients to review (2)')).toBeInTheDocument();
    expect(screen.getByText('expires', { exact: false })).toHaveClass('text-warning');
    await user.click(screen.getByRole('button', { name: 'Resend the onboarding invite to Idle Hire' }));
    await waitFor(() => expect(resendInvite).toHaveBeenCalledWith(id(41)));
  });

  it('shows the pipeline, postings, numbers and recruiting activity — not payroll', async () => {
    vi.mocked(getRecruiterHome).mockResolvedValue(FULL);
    renderPage();
    expect(await screen.findByRole('meter', { name: 'Cashier — Destin filled' })).toHaveAttribute('aria-valuenow', '25');
    expect(screen.getByText('30 applicants (+6) · 18d open')).toBeInTheDocument();
    expect(screen.getByText('80%')).toBeInTheDocument();
    expect(screen.getByText('5 last month')).toBeInTheDocument();
    expect(screen.getByText(/— Screening → Interview/)).toBeInTheDocument();
    expect(screen.queryByText(/net paid/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/all systems nominal/i)).not.toBeInTheDocument();
  });

  it('says plainly when nothing is waiting', async () => {
    vi.mocked(getRecruiterHome).mockResolvedValue(EMPTY);
    renderPage();
    expect(await screen.findByText(/Nothing waiting on you/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing out with anyone/)).toBeInTheDocument();
    expect(screen.getByText('No interviews today.')).toBeInTheDocument();
  });

  it('offers a retry when it cannot load', async () => {
    vi.mocked(getRecruiterHome).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(EMPTY);
    const user = renderPage();
    await user.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No interviews today.')).toBeInTheDocument();
  });
});
