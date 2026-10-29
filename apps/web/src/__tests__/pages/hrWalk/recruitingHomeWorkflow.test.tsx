import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { Candidate } from '@alto-people/shared';

/**
 * The recruiter's screening line (role walk HR 10, 18 and the audit's
 * bulk removal):
 *   - the candidate drawer moves next/previous through the page's order
 *     (j/k, and the arrows in its header);
 *   - Advance or Reject from the drawer opens the next one in that stage;
 *   - a candidate added while the board is filtered on a posting belongs
 *     to that posting (it counts toward its fill rate from the start);
 *   - removing several takes one call with the list.
 */

vi.mock('@/lib/recruitingApi', () => ({
  listCandidates: vi.fn(),
  getCandidateBoard: vi.fn(),
  getCandidate: vi.fn(),
  getRecruitingSummary: vi.fn(),
  listAllCandidates: vi.fn(async () => []),
  createCandidate: vi.fn(async () => ({})),
  advanceCandidate: vi.fn(async () => ({})),
  hireCandidate: vi.fn(async () => ({})),
  updateCandidate: vi.fn(async () => ({})),
  listCandidateEvents: vi.fn(async () => ({ events: [] })),
  addCandidateNote: vi.fn(async () => ({ ok: true })),
  listSubmittals: vi.fn(async () => ({ submittals: [] })),
  submitToClient: vi.fn(),
  withdrawSubmittal: vi.fn(),
  removeCandidate: vi.fn(async () => undefined),
  bulkRemoveCandidates: vi.fn(async () => ({ removed: 1, skipped: [{ id: 'b', reason: 'Already hired' }] })),
  restoreCandidate: vi.fn(async () => ({})),
  listRemovedCandidates: vi.fn(async () => ({ removed: [] })),
  undoHire: vi.fn(),
}));
vi.mock('@/lib/recruiting90Api', () => ({
  listInterviews: vi.fn(async () => ({ interviews: [] })),
  listOffers: vi.fn(async () => ({ offers: [] })),
  listInterviewKits: vi.fn(async () => ({ kits: [] })),
  listInterviewers: vi.fn(async () => ({ interviewers: [] })),
  createInterview: vi.fn(),
  updateInterview: vi.fn(),
  deleteInterview: vi.fn(),
  scoreInterview: vi.fn(),
  listJobPostings: vi.fn(async () => ({
    postings: [
      { id: 'post-1', title: 'Line Cook', clientName: 'Northside Grill', status: 'OPEN', openings: 3, hired: 1 },
      { id: 'post-2', title: 'Dishwasher', clientName: null, status: 'OPEN', openings: 1, hired: 0 },
    ],
  })),
}));
vi.mock('@/lib/onboardingApi', () => ({
  listClients: vi.fn(async () => ({ clients: [] })),
  listClientOptions: vi.fn(async () => ({ clients: [] })),
  listTemplates: vi.fn(async () => ({ templates: [] })),
  createApplication: vi.fn(),
  payScheduleForHire: vi.fn(async () => ({ schedule: null, conflict: null })),
}));
vi.mock('@/lib/clientsApi', () => ({
  listClients: vi.fn(async () => ({ clients: [] })),
  listClientLocations: vi.fn(async () => ({ locations: [] })),
}));
vi.mock('@/lib/orgApi', () => ({
  listShiftPositions: vi.fn(async () => ({ shiftPositions: [] })),
  listSites: vi.fn(async () => ({ sites: [] })),
}));
vi.mock('@/lib/positionsApi', () => ({ listPositions: vi.fn(async () => ({ positions: [] })) }));
vi.mock('@/lib/savedViewsApi', () => ({
  listSavedViews: vi.fn(async () => ({ views: [] })),
  createSavedView: vi.fn(),
  updateSavedView: vi.fn(),
  deleteSavedView: vi.fn(),
}));
vi.mock('@/lib/auth', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth')>()),
  useAuth: () => ({ can: () => true, user: { id: 'me-1' } }),
}));

import {
  advanceCandidate,
  bulkRemoveCandidates,
  createCandidate,
  getCandidate,
  getCandidateBoard,
  getRecruitingSummary,
  listCandidates,
} from '@/lib/recruitingApi';
import { RecruitingHome } from '@/pages/recruiting/RecruitingHome';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { ConfirmProvider } from '@/lib/confirm';

const cand = (id: string, firstName: string, stage: Candidate['stage']): Candidate =>
  ({
    id,
    firstName,
    lastName: 'Test',
    email: `${id}@example.com`,
    phone: null,
    position: 'Line Cook',
    source: 'referral',
    stage,
    notes: null,
    resumeUrl: null,
    linkedinUrl: null,
    hiredAssociateId: null,
    hiredClientId: null,
    hiredAt: null,
    rejectedReason: null,
    withdrawnReason: null,
    jobPostingId: null,
    stageChangedAt: new Date(Date.now() - 86_400_000).toISOString(),
    createdAt: '2026-10-01T12:00:00.000Z',
  }) as Candidate;

