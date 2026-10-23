import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';
import { renderAs } from '../hrPack/harness';

vi.mock('@/lib/probation116Api', async (orig) => ({
  ...(await orig<typeof import('@/lib/probation116Api')>()),
  listProbations: vi.fn(),
  getProbationSummary: vi.fn(),
}));
vi.mock('@/lib/vto130Api', async (orig) => ({
  ...(await orig<typeof import('@/lib/vto130Api')>()),
  listMyVolunteer: vi.fn(),
  listVolunteerQueue: vi.fn(),
  getVolunteerSummary: vi.fn(),
  getVtoPolicy: vi.fn(),
}));
vi.mock('@/lib/tuition127Api', async (orig) => ({
  ...(await orig<typeof import('@/lib/tuition127Api')>()),
  listMyTuition: vi.fn(),
  listTuitionQueue: vi.fn(),
  getTuitionSummary: vi.fn(),
}));
vi.mock('@/lib/internalMobility120Api', async (orig) => ({
  ...(await orig<typeof import('@/lib/internalMobility120Api')>()),
  listInternalJobs: vi.fn(),
  listMyApplications: vi.fn(),
}));

import { getProbationSummary, listProbations } from '@/lib/probation116Api';
import { getVolunteerSummary, getVtoPolicy, listMyVolunteer, listVolunteerQueue } from '@/lib/vto130Api';
import { getTuitionSummary, listMyTuition, listTuitionQueue } from '@/lib/tuition127Api';
import { listInternalJobs, listMyApplications } from '@/lib/internalMobility120Api';
import { ProbationHome } from '@/pages/probation/ProbationHome';
import { VtoHome } from '@/pages/vto/VtoHome';
import { TuitionHome } from '@/pages/tuition/TuitionHome';
import { InternalJobsHome } from '@/pages/internalJobs/InternalJobsHome';

/**
 * The HR desks' views (F500 2026-10-22): reviewers land on their queue,
 * tiles are the filters, the view is in the URL, and an unset program
 * says so instead of "0 / 0".
 */

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.search}</div>;
}

const vtoMine = (capHours: number) => ({ year: 2026, usedHours: 0, capHours, matchRatio: 0, matchCurrency: 'USD', entries: [] });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listProbations).mockResolvedValue({ probations: [], total: 0, hasMore: false });
  vi.mocked(getProbationSummary).mockResolvedValue({ active: 3, endingSoon: 1, overdue: 2, passedLast90Days: 4, failedLast90Days: 0 });
  vi.mocked(listMyVolunteer).mockResolvedValue(vtoMine(0));
  vi.mocked(listVolunteerQueue).mockResolvedValue({ entries: [] });
  vi.mocked(getVolunteerSummary).mockResolvedValue({ pendingCount: 0, hoursYtd: '0', matchedAmountYtd: '0.00' });
  vi.mocked(getVtoPolicy).mockResolvedValue({ policy: null, effective: { annualHoursCap: '0', matchRatio: '0', matchCurrency: 'USD' } });
  vi.mocked(listMyTuition).mockResolvedValue({ requests: [] });
  vi.mocked(listTuitionQueue).mockResolvedValue({ requests: [] });
  vi.mocked(getTuitionSummary).mockResolvedValue({ pendingCount: 0, approvedAwaitingPayment: 0, paidYtdAmount: '0.00' } as never);
  vi.mocked(listInternalJobs).mockResolvedValue({ jobs: [] } as never);
  vi.mocked(listMyApplications).mockResolvedValue({ applications: [] } as never);
});

describe('Probation', () => {
  it('makes each tile the filter for the probations it counts, in the URL', async () => {
    renderAs('HR_ADMINISTRATOR', <><ProbationHome /><Where /></>, '/probation');
    const strip = await screen.findByRole('group', { name: 'Probations at a glance' });
    await userEvent.click(within(strip).getByRole('button', { name: /Overdue/ }));
    expect(screen.getByTestId('where')).toHaveTextContent('status=overdue');
    await waitFor(() => expect(listProbations).toHaveBeenLastCalledWith(undefined, 0, 'overdue'));
  });
});

describe('Volunteer time', () => {
  it('lands a reviewer on the queue and says the program is not set up when the cap is 0', async () => {
    renderAs('HR_ADMINISTRATOR', <VtoHome />, '/volunteer');
    expect(await screen.findByText("Volunteer time isn't set up")).toBeInTheDocument();
    await waitFor(() => expect(listVolunteerQueue).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'Set an annual cap' })).toBeInTheDocument();
    // No search box over an empty queue.
    expect(await screen.findByText('Nothing to review')).toBeInTheDocument();
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/name…/)).not.toBeInTheDocument();
  });

  it('tells an associate it is not offered instead of "0 / 0" and "up to 0 hours"', async () => {
    renderAs('ASSOCIATE', <VtoHome />, '/volunteer', { associateId: 'a1' });
    expect(await screen.findByText("Volunteer time isn't offered yet")).toBeInTheDocument();
    expect(screen.queryByText(/0 \/ 0/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Log hours/ })).not.toBeInTheDocument();
  });
});

describe('Tuition', () => {
  it('lands an approver on the queue, and the tab is in the URL', async () => {
    renderAs('FINANCE_ACCOUNTANT', <><TuitionHome /><Where /></>, '/tuition');
    await waitFor(() => expect(listTuitionQueue).toHaveBeenCalled());
    expect(listMyTuition).not.toHaveBeenCalled();
    expect(await screen.findByText('Nothing to review')).toBeInTheDocument();
  });
});

describe('Internal jobs', () => {
  it('gives someone who posts jobs the way to post one', async () => {
    renderAs('INTERNAL_RECRUITER', <InternalJobsHome />, '/internal-jobs');
    expect(await screen.findByRole('link', { name: /Post a job/ })).toHaveAttribute('href', '/recruiting/extras?tab=postings&new=1');
    expect(screen.getByRole('link', { name: 'Manage postings' })).toHaveAttribute('href', '/recruiting/extras?tab=postings');
  });
});
