import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/lib/recruitingApi', () => ({
  listCandidates: vi.fn(),
  createCandidate: vi.fn(),
  advanceCandidate: vi.fn(async () => ({})),
  hireCandidate: vi.fn(async () => ({})),
}));

vi.mock('@/lib/recruiting90Api', () => ({
  listInterviews: vi.fn(async () => ({ interviews: [] })),
  listOffers: vi.fn(async () => ({ offers: [] })),
}));

vi.mock('@/lib/positionsApi', () => ({
  listPositions: vi.fn(async () => ({ positions: [] })),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ can: () => true }),
}));

import { advanceCandidate, listCandidates } from '@/lib/recruitingApi';
import { listInterviews, listOffers } from '@/lib/recruiting90Api';
import { RecruitingHome } from '@/pages/recruiting/RecruitingHome';
import { TooltipProvider } from '@/components/ui/Tooltip';

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
          completedAt: null,
          rating: 4,
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
    expect(drawer.getByText('4/5')).toBeInTheDocument();
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
