import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { fmtDateTime } from '@/lib/format';

vi.mock('@/lib/recruitingApi', () => ({
  listCandidates: vi.fn(),
  getCandidateBoard: vi.fn(),
  getCandidate: vi.fn(),
  getRecruitingSummary: vi.fn(),
  listAllCandidates: vi.fn(async () => []),
  createCandidate: vi.fn(),
  advanceCandidate: vi.fn(async () => ({})),
  hireCandidate: vi.fn(async () => ({})),
  updateCandidate: vi.fn(async () => ({})),
  listCandidateEvents: vi.fn(async () => ({ events: [] })),
  addCandidateNote: vi.fn(async () => ({ ok: true })),
  listSubmittals: vi.fn(async () => ({ submittals: [] })),
  submitToClient: vi.fn(async () => ({ clientName: 'Northside Grill' })),
  withdrawSubmittal: vi.fn(async () => ({ ok: true })),
}));

vi.mock('@/lib/recruiting90Api', () => ({
  listInterviews: vi.fn(async () => ({ interviews: [] })),
  listOffers: vi.fn(async () => ({ offers: [] })),
  listInterviewKits: vi.fn(async () => ({ kits: [] })),
  createInterview: vi.fn(async () => ({ id: 'int-new', invited: { candidate: true, interviewer: true } })),
  updateInterview: vi.fn(async () => ({ ok: true, invited: { candidate: true, interviewer: true } })),
  deleteInterview: vi.fn(async () => undefined),
  scoreInterview: vi.fn(async () => ({ ok: true })),
  listJobPostings: vi.fn(async () => ({
    postings: [
      { id: 'post-1', title: 'Line Cook', clientName: 'Northside Grill', status: 'OPEN', openings: 3, hired: 1 },
      { id: 'post-2', title: 'Dishwasher', clientName: null, status: 'CLOSED', openings: 1, hired: 1 },
    ],
  })),
}));

// The hire dialog is the onboarding invite; its pickers load from these.
vi.mock('@/lib/onboardingApi', () => ({
  listClients: vi.fn(async () => ({ clients: [{ id: 'c1', name: 'Northside Grill', state: 'FL' }] })),
  listTemplates: vi.fn(async () => ({
    templates: [{ id: 't1', name: 'Standard', track: 'STANDARD', clientId: null }],
  })),
  createApplication: vi.fn(),
}));
vi.mock('@/lib/clientsApi', () => ({
  listClients: vi.fn(async () => ({ clients: [{ id: 'c1', name: 'Northside Grill', state: 'FL' }] })),
  listClientLocations: vi.fn(async () => ({ locations: [{ id: 'loc-1', name: 'Store 12', state: 'FL' }] })),
}));
vi.mock('@/lib/orgApi', () => ({
  listShiftPositions: vi.fn(async () => ({ shiftPositions: [] })),
}));

vi.mock('@/lib/positionsApi', () => ({
  listPositions: vi.fn(async () => ({ positions: [] })),
}));

vi.mock('@/lib/savedViewsApi', () => ({
  listSavedViews: vi.fn(async () => ({ views: [] })),
  createSavedView: vi.fn(async (body: { name: string; query: Record<string, string> }) => ({
    id: 'sv-new', scope: 'recruiting.candidates', name: body.name, query: body.query, shared: false, mine: true, ownerName: 'me', updatedAt: '',
  })),
  updateSavedView: vi.fn(),
  deleteSavedView: vi.fn(),
}));

vi.mock('@/lib/auth', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth')>()),
  useAuth: () => ({ can: () => true, user: { id: 'me-1' } }),
}));

import type { Candidate } from '@alto-people/shared';
import {
  addCandidateNote,
  advanceCandidate,
  getCandidate,
  getCandidateBoard,
  getRecruitingSummary,
  hireCandidate,
  listCandidateEvents,
  listCandidates,
  listSubmittals,
  submitToClient,
  updateCandidate,
  withdrawSubmittal,
} from '@/lib/recruitingApi';
import {
  createInterview,
  deleteInterview,
  listInterviewKits,
  listInterviews,
  listOffers,
  scoreInterview,
  updateInterview,
} from '@/lib/recruiting90Api';
import { listClientLocations } from '@/lib/clientsApi';
import { RecruitingHome } from '@/pages/recruiting/RecruitingHome';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { ConfirmProvider } from '@/lib/confirm';
import { createSavedView, listSavedViews } from '@/lib/savedViewsApi';

// The page reads through the query layer; every render gets a client.
function withQueryClient({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      {children}
    </QueryClientProvider>
  );
}
const render = (ui: Parameters<typeof rtlRender>[0], options?: Parameters<typeof rtlRender>[1]) =>
  rtlRender(ui, { wrapper: withQueryClient, ...options });

