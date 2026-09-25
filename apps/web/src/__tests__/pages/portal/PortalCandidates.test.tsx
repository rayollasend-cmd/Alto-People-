import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { ConfirmProvider } from '@/lib/confirm';
import { TooltipProvider } from '@/components/ui/Tooltip';

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));

import { apiFetch } from '@/lib/api';
import { PortalCandidates } from '@/pages/portal/PortalCandidates';

/**
 * The client's side of client review: who Alto is putting forward, why,
 * how Alto's interviews went — and an answer that goes back to the
 * recruiter.
 */

const WAITING = {
  id: 'sub-1',
  name: 'Kim Phan',
  position: 'Cashier',
  storeName: 'Walmart Destin',
  pitch: 'Two years at Target, can open.',
  status: 'PENDING' as const,
  feedback: null,
  interviewRatings: [2, 2, 1],
  submittedBy: 'Dana',
  submittedAt: '2026-09-24T14:00:00.000Z',
  decidedBy: null,
  decidedAt: null,
};
const ANSWERED = {
  ...WAITING,
  id: 'sub-2',
  name: 'Lee Ray',
  storeName: null,
  pitch: null,
  interviewRatings: [],
  status: 'DECLINED' as const,
  feedback: 'Needs weekend availability.',
  decidedBy: 'Maria',
  decidedAt: '2026-09-23T14:00:00.000Z',
};

function renderPage(canDecide = true) {
  vi.mocked(apiFetch).mockImplementation(async (path: string) => {
    if (path === '/client-portal/candidates') return { canDecide, candidates: [WAITING, ANSWERED] };
    if (path.startsWith('/client-portal/candidates/')) return { ok: true };
    throw new Error(`unexpected ${path}`);
  });
  const role = 'CLIENT_PORTAL' as const;
  const caps = ROLE_CAPABILITIES[role];
  const auth = {
    isInitializing: false,
    isOffline: false,
    user: { id: 'u', email: 'sm@walmart.com', role, status: 'ACTIVE' as const, clientId: 'c1', clientName: 'Walmart', associateId: null },
    role,
    capabilities: new Set<Capability>(caps),
    signIn: vi.fn(),
    signOut: vi.fn(),
    can: (c: Capability) => caps.has(c),
  };
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider value={auth}>
        <TooltipProvider>
          <ConfirmProvider>
            <MemoryRouter initialEntries={['/portal/candidates']}>
              <PortalCandidates />
            </MemoryRouter>
          </ConfirmProvider>
        </TooltipProvider>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
});

describe('<PortalCandidates>', () => {
  it('shows who is waiting, for which store, why, and how Alto’s interviews went', async () => {
    renderPage();
    expect(await screen.findByText('Kim Phan')).toBeInTheDocument();
    expect(screen.getByText('Cashier · For Walmart Destin')).toBeInTheDocument();
    expect(screen.getByText('Two years at Target, can open.')).toBeInTheDocument();
    expect(screen.getByText('2 × Strong yes')).toBeInTheDocument();
    expect(screen.getByText('Yes')).toBeInTheDocument();
    // The answered one, with the reason given.
    expect(screen.getByText('Lee Ray')).toBeInTheDocument();
    expect(screen.getByText('Needs weekend availability.')).toBeInTheDocument();
    expect(screen.getByText('Not interviewed by Alto yet')).toBeInTheDocument();
  });

  it('passing needs a reason, and sends it', async () => {
    const user = renderPage();
    await screen.findByText('Kim Phan');
    await user.click(screen.getByRole('button', { name: 'Pass' }));
    const dialog = await screen.findByRole('dialog', { name: 'Pass on Kim Phan?' });
    const send = within(dialog).getByRole('button', { name: 'Pass' });
    expect(send).toBeDisabled();
    await user.type(within(dialog).getByRole('textbox', { name: /Why not\?/ }), 'Can’t work nights.');
    await user.click(send);
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/client-portal/candidates/sub-1/decision', {
        method: 'POST',
        body: { decision: 'DECLINED', feedback: 'Can’t work nights.' },
      }),
    );
  });

  it('approving can go without a note', async () => {
    const user = renderPage();
    await screen.findByText('Kim Phan');
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    const dialog = await screen.findByRole('dialog', { name: 'Approve Kim Phan?' });
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/client-portal/candidates/sub-1/decision', {
        method: 'POST',
        body: { decision: 'APPROVED' },
      }),
    );
  });

  it('with no say (a preview), there are no answer buttons', async () => {
    renderPage(false);
    await screen.findByText('Kim Phan');
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });
});
