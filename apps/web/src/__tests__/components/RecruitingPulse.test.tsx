import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RecruitingSummary } from '@alto-people/shared';

vi.mock('@/lib/recruitingApi', () => ({ getRecruitingSummary: vi.fn() }));

import { getRecruitingSummary } from '@/lib/recruitingApi';
import { RecruitingPulse } from '@/components/RecruitingPulse';

/**
 * The recruiter's dashboard promised "Recruiting pipeline and open
 * onboarding applications" and showed no recruiting at all — "All systems
 * nominal" with candidates going cold. This is the part that answers it.
 */

const QUIET: RecruitingSummary = {
  byStage: { APPLIED: 4, SCREENING: 2, INTERVIEW: 1, OFFER: 1 },
  stuckAfterDays: 7,
  stuckCount: 0,
  stuck: [],
  interviewsToday: [],
  interviewsNext7Days: 0,
  unscoredInterviews: 0,
  offersAwaitingReply: 0,
  offersAwaitingApproval: 0,
  hiredThisMonth: 3,
  medianDaysToHire: 6.5,
};

function renderPulse(summary: RecruitingSummary) {
  vi.mocked(getRecruitingSummary).mockResolvedValue(summary);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <RecruitingPulse />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('<RecruitingPulse>', () => {
  it('shows the funnel, each stage a way into its list', async () => {
    renderPulse(QUIET);
    const applied = await screen.findByRole('link', { name: /applied\s*4/i });
    expect(applied).toHaveAttribute('href', '/recruiting?stage=APPLIED');
    expect(screen.getByRole('link', { name: /offer\s*1/i })).toHaveAttribute('href', '/recruiting?stage=OFFER');
    expect(screen.getByText(/hired this month/)).toHaveTextContent('3 hired this month');
    expect(screen.getByText(/median/)).toHaveTextContent('median 6.5 days from applying to hired');
  });

  it('says so when nothing is waiting — and only then', async () => {
    renderPulse(QUIET);
    expect(await screen.findByText('Nothing in recruiting is waiting on you.')).toBeInTheDocument();
  });

  it('names what is waiting: stuck candidates, interviews to score, offers with no answer', async () => {
    renderPulse({
      ...QUIET,
      stuckCount: 3,
      stuck: [
        { id: 'c1', name: 'Kim Phan', position: 'Cashier', stage: 'SCREENING', daysInStage: 12 },
        { id: 'c2', name: 'Diego Santos', position: null, stage: 'APPLIED', daysInStage: 8 },
      ],
      unscoredInterviews: 2,
      offersAwaitingReply: 1,
    });
    expect(await screen.findByText('3 candidates have waited 7+ days in one stage')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Kim Phan · Cashier' })).toHaveAttribute('href', '/recruiting?candidateId=c1');
    expect(screen.getByText('Screening · 12d')).toBeInTheDocument();
    expect(screen.getByText('2 interviews need a score')).toBeInTheDocument();
    expect(screen.getByText('1 offer is waiting on an answer')).toBeInTheDocument();
    expect(screen.queryByText('Nothing in recruiting is waiting on you.')).not.toBeInTheDocument();
  });
});
