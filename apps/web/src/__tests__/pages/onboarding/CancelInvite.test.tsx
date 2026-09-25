import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ApplicationStatsResponse, ApplicationSummary } from '@alto-people/shared';

vi.mock('@/lib/auth', async () => {
  const React = await import('react');
  const auth = { user: { id: 'u1', role: 'HR_ADMINISTRATOR', email: 'hr@altohr.com' }, can: () => true };
  return { AuthContext: React.createContext(auth), useAuth: () => auth };
});
vi.mock('@/lib/confirm', () => ({ useConfirm: () => vi.fn(), usePrompt: () => vi.fn() }));
vi.mock('@/lib/onboardingApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/onboardingApi')>()),
  listApplications: vi.fn(),
  getApplicationStats: vi.fn(),
  cancelApplication: vi.fn(),
  reopenApplication: vi.fn(),
}));
vi.mock('@/lib/clientsApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/clientsApi')>()),
  listClients: vi.fn(async () => ({ clients: [], total: 0, nextCursor: null })),
}));
vi.mock('@/pages/onboarding/ApplicationDetail', () => ({ ApplicationDetailBody: () => null }));
vi.mock('@/pages/onboarding/BulkApproveDialog', () => ({ BulkApproveDialog: () => null }));
vi.mock('@/pages/onboarding/BulkInviteDialog', () => ({ BulkInviteDialog: () => null }));
vi.mock('@/pages/onboarding/CsvImportDialog', () => ({ CsvImportDialog: () => null }));
vi.mock('@/pages/onboarding/NudgeDialog', () => ({ NudgeDialog: () => null }));
// The invite dialog has its own tests; here it only has to say who it was
// opened for.
vi.mock('@/pages/onboarding/NewApplicationDialog', () => ({
  NewApplicationDialog: ({ open, prefill }: { open: boolean; prefill?: { email: string } | null }) =>
    open ? <div role="dialog" aria-label="New invite">{prefill ? `Prefilled: ${prefill.email}` : 'Blank invite'}</div> : null,
}));

import { ApiError } from '@/lib/api';
import { cancelApplication, getApplicationStats, listApplications, reopenApplication } from '@/lib/onboardingApi';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { ApplicationsList } from '@/pages/onboarding/ApplicationsList';
import { CancelInviteDialog } from '@/pages/onboarding/CancelInviteDialog';

const DANA = '00000000-0000-4000-8000-000000000001';
const CARL = '00000000-0000-4000-8000-000000000003';

function summary(id: string, associateName: string, status: ApplicationSummary['status']): ApplicationSummary {
  return {
    id,
    associateName,
    clientName: 'Acme Resort',
    onboardingTrack: 'STANDARD',
    status,
    position: 'Server',
    startDate: null,
    invitedAt: '2026-09-01T12:00:00.000Z',
    submittedAt: null,
    percentComplete: 20,
  };
}

const stats: ApplicationStatsResponse = {
  total: 2,
  byStatus: { DRAFT: 1, CANCELLED: 1 },
  inFlight: 1,
  stale: 0,
  bounced: 0,
  avgPercent: 20,
  staleSamples: [],
  bouncedSamples: [],
};

function renderList() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
  render(
    <MemoryRouter initialEntries={['/onboarding?status=ALL']}>
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <ApplicationsList />
        </TooltipProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return userEvent.setup();
}

beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(cancelApplication).mockReset();
  vi.mocked(reopenApplication).mockReset();
  vi.mocked(getApplicationStats).mockResolvedValue(stats);
  vi.mocked(listApplications).mockResolvedValue({
    applications: [summary(DANA, 'Dana Draft', 'DRAFT'), summary(CARL, 'Carl Cancelled', 'CANCELLED')],
    total: 2,
    page: 1,
    pageSize: 50,
  });
});

/**
 * An invite sent by mistake used to have only Reject — which emails the
 * person a decline and leaves their link working. Cancel is quiet, kills
 * the link, and offers the corrected invite straight away.
 */