const MARIA = {
  id: 'cand-1',
  firstName: 'Maria',
  lastName: 'Lopez',
  email: 'maria@example.com',
  phone: '555-0134',
  position: 'Line Cook',
  source: 'referral',
  stage: 'APPLIED' as const,
  notes: 'Strong prep experience; available weekends.',
  resumeUrl: null,
  linkedinUrl: null,
  hiredAssociateId: null,
  hiredClientId: null,
  hiredAt: null,
  rejectedReason: null,
  withdrawnReason: null,
  // Applied weeks ago, but only three days in the current stage.
  stageChangedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
  createdAt: '2026-07-01T12:00:00.000Z',
};

function renderHome(initialUrl = '/recruiting') {
  // Layout supplies TooltipProvider in the real app; a standalone page render
  // has to stand it up itself or every Tooltip throws on mount.
  render(
    <TooltipProvider>
      <ConfirmProvider>
        <MemoryRouter initialEntries={[initialUrl]}>
          <RecruitingHome />
        </MemoryRouter>
      </ConfirmProvider>
    </TooltipProvider>,
  );
  return userEvent.setup();
}

const STAGE_ORDER = ['APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER', 'HIRED', 'WITHDRAWN', 'REJECTED'] as const;
/** The pipeline each test set with listCandidates — read without counting as a call. */
async function pipeline(): Promise<Candidate[]> {
  const impl = vi.mocked(listCandidates).getMockImplementation();
  return impl ? ((await impl({}, {})) as { candidates: Candidate[] }).candidates : [];
}
function boardOf(cands: Candidate[]) {
  return {
    columns: STAGE_ORDER.map((stage) => {
      const inStage = cands.filter((c) => c.stage === stage);
      return { stage, total: inStage.length, candidates: inStage };
    }),
  };
}
const SUMMARY = {
  byStage: { APPLIED: 12, SCREENING: 5, INTERVIEW: 3, OFFER: 2 },
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
};

