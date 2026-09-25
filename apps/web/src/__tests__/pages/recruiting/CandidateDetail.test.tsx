import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { fmtDateTime } from '@/lib/format';

vi.mock('@/lib/recruitingApi', () => ({
  listCandidates: vi.fn(),
  createCandidate: vi.fn(),
  advanceCandidate: vi.fn(async () => ({})),
  hireCandidate: vi.fn(async () => ({})),
  updateCandidate: vi.fn(async () => ({})),
  listCandidateEvents: vi.fn(async () => ({ events: [] })),
  addCandidateNote: vi.fn(async () => ({ ok: true })),
}));

vi.mock('@/lib/recruiting90Api', () => ({
  listInterviews: vi.fn(async () => ({ interviews: [] })),
  listOffers: vi.fn(async () => ({ offers: [] })),
  listInterviewKits: vi.fn(async () => ({ kits: [] })),
  createInterview: vi.fn(async () => ({ id: 'int-new' })),
  scoreInterview: vi.fn(async () => ({ ok: true })),
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
  listClientLocations: vi.fn(async () => ({ locations: [{ id: 'loc-1', name: 'Store 12', state: 'FL' }] })),
}));
vi.mock('@/lib/orgApi', () => ({
  listShiftPositions: vi.fn(async () => ({ shiftPositions: [] })),
}));

vi.mock('@/lib/positionsApi', () => ({
  listPositions: vi.fn(async () => ({ positions: [] })),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ can: () => true, user: { id: 'me-1' } }),
}));

import {
  addCandidateNote,
  advanceCandidate,
  hireCandidate,
  listCandidateEvents,
  listCandidates,
  updateCandidate,
} from '@/lib/recruitingApi';
import { createInterview, listInterviews, listOffers, scoreInterview } from '@/lib/recruiting90Api';
import { RecruitingHome } from '@/pages/recruiting/RecruitingHome';
import { TooltipProvider } from '@/components/ui/Tooltip';

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

function renderHome() {
  // Layout supplies TooltipProvider in the real app; a standalone page render
  // has to stand it up itself or every Tooltip throws on mount.
  render(
    <TooltipProvider>
      <MemoryRouter>
        <RecruitingHome />
      </MemoryRouter>
    </TooltipProvider>,
  );
  return userEvent.setup();
}

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
    expect(drawer.getByText('SENT')).toBeInTheDocument();
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
    await user.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(updateCandidate).toHaveBeenCalledWith('cand-1', expect.objectContaining({ phone: '555-0199' })),
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

  it('counts a hire in the month they were hired, not the month they applied', async () => {
    vi.mocked(listCandidates).mockResolvedValue({
      candidates: [
        { ...MARIA, stage: 'HIRED', hiredAssociateId: 'a1', createdAt: '2026-01-05T12:00:00.000Z', hiredAt: new Date().toISOString() },
      ],
    } as never);
    renderHome();
    // Label → header row → the tile.
    const tile = (await screen.findByText('Hired this month')).parentElement!.parentElement!;
    await waitFor(() => expect(tile).toHaveTextContent('1'));
  });
});
