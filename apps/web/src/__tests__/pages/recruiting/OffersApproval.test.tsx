import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/recruiting90Api', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/recruiting90Api')>();
  return {
    ...real,
    listOffers: vi.fn(),
    approveOffer: vi.fn(async () => ({ ok: true })),
    declineOfferApproval: vi.fn(async () => ({ ok: true })),
    listOfferLetterTemplates: vi.fn(async () => ({ templates: [] })),
    listInterviewKits: vi.fn(async () => ({ kits: [] })),
    listReferrals: vi.fn(async () => ({ referrals: [] })),
    listJobPostings: vi.fn(async () => ({ postings: [] })),
  };
});
vi.mock('@/lib/clientsApi', () => ({ listClients: vi.fn(async () => ({ clients: [] })) }));

import { ROLE_CAPABILITIES } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { ConfirmProvider } from '@/lib/confirm';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { approveOffer, listOffers } from '@/lib/recruiting90Api';
import { RecruitingExtras } from '@/pages/recruiting/RecruitingExtras';

/**
 * An offer whose pay is outside the client's band waits for someone other
 * than whoever drafted it — the approver sees Approve; the drafter can't.
 */

const HELD = {
  id: 'off-1',
  candidateId: 'cand-1',
  candidateName: 'Kim Phan',
  clientId: 'c1',
  clientName: 'Walmart',
  jobTitle: 'Cashier',
  startDate: '2026-10-05',
  salary: null,
  hourlyRate: '19.00',
  currency: 'USD',
  letterBody: null,
  status: 'PENDING_APPROVAL' as const,
  sentAt: null,
  decidedAt: null,
  expiresAt: null,
  createdAt: '2026-09-26T12:00:00.000Z',
  createdById: 'rec-1',
  approvalNote: '$19.00/hr is above the Cashier band ($14.00–$17.00/hr).',
  approvedByEmail: null,
  approvedAt: null,
  approvalDeclinedReason: null,
  signedName: null,
  signedAt: null,
  hasSignedPdf: false,
  declineReason: null,
};

/** Signed in as `userId`, an HR admin — who may approve pay. */
function renderOffers(userId: string) {
  const role = 'HR_ADMINISTRATOR' as const;
  const auth = {
    isInitializing: false,
    isOffline: false,
    user: { id: userId, email: 'x@altohr.com', role, status: 'ACTIVE', clientId: null, associateId: null },
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
          <MemoryRouter initialEntries={['/recruiting/extras?tab=offers']}>
            <RecruitingExtras />
          </MemoryRouter>
        </ConfirmProvider>
      </TooltipProvider>
    </QueryClientProvider>
    </AuthContext.Provider>,
  );
  return userEvent.setup();
}

beforeEach(() => {
  vi.mocked(approveOffer).mockClear();
});

describe('offers held for approval', () => {
  it('shows why, and lets someone else approve it', async () => {
    vi.mocked(listOffers).mockResolvedValue({ offers: [HELD] });
    const user = renderOffers('hr-1');
    expect(await screen.findByText(HELD.approvalNote)).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Approve' })[0]!);
    await waitFor(() => expect(approveOffer).toHaveBeenCalledWith('off-1'));
  });

  it('the one who drafted it waits — no Approve for their own offer', async () => {
    vi.mocked(listOffers).mockResolvedValue({ offers: [HELD] });
    renderOffers('rec-1');
    expect((await screen.findAllByText('Waiting on approval')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('a signed offer says who signed, with the letter to open', async () => {
    vi.mocked(listOffers).mockResolvedValue({
      offers: [{ ...HELD, status: 'ACCEPTED', approvalNote: null, signedName: 'Kim Phan', signedAt: '2026-09-27T12:00:00.000Z', hasSignedPdf: true }],
    });
    renderOffers('hr-1');
    expect((await screen.findAllByText(/Signed by Kim Phan/)).length).toBeGreaterThan(0);
    const link = screen.getAllByRole('link', { name: 'Signed letter' })[0]!;
    expect(link).toHaveAttribute('href', '/api/offers/off-1/signed.pdf');
    expect(within(link).queryByRole('img')).toBeNull();
  });
});