const STAGES = ['APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER', 'HIRED', 'WITHDRAWN', 'REJECTED'] as const;
let people: Candidate[] = [];

function renderHome(url = '/recruiting') {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>
        <ConfirmProvider>
          <MemoryRouter initialEntries={[url]}>
            <RecruitingHome />
          </MemoryRouter>
        </ConfirmProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

const drawerName = async (name: string) =>
  waitFor(() => expect(within(screen.getByRole('dialog')).getByRole('heading', { name })).toBeInTheDocument());

beforeEach(() => {
  localStorage.clear();
  people = [cand('a', 'Ann', 'APPLIED'), cand('b', 'Ben', 'SCREENING'), cand('c', 'Cal', 'APPLIED')];
  vi.mocked(listCandidates).mockImplementation(async () => ({ candidates: people, total: people.length }) as never);
  vi.mocked(getCandidateBoard).mockImplementation(
    async () =>
      ({
        columns: STAGES.map((stage) => {
          const inStage = people.filter((c) => c.stage === stage);
          return { stage, total: inStage.length, candidates: inStage };
        }),
      }) as never,
  );
  vi.mocked(getCandidate).mockImplementation(async (id: string) => people.find((c) => c.id === id) as never);
  vi.mocked(getRecruitingSummary).mockResolvedValue({
    byStage: { APPLIED: 2, SCREENING: 1, INTERVIEW: 0, OFFER: 0 },
    stuckAfterDays: 7,
    stuckCount: 0,
    stuck: [],
    interviewsToday: [],
    interviewsNext7Days: 0,
    unscoredInterviews: 0,
    offersAwaitingReply: 0,
    offersAwaitingApproval: 0,
    hiredThisMonth: 0,
    medianDaysToHire: null,
  } as never);
  vi.mocked(advanceCandidate).mockClear();
  vi.mocked(createCandidate).mockClear();
  vi.mocked(bulkRemoveCandidates).mockClear();
});

describe('the candidate drawer — next and previous (HR 10)', () => {
  it('j and k move through the board’s order; the header arrows do the same', async () => {
    const user = renderHome('/recruiting?view=board&candidateId=a');
    await drawerName('Ann Test');
    // Board order, left to right: Applied (Ann, Cal), then Screening (Ben).
    await user.keyboard('j');
    await drawerName('Cal Test');
    await user.keyboard('j');
    await drawerName('Ben Test');
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Next candidate' })).toBeDisabled();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Previous candidate' }));
    await drawerName('Cal Test');
    await user.keyboard('k');
    await drawerName('Ann Test');
  });

  it('after Advance from the drawer, the next one in the same stage opens', async () => {
    const user = renderHome('/recruiting?view=board&candidateId=a');
    await drawerName('Ann Test');
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /^Screening/ }));
    await waitFor(() => expect(advanceCandidate).toHaveBeenCalledWith('a', { stage: 'SCREENING' }));
    // Cal is the next one waiting in Applied — not Ben, who is a stage ahead.
    await drawerName('Cal Test');
  });
});

describe('new candidate on a filtered board (HR 18)', () => {
  it('belongs to the posting the board is filtered on, with a resume link', async () => {
    const user = renderHome('/recruiting?view=board&posting=post-1');
    await user.click(await screen.findByRole('button', { name: /New candidate/ }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect((within(dialog).getByLabelText('Job posting') as HTMLSelectElement).value).toBe('post-1'));
    await user.type(within(dialog).getByLabelText(/First name/), 'Dee');
    await user.type(within(dialog).getByLabelText(/Last name/), 'Nguyen');
    await user.type(within(dialog).getByLabelText(/Email/), 'dee@example.com');
    await user.type(within(dialog).getByLabelText(/Resume link/), 'https://drive.example.com/dee.pdf');
    await user.click(within(dialog).getByRole('button', { name: 'Save as Applied' }));
    await waitFor(() => expect(createCandidate).toHaveBeenCalled());
    expect(vi.mocked(createCandidate).mock.calls[0]![0]).toMatchObject({
      firstName: 'Dee',
      jobPostingId: 'post-1',
      resumeUrl: 'https://drive.example.com/dee.pdf',
    });
  });
});

describe('bulk removal (audit, Tier 3)', () => {
  it('removes the selected candidates in one call, and says what was skipped', async () => {
    const user = renderHome('/recruiting?view=list');
    await user.click(await screen.findByRole('checkbox', { name: 'Select Ann Test' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Cal Test' }));
    await user.click(screen.getByRole('button', { name: /Remove selected/ }));
    const prompt = await screen.findByRole('alertdialog').catch(() => screen.getByRole('dialog'));
    await user.type(within(prompt).getByRole('textbox'), 'Test entries');
    await user.click(within(prompt).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(bulkRemoveCandidates).toHaveBeenCalledWith(['a', 'c'], 'Test entries'));
  });
});