describe('Cancel an onboarding invite', () => {
  it('cancels from the list and opens the corrected invite, filled in', async () => {
    vi.mocked(cancelApplication).mockResolvedValue({
      mode: 'removed',
      associate: { firstName: 'Dana', lastName: 'Draft', email: 'dana@example.com' },
      clientId: 'c1',
    });
    const user = renderList();

    await user.click(await screen.findByRole('button', { name: 'Cancel the invite to Dana Draft' }));
    const dialog = await screen.findByRole('dialog', { name: /cancel the invite to dana draft/i });
    // Not a rejection: the dialog says no decline goes out.
    expect(within(dialog).getByText(/won.t get a .declined. email/i)).toBeInTheDocument();
    // "Sent by mistake" is the default, with the corrected invite offered.
    expect(within(dialog).getByRole('radio', { name: 'Sent by mistake' })).toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: /send a corrected invite next/i })).toBeChecked();

    await user.click(within(dialog).getByRole('button', { name: 'Cancel invite' }));

    await waitFor(() => expect(cancelApplication).toHaveBeenCalledWith(DANA, { reason: 'SENT_IN_ERROR' }));
    expect(await screen.findByRole('dialog', { name: 'New invite' })).toHaveTextContent('Prefilled: dana@example.com');
  });

  it('a cancelled invite has no resend or cancel — only Reopen', async () => {
    vi.mocked(reopenApplication).mockResolvedValue({ emailed: true, inviteUrl: null });
    const user = renderList();

    await screen.findByText('Carl Cancelled');
    expect(screen.queryByRole('button', { name: 'Cancel the invite to Carl Cancelled' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reopen the invite to Carl Cancelled' }));

    await waitFor(() => expect(reopenApplication).toHaveBeenCalledWith(CARL));
  });
});

describe('<CancelInviteDialog>', () => {
  function renderDialog(onCancelled = vi.fn()) {
    render(
      <MemoryRouter>
        <CancelInviteDialog target={{ id: DANA, name: 'Dana Draft' }} onOpenChange={vi.fn()} onCancelled={onCancelled} />
      </MemoryRouter>,
    );
    return { user: userEvent.setup(), onCancelled };
  }

  it('"Other" needs a word on what happened', async () => {
    const { user } = renderDialog();
    await user.click(screen.getByRole('radio', { name: 'Other' }));
    await user.click(screen.getByRole('button', { name: 'Cancel invite' }));

    expect(await screen.findByText('Say what happened.')).toBeInTheDocument();
    expect(cancelApplication).not.toHaveBeenCalled();
  });

  it('the wrong person leads to inviting the right one, blank', async () => {
    vi.mocked(cancelApplication).mockResolvedValue({
      mode: 'cancelled',
      associate: { firstName: 'Dana', lastName: 'Draft', email: 'dana@example.com' },
      clientId: 'c1',
    });
    const { user, onCancelled } = renderDialog();
    await user.click(screen.getByRole('radio', { name: 'Wrong person' }));
    await user.type(screen.getByRole('textbox'), 'Meant her sister');
    await user.click(screen.getByRole('button', { name: 'Cancel invite' }));

    await waitFor(() =>
      expect(cancelApplication).toHaveBeenCalledWith(DANA, { reason: 'WRONG_PERSON', note: 'Meant her sister' }),
    );
    expect(onCancelled).toHaveBeenCalledWith(expect.objectContaining({ mode: 'cancelled' }), 'someone_else');
  });

  it('a hire made in Recruiting points there instead', async () => {
    vi.mocked(cancelApplication).mockRejectedValue(
      new ApiError(409, 'hired_in_recruiting', 'Dana was hired in Recruiting — undo the hire there.', { candidateId: 'cand-7' }),
    );
    const { user, onCancelled } = renderDialog();
    await user.click(screen.getByRole('radio', { name: 'Not joining after all' }));
    await user.click(screen.getByRole('button', { name: 'Cancel invite' }));

    expect(await screen.findByText(/undo the hire there/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open in Recruiting' })).toHaveAttribute('href', '/recruiting?candidateId=cand-7');
    expect(onCancelled).not.toHaveBeenCalled();
  });
});