/** Open Maria's drawer from the board card and return a scoped query set. */
async function openMaria(user: ReturnType<typeof renderHome>) {
  await user.click(
    await screen.findByRole('button', { name: /open maria lopez's details/i }),
  );
  return within(await screen.findByRole('dialog'));
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(listCandidates).mockResolvedValue({ candidates: [MARIA] } as never);
  vi.mocked(listInterviews).mockResolvedValue({ interviews: [] } as never);
  vi.mocked(listOffers).mockResolvedValue({ offers: [] } as never);
  vi.mocked(advanceCandidate).mockClear();
  vi.mocked(listCandidateEvents).mockResolvedValue({ events: [] } as never);
  vi.mocked(listSubmittals).mockResolvedValue({ submittals: [] } as never);
  vi.mocked(getCandidateBoard).mockImplementation(async () => boardOf(await pipeline()) as never);
  vi.mocked(getCandidate).mockImplementation(async (id: string) => (await pipeline()).find((c) => c.id === id) as never);
  vi.mocked(getRecruitingSummary).mockResolvedValue(SUMMARY as never);
});

describe('<RecruitingHome> candidate detail', () => {
  // Board cards used to be drag-only: there was no way to read a candidate's
  // phone, notes, interviews or offers anywhere in the product.
  it('opens the full record from a board card', async () => {
    const user = renderHome();
    const drawer = await openMaria(user);

    expect(drawer.getByText('maria@example.com')).toBeInTheDocument();
    expect(drawer.getByText('555-0134')).toBeInTheDocument();
    expect(
      drawer.getByText(/strong prep experience/i),
    ).toBeInTheDocument();
    expect(drawer.getByText('Referral')).toBeInTheDocument();
  });

  it('loads interviews and offers scoped to that candidate', async () => {
    vi.mocked(listInterviews).mockResolvedValue({
      interviews: [
        {
          id: 'int-1',
          candidateId: 'cand-1',
          candidateName: 'Maria Lopez',
          kitId: null,
          kitName: 'Kitchen screen',
          interviewerUserId: null,
          interviewerEmail: 'chef@example.com',
          scheduledFor: '2026-07-10T15:00:00.000Z',
          completedAt: '2026-07-10T16:00:00.000Z',
          rating: 1,
          scorecard: null,
        },
      ],
    } as never);
    vi.mocked(listOffers).mockResolvedValue({
      offers: [
        {
          id: 'off-1',
          candidateId: 'cand-1',
          candidateName: 'Maria Lopez',
          clientId: 'c1',
          clientName: 'Northside Grill',
          jobTitle: 'Line Cook',
          startDate: '2026-08-01',
          salary: null,
          hourlyRate: '21.50',
          currency: 'USD',
          letterBody: null,
          status: 'SENT',
          sentAt: null,
          decidedAt: null,
          expiresAt: null,
          createdAt: '2026-07-15T12:00:00.000Z',
        },
      ],
    } as never);

    const user = renderHome();
    const drawer = await openMaria(user);

    // Scoped by candidate — the endpoints support the filter, so the drawer
    // must not pull the whole 200-row list to show one person's history.
    await waitFor(() => expect(listInterviews).toHaveBeenCalledWith('cand-1'));
    expect(listOffers).toHaveBeenCalledWith('cand-1');

    expect(await drawer.findByText(/kitchen screen/i)).toBeInTheDocument();
    // The recommendation, in words. It is stored -2..2 and used to print as
    // "x/5" — a strong no read "-2/5".
    expect(drawer.getByText('Yes')).toBeInTheDocument();
    expect(drawer.getByText(/northside grill/i)).toBeInTheDocument();
    // The status in words, not the enum.
    expect(drawer.getByText('Sent')).toBeInTheDocument();
  });

  it('advances the candidate to the next stage from the drawer', async () => {
    const user = renderHome();
    const drawer = await openMaria(user);

    // APPLIED → SCREENING. Scoped to the drawer because the stage filter
    // chips and board columns carry the same labels.
    await user.click(drawer.getByRole('button', { name: /screening/i }));

    await waitFor(() =>
      expect(advanceCandidate).toHaveBeenCalledWith('cand-1', {
        stage: 'SCREENING',
      }),
    );
  });

  // The hire handoff's landing spot — a HIRED candidate's drawer must link
  // out to the associate record the hire created, not dead-end.
  it('links a HIRED candidate to their associate profile', async () => {
    vi.mocked(listCandidates).mockResolvedValue({
      candidates: [
        {
          ...MARIA,
          stage: 'HIRED',
          hiredAssociateId: 'assoc-9',
          hiredAt: '2026-07-20T12:00:00.000Z',
        },
      ],
    } as never);

    const user = renderHome();
    const drawer = await openMaria(user);

    const link = drawer.getByRole('link', { name: /maria lopez/i });
    // AssociateLink appends a return leg (the current path) by default so
    // the profile drawer can offer a "Back to …" chip.
    expect(link.getAttribute('href')).toMatch(
      /^\/people\?associateId=assoc-9&return=/,
    );
  });

  it('still opens terminal candidates, which cannot be dragged', async () => {
    vi.mocked(listCandidates).mockResolvedValue({
      candidates: [
        {
          ...MARIA,
          stage: 'REJECTED',
          rejectedReason: 'Withdrew before the screen.',
        },
      ],
    } as never);

    const user = renderHome();
    const drawer = await openMaria(user);

    expect(drawer.getByText(/withdrew before the screen/i)).toBeInTheDocument();
  });
});

describe('<RecruitingHome> working a candidate', () => {
  // Editing, notes, scheduling and scoring all existed in the API with no
  // screen; the drawer is now where that work happens.
  it('says how long they have been in this stage, not since they applied', async () => {
    const user = renderHome();
    const drawer = await openMaria(user);
    expect(drawer.getByText(/in Applied for 3 days/)).toBeInTheDocument();
  });

  it('edits the record', async () => {
    vi.mocked(updateCandidate).mockClear();
    const user = renderHome();
    const drawer = await openMaria(user);
    await user.click(drawer.getByRole('button', { name: 'Edit' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Edit candidate' }));
    const phone = dialog.getByLabelText('Phone');
    await user.clear(phone);
    await user.type(phone, '555-0199');
    // The opening they'd fill: open postings only, with how far along each is.
    const posting = dialog.getByLabelText(/^Job posting/);
    await waitFor(() =>
      expect(within(posting).getByRole('option', { name: 'Line Cook · Northside Grill · 1 of 3 filled' })).toBeInTheDocument(),
    );
    expect(within(posting).queryByRole('option', { name: /Dishwasher/ })).not.toBeInTheDocument();
    await user.selectOptions(posting, 'post-1');
    await user.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(updateCandidate).toHaveBeenCalledWith(
        'cand-1',
        expect.objectContaining({ phone: '555-0199', jobPostingId: 'post-1' }),
      ),
    );
  });

  it('keeps notes on a timeline, with who and when', async () => {
    vi.mocked(listCandidateEvents).mockResolvedValue({
      events: [
        {
          id: 'e2',
          kind: 'NOTE',
          fromStage: null,
          toStage: null,
          body: 'Prefers the morning shift.',
          actorName: 'Rosa Martinez',
          createdAt: new Date().toISOString(),
        },
        {
          id: 'e1',
          kind: 'STAGE_CHANGED',
          fromStage: 'APPLIED',
          toStage: 'SCREENING',
          body: null,
          actorName: 'Rosa Martinez',
          createdAt: new Date(Date.now() - 3_600_000).toISOString(),
        },
      ],
    } as never);
    vi.mocked(addCandidateNote).mockClear();
    const user = renderHome();
    const drawer = await openMaria(user);

    const timeline = within(await drawer.findByRole('list', { name: 'Timeline' }));
    expect(timeline.getByText('Prefers the morning shift.')).toBeInTheDocument();
    expect(timeline.getByText('Applied → Screening')).toBeInTheDocument();
    expect(timeline.getAllByText(/Rosa Martinez/)).toHaveLength(2);

    await user.type(drawer.getByLabelText('Add a note'), 'Called back — confirmed Monday.');
    await user.click(drawer.getByRole('button', { name: 'Add note' }));
    await waitFor(() =>
      expect(addCandidateNote).toHaveBeenCalledWith('cand-1', 'Called back — confirmed Monday.'),
    );
  });

  it('says who did what — and names no one it cannot', async () => {
    const at = '2026-09-26T15:00:00.000Z';
    vi.mocked(listCandidateEvents).mockResolvedValue({
      events: [
        { id: 'e3', kind: 'INTERVIEW_SCHEDULED', fromStage: null, toStage: null, body: at, actorName: 'Rosa Martinez', createdAt: new Date().toISOString() },
        { id: 'e2', kind: 'CREATED', fromStage: null, toStage: 'APPLIED', body: 'Applied on the careers page: Cashier', actorName: null, createdAt: new Date().toISOString() },
        // Backfilled from before the timeline existed: no actor on record.
        { id: 'e1', kind: 'CREATED', fromStage: null, toStage: 'APPLIED', body: null, actorName: null, createdAt: new Date().toISOString() },
      ],
    } as never);
    const user = renderHome();
    const drawer = await openMaria(user);
    const items = within(await drawer.findByRole('list', { name: 'Timeline' })).getAllByRole('listitem');
    // The instant, in the reader's own time — not the server's zone.
    expect(items[0]).toHaveTextContent(`Interview scheduled for ${fmtDateTime(at)}`);
    expect(items[1]).toHaveTextContent('Careers page');
    expect(items[2]).toHaveTextContent('Added to the pipeline');
    expect(items[2]).not.toHaveTextContent('Careers page');
  });

  it('schedules an interview, with me as the interviewer by default', async () => {
    vi.mocked(createInterview).mockClear();
    const user = renderHome();
    const drawer = await openMaria(user);
    await user.click(drawer.getByRole('button', { name: 'Schedule' }));
    const dialog = within(await screen.findByRole('dialog', { name: /schedule an interview/i }));
    await user.click(dialog.getByRole('button', { name: 'Schedule' }));
    await waitFor(() =>
      expect(createInterview).toHaveBeenCalledWith(
        expect.objectContaining({ candidateId: 'cand-1', interviewerUserId: 'me-1', kitId: null }),
      ),
    );
  });

  it('scores an interview that has happened, as a recommendation', async () => {
    vi.mocked(listInterviews).mockResolvedValue({
      interviews: [
        {
          id: 'int-2',
          candidateId: 'cand-1',
          candidateName: 'Maria Lopez',
          kitId: null,
          kitName: null,
          interviewerUserId: 'me-1',
          interviewerEmail: 'me@example.com',
          scheduledFor: new Date(Date.now() - 3_600_000).toISOString(),
          completedAt: null,
          rating: null,
          scorecard: null,
        },
      ],
    } as never);
    vi.mocked(scoreInterview).mockClear();
    const user = renderHome();
    const drawer = await openMaria(user);
    expect(await drawer.findByText(/needs a score/)).toBeInTheDocument();
    await user.click(drawer.getByRole('button', { name: 'Score' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Score the interview' }));
    // A recommendation is required.
    await user.click(dialog.getByRole('button', { name: 'Save scorecard' }));
    expect(scoreInterview).not.toHaveBeenCalled();
    await user.click(dialog.getByRole('radio', { name: 'Strong yes' }));
    await user.click(dialog.getByRole('button', { name: 'Save scorecard' }));
    await waitFor(() =>
      expect(scoreInterview).toHaveBeenCalledWith('int-2', expect.objectContaining({ rating: 2 })),
    );
  });

  // Hire used to create a bare associate and leave HR to re-type the person
  // into a separate onboarding invite. It opens that invite now, filled in.
  it('Hire opens the onboarding invite, filled in from the accepted offer', async () => {
    vi.mocked(listCandidates).mockResolvedValue({ candidates: [{ ...MARIA, stage: 'OFFER' }] } as never);
    vi.mocked(listOffers).mockResolvedValue({
      offers: [
        {
          id: 'off-1',
          candidateId: 'cand-1',
          candidateName: 'Maria Lopez',
          clientId: 'c1',
          clientName: 'Northside Grill',
          jobTitle: 'Line Cook',
          startDate: '2026-08-03',
          salary: null,
          hourlyRate: '16.50',
          currency: 'USD',
          letterBody: null,
          status: 'ACCEPTED',
          sentAt: '2026-07-20T12:00:00.000Z',
          decidedAt: '2026-07-21T12:00:00.000Z',
          expiresAt: null,
          createdAt: '2026-07-19T12:00:00.000Z',
        },
      ],
    } as never);
    vi.mocked(hireCandidate).mockResolvedValue({
      ...MARIA,
      stage: 'HIRED',
      applicationId: 'app-1',
      inviteUrl: null,
      payRecorded: true,
    } as never);
    const user = renderHome();
    const drawer = await openMaria(user);
    await user.click(drawer.getByRole('button', { name: /^hire$/i }));

    const dialog = within(await screen.findByRole('dialog', { name: 'Hire Maria Lopez' }));
    // Nothing about the person is typed again.
    expect(dialog.queryByLabelText(/first name/i)).not.toBeInTheDocument();
    expect(dialog.getByText('maria@example.com')).toBeInTheDocument();
    expect(dialog.getByText('$16.50/hr')).toBeInTheDocument();
    expect(dialog.getByLabelText('Position')).toHaveValue('Line Cook');
    expect(dialog.getByLabelText(/start date/i)).toHaveValue('2026-08-03');

    const template = await dialog.findByLabelText(/onboarding template/i);
    await waitFor(() => expect(template).not.toBeDisabled());
    await user.selectOptions(template, 't1');
    await user.click(dialog.getByRole('button', { name: /hire & send invite/i }));

    await waitFor(() =>
      expect(hireCandidate).toHaveBeenCalledWith(
        'cand-1',
        expect.objectContaining({
          clientId: 'c1',
          templateId: 't1',
          locationId: 'loc-1',
          position: 'Line Cook',
          offerId: 'off-1',
        }),
      ),
    );
  });

  it('reads the tiles from the server’s count of the whole pipeline', async () => {
    renderHome();
    // Label → header row → the tile. In funnel is every open stage.
    const tile = async (label: string) => (await screen.findByText(label)).parentElement!.parentElement!;
    await waitFor(async () => expect(await tile('Hired this month')).toHaveTextContent('4'));
    expect(await tile('In funnel')).toHaveTextContent('22');
    expect(await tile('Open offers')).toHaveTextContent('2');
  });
});

describe('<RecruitingHome> interviews in calendars, scorecards side by side', () => {
  const upcoming = (over: Record<string, unknown> = {}) => ({
    id: 'int-9',
    candidateId: 'cand-1',
    candidateName: 'Maria Lopez',
    kitId: null,
    kitName: null,
    interviewerUserId: 'me-1',
    interviewerEmail: 'me@example.com',
    scheduledFor: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    durationMinutes: 45,
    location: 'Destin #1234',
    completedAt: null,
    rating: null,
    scorecard: null,
    ...over,
  });

  it('schedules with a length and a place, and says who got the invite', async () => {
    vi.mocked(createInterview).mockClear();
    const user = renderHome();
    const drawer = await openMaria(user);
    await user.click(drawer.getByRole('button', { name: 'Schedule' }));
    const dialog = within(await screen.findByRole('dialog', { name: /schedule an interview/i }));
    await user.selectOptions(dialog.getByLabelText('Length'), '45');
    await user.type(dialog.getByLabelText('Where'), 'Destin #1234');
    expect(dialog.getByLabelText(/calendar invite/i)).toBeChecked();
    await user.click(dialog.getByRole('button', { name: 'Schedule' }));
    await waitFor(() =>
      expect(createInterview).toHaveBeenCalledWith(
        expect.objectContaining({ durationMinutes: 45, location: 'Destin #1234', notify: true }),
      ),
    );
  });

  it('an upcoming interview can be moved, keeping the invite in step', async () => {
    vi.mocked(listInterviews).mockResolvedValue({ interviews: [upcoming()] } as never);
    vi.mocked(updateInterview).mockClear();
    const user = renderHome();
    const drawer = await openMaria(user);
    expect(await drawer.findByText(/45 min · Destin #1234/)).toBeInTheDocument();
    await user.click(drawer.getByRole('button', { name: 'Reschedule' }));
    const dialog = within(await screen.findByRole('dialog', { name: /reschedule an interview/i }));
    // It opens on the interview as it stands.
    expect(dialog.getByLabelText('Where')).toHaveValue('Destin #1234');
    await user.click(dialog.getByRole('button', { name: 'Move it' }));
    await waitFor(() =>
      expect(updateInterview).toHaveBeenCalledWith('int-9', expect.objectContaining({ durationMinutes: 45, notify: true })),
    );
  });

  it('and called off, which withdraws the invites', async () => {
    vi.mocked(listInterviews).mockResolvedValue({ interviews: [upcoming()] } as never);
    vi.mocked(deleteInterview).mockClear();
    const user = renderHome();
    const drawer = await openMaria(user);
    await user.click(await drawer.findByRole('button', { name: 'Cancel' }));
    const confirm = within(await screen.findByRole('dialog', { name: /cancel this interview/i }));
    await user.click(confirm.getByRole('button', { name: 'Cancel interview' }));
    await waitFor(() => expect(deleteInterview).toHaveBeenCalledWith('int-9'));
  });

  it('rates each kit question on one scale', async () => {
    vi.mocked(listInterviews).mockResolvedValue({
      interviews: [upcoming({ id: 'int-p', kitId: 'kit-1', kitName: 'Cashier screen', scheduledFor: new Date(Date.now() - 3_600_000).toISOString() })],
    } as never);
    vi.mocked(listInterviewKits).mockResolvedValue({
      kits: [{ id: 'kit-1', clientId: null, name: 'Cashier screen', description: null, updatedAt: '', questions: [{ prompt: 'Upset customer?' }] }],
    } as never);
    vi.mocked(scoreInterview).mockClear();
    const user = renderHome();
    const drawer = await openMaria(user);
    await user.click(await drawer.findByRole('button', { name: 'Score' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Score the interview' }));
    await user.click(within(dialog.getByRole('radiogroup', { name: 'Upset customer?' })).getByRole('radio', { name: 'Strong' }));
    await user.type(dialog.getByLabelText('Notes: Upset customer?'), 'Calm, got a manager.');
    await user.click(within(dialog.getByRole('radiogroup', { name: 'Recommendation' })).getByRole('radio', { name: 'Yes' }));
    await user.click(dialog.getByRole('button', { name: 'Save scorecard' }));
    await waitFor(() =>
      expect(scoreInterview).toHaveBeenCalledWith('int-p', {
        rating: 1,
        scorecard: { answers: [{ prompt: 'Upset customer?', rating: 4, notes: 'Calm, got a manager.' }], summary: '' },
      }),
    );
  });

  it('reads every interviewer\'s scorecard together', async () => {
    const card = (r: number) => ({ answers: [{ prompt: 'Upset customer?', rating: r, notes: '' }], summary: '' });
    vi.mocked(listInterviews).mockResolvedValue({
      interviews: [
        upcoming({ id: 'a', completedAt: '2026-09-01T00:00:00.000Z', rating: 2, scorecard: card(4) }),
        upcoming({ id: 'b', completedAt: '2026-09-02T00:00:00.000Z', rating: -1, scorecard: card(3) }),
      ],
    } as never);
    const user = renderHome();
    const drawer = await openMaria(user);
    expect(await drawer.findByText('2 scorecards:')).toBeInTheDocument();
    expect(drawer.getByText('1 × Strong yes')).toBeInTheDocument();
    expect(drawer.getByText('1 × No')).toBeInTheDocument();
    const avg = within(drawer.getByRole('list', { name: 'Average rating by question' }));
    expect(avg.getByText('3.5 / 4 · Strong')).toBeInTheDocument();
  });
});

describe('<RecruitingHome> client review', () => {
  it('puts a candidate in front of a client, for one store, with a pitch', async () => {
    vi.mocked(submitToClient).mockClear();
    vi.mocked(listClientLocations).mockResolvedValueOnce({
      locations: [
        { id: 'loc-1', name: 'Store 12', state: 'FL' },
        { id: 'loc-2', name: 'Store 40', state: 'FL' },
      ],
    } as never);
    const user = renderHome();
    const drawer = await openMaria(user);
    expect(await drawer.findByText('Not put in front of a client yet.')).toBeInTheDocument();
    await user.click(drawer.getByRole('button', { name: 'Put forward' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Put Maria forward' }));
    // What the client will — and won't — see.
    expect(dialog.getByText(/not their email, phone or résumé/)).toBeInTheDocument();
    const client = dialog.getByLabelText(/^Client/);
    await waitFor(() => expect(within(client).getByRole('option', { name: 'Northside Grill' })).toBeInTheDocument());
    await user.selectOptions(client, 'c1');
    const store = dialog.getByLabelText(/^Store/);
    await waitFor(() => expect(store).toBeEnabled());
    await user.selectOptions(store, 'loc-2');
    await user.type(dialog.getByLabelText(/^Pitch/), 'Five years on the line.');
    await user.click(dialog.getByRole('button', { name: 'Send to client' }));
    await waitFor(() =>
      expect(submitToClient).toHaveBeenCalledWith('cand-1', {
        clientId: 'c1',
        locationId: 'loc-2',
        pitch: 'Five years on the line.',
      }),
    );
  });

  it('shows the client’s answer, in their words, and can withdraw one still waiting', async () => {
    vi.mocked(listSubmittals).mockResolvedValue({
      submittals: [
        {
          id: 'sub-1', clientId: 'c1', clientName: 'Northside Grill', locationName: 'Store 40', pitch: null,
          status: 'PENDING', feedback: null, submittedByEmail: 'me@example.com', decidedByEmail: null,
          decidedAt: null, createdAt: '2026-09-24T14:00:00.000Z',
        },
        {
          id: 'sub-0', clientId: 'c2', clientName: 'Harbor Inn', locationName: null, pitch: null,
          status: 'DECLINED', feedback: 'Needs weekend availability.', submittedByEmail: 'me@example.com',
          decidedByEmail: 'gm@harbor.com', decidedAt: '2026-09-20T14:00:00.000Z', createdAt: '2026-09-18T14:00:00.000Z',
        },
      ],
    } as never);
    vi.mocked(withdrawSubmittal).mockClear();
    const user = renderHome();
    const drawer = await openMaria(user);
    expect(await drawer.findByText('Northside Grill · Store 40')).toBeInTheDocument();
    expect(drawer.getByText('Waiting on client')).toBeInTheDocument();
    expect(drawer.getByText('Passed')).toBeInTheDocument();
    expect(drawer.getByText('Needs weekend availability.')).toBeInTheDocument();
    expect(drawer.getByText(/answered .* by gm@harbor\.com/)).toBeInTheDocument();
    await user.click(drawer.getByRole('button', { name: 'Withdraw from client' }));
    const confirm = within(await screen.findByRole('dialog', { name: 'Withdraw from Northside Grill?' }));
    await user.click(confirm.getByRole('button', { name: 'Withdraw' }));
    await waitFor(() => expect(withdrawSubmittal).toHaveBeenCalledWith('sub-1'));
  });
});

describe('<RecruitingHome> at enterprise scale', () => {
  const BEN = { ...MARIA, id: 'cand-2', firstName: 'Ben', lastName: 'Okafor', email: 'ben@example.com', stage: 'SCREENING' as const };

  it('the board is one Tab stop; arrows move between cards and M moves a candidate', async () => {
    vi.mocked(listCandidates).mockResolvedValue({ candidates: [MARIA, BEN] } as never);
    vi.mocked(advanceCandidate).mockClear();
    const user = renderHome();
    const maria = await screen.findByRole('button', { name: /open maria lopez's details/i });
    const ben = screen.getByRole('button', { name: /open ben okafor's details/i });
    expect(maria).toHaveAttribute('tabindex', '0');
    expect(ben).toHaveAttribute('tabindex', '-1');
    // Where it is, for a screen reader.
    expect(maria).toHaveAccessibleName(/Line Cook, Applied, 1 of 1/);

    maria.focus();
    await user.keyboard('{ArrowRight}');
    expect(ben).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(maria).toHaveFocus();

    await user.keyboard('m');
    const menu = await screen.findByRole('menu');
    await user.click(within(menu).getByRole('menuitem', { name: 'Interview' }));
    await waitFor(() => expect(advanceCandidate).toHaveBeenCalledWith('cand-1', { stage: 'INTERVIEW' }));
  });

  it('rejecting from the Move menu asks for the reason first', async () => {
    const user = renderHome();
    await user.click(await screen.findByRole('button', { name: 'Move Maria Lopez' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Reject…' }));
    expect(await screen.findByRole('dialog', { name: 'Reject Maria Lopez?' })).toBeInTheDocument();
  });

  it('a column shows its count and loads more from the server', async () => {
    vi.mocked(getCandidateBoard).mockResolvedValue({
      columns: STAGE_ORDER.map((stage) =>
        stage === 'APPLIED' ? { stage, total: 30, candidates: [MARIA] } : { stage, total: 0, candidates: [] },
      ),
    } as never);
    vi.mocked(listCandidates).mockClear();
    const user = renderHome();
    expect(await screen.findByRole('region', { name: 'Applied, 30 candidates' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show more (29 left)' }));
    await waitFor(() =>
      expect(listCandidates).toHaveBeenCalledWith(expect.objectContaining({ stage: 'APPLIED' }), { offset: 1, limit: 25 }),
    );
  });

  it('an outcome shows its latest few and sends the rest to the list', async () => {
    vi.mocked(getCandidateBoard).mockResolvedValue({
      columns: STAGE_ORDER.map((stage) =>
        stage === 'HIRED'
          ? { stage, total: 10, candidates: [{ ...MARIA, stage: 'HIRED', hiredAt: '2026-09-01T12:00:00.000Z' }] }
          : { stage, total: 0, candidates: [] },
      ),
    } as never);
    vi.mocked(listCandidates).mockClear();
    const user = renderHome();
    await user.click(await screen.findByRole('button', { name: 'See all 10 in the list' }));
    await waitFor(() =>
      expect(listCandidates).toHaveBeenCalledWith(expect.objectContaining({ stage: 'HIRED' }), { limit: 50, offset: 0 }),
    );
  });

  it('search and filters are applied on the server', async () => {
    vi.mocked(getCandidateBoard).mockClear();
    const user = renderHome();
    await screen.findByRole('button', { name: /open maria lopez's details/i });
    await user.selectOptions(screen.getByLabelText('Source'), 'indeed');
    await user.click(screen.getByRole('button', { name: 'Stuck 7+ days' }));
    await user.type(screen.getByLabelText('Search candidates'), 'kim cashier');
    await waitFor(() =>
      expect(getCandidateBoard).toHaveBeenLastCalledWith(
        expect.objectContaining({ q: 'kim cashier', source: 'indeed', stuck: '1', sort: 'newest' }),
        25,
      ),
    );
  });

  it('the list pages on the server', async () => {
    vi.mocked(listCandidates).mockResolvedValue({ candidates: [MARIA], total: 120, offset: 0, limit: 50 } as never);
    const user = renderHome('/recruiting?view=list&stage=ALL');
    expect(await screen.findByText('1–50 of 120')).toBeInTheDocument();
    vi.mocked(listCandidates).mockClear();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(listCandidates).toHaveBeenCalledWith(expect.objectContaining({ sort: 'newest' }), { limit: 50, offset: 50 }));
  });

  it('saves the filters on screen as a view, and applies a saved one', async () => {
    vi.mocked(listSavedViews).mockResolvedValue({
      views: [
        { id: 'sv-1', scope: 'recruiting.candidates', name: 'Stuck in screening', query: { view: 'list', stage: 'SCREENING', stuck: '1' }, shared: true, mine: false, ownerName: 'Dana Reyes', updatedAt: '' },
      ],
    } as never);
    const user = renderHome('/recruiting?source=indeed');
    await screen.findByRole('button', { name: /open maria lopez's details/i });

    await user.click(screen.getByRole('button', { name: /Saved views: All candidates/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Save these filters as a view…' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Save these filters as a view' }));
    await user.type(dialog.getByLabelText(/^Name/), 'Indeed applicants');
    await user.click(dialog.getByRole('button', { name: 'Save view' }));
    await waitFor(() =>
      expect(createSavedView).toHaveBeenCalledWith({
        scope: 'recruiting.candidates',
        name: 'Indeed applicants',
        query: { view: 'board', source: 'indeed' },
        shared: false,
      }),
    );

    vi.mocked(listCandidates).mockClear();
    await user.click(screen.getByRole('button', { name: /Saved views:/ }));
    await user.click(await screen.findByRole('menuitem', { name: /Stuck in screening/ }));
    await waitFor(() =>
      expect(listCandidates).toHaveBeenCalledWith(expect.objectContaining({ stage: 'SCREENING', stuck: '1' }), { limit: 50, offset: 0 }),
    );
    // The source filter the view didn't have is gone.
    expect(vi.mocked(listCandidates).mock.calls.at(-1)![0]).not.toHaveProperty('source');
  });

  it('a link to someone not on the current page still opens them', async () => {
    const ZED = { ...MARIA, id: 'cand-9', firstName: 'Zed', lastName: 'Adams', email: 'zed@example.com' };
    vi.mocked(getCandidate).mockResolvedValue(ZED as never);
    renderHome('/recruiting?candidateId=cand-9');
    const drawer = within(await screen.findByRole('dialog'));
    expect(await drawer.findByText('zed@example.com')).toBeInTheDocument();
    expect(getCandidate).toHaveBeenCalledWith('cand-9');
  });
});
